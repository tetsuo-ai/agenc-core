#define _GNU_SOURCE
/* Private session executor. Only the daemon owns the control pipe. Commands
 * receive three fresh pipes, never the control transport or another command. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define LIMIT (2U * 1024U * 1024U)
static void fail(void) { _exit(125); }
static void changed(int sig) { (void)sig; }
static void exact(int fd, void *buffer, size_t length, int writing) {
  char *p = buffer;
  while (length) {
    ssize_t n = writing ? write(fd, p, length) : read(fd, p, length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) fail();
    p += n; length -= (size_t)n;
  }
}
static void frame(char type, const void *data, uint32_t length) {
  unsigned char header[5]; header[0] = (unsigned char)type;
  uint32_t wire = htonl(length); memcpy(header + 1, &wire, 4);
  exact(1, header, 5, 1);
  if (length) exact(1, (void *)data, length, 1);
}
static char *receive(char *type, uint32_t *length) {
  unsigned char header[5]; exact(0, header, 5, 0); *type = (char)header[0];
  uint32_t wire; memcpy(&wire, header + 1, 4); *length = ntohl(wire);
  if (*length > LIMIT) fail();
  char *data = calloc((size_t)*length + 1, 1); if (!data) fail();
  exact(0, data, *length, 0); return data;
}
static char *string(char **cursor, char *end) {
  if (*cursor >= end) fail();
  char *p = *cursor, *nul = memchr(p, 0, (size_t)(end - p));
  if (!nul) fail();
  *cursor = nul + 1; return p;
}
/* Same-UID scheduler/resource APIs do not all use ptrace access checks.
 * Protect the namespace keeper without restricting descendant process IDs.
 * https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html
 * https://man7.org/linux/man-pages/man2/setpriority.2.html */
#define DENY_INIT_PID(call) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 4), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define DENY_INIT_OR_USER_SCOPE(call, user_scope) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 6), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, user_scope, 3, 0), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 1, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define KEEPER_RULES(affinity, scheduler, param, attr, migrate, move, priority, ioprio, limits) \
    DENY_INIT_PID(affinity), \
    DENY_INIT_PID(scheduler), \
    DENY_INIT_PID(param), \
    DENY_INIT_PID(attr), \
    DENY_INIT_PID(migrate), \
    DENY_INIT_PID(move), \
    DENY_INIT_OR_USER_SCOPE(priority, 2), \
    DENY_INIT_OR_USER_SCOPE(ioprio, 3), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, limits, 0, 7), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, 5), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])), \
    BPF_JUMP(BPF_JMP | BPF_JGT | BPF_K, 0, 2, 0), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]) + 4), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)

static void protect_keeper(void) {
#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#define COMPAT_ARCH AUDIT_ARCH_I386
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#define COMPAT_ARCH AUDIT_ARCH_ARM
#else
#error Unsupported session executor architecture
#endif
  const struct sock_filter native[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* x32 shares these native syscall numbers except move_pages (533). */
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~0x40000000U),
    DENY_INIT_PID(533),
#endif
    KEEPER_RULES(SYS_sched_setaffinity, SYS_sched_setscheduler,
      SYS_sched_setparam, SYS_sched_setattr, SYS_migrate_pages, SYS_move_pages,
      SYS_setpriority, SYS_ioprio_set, SYS_prlimit64),
  };
  /* Linux UAPI syscall tables: arch/x86/entry/syscalls/syscall_32.tbl and
   * arch/arm/tools/syscall.tbl. Preserve compatible binaries when the existing
   * network filter permits them; never let a second ABI bypass this guard. */
  const struct sock_filter compat[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    KEEPER_RULES(241, 156, 154, 351, 294, 317, 97, 289, 340),
#else
    KEEPER_RULES(241, 156, 154, 380, 400, 344, 97, 314, 369),
#endif
  };
  enum { NATIVE_COUNT = sizeof(native) / sizeof(native[0]),
         COMPAT_COUNT = sizeof(compat) / sizeof(compat[0]) };
  _Static_assert(NATIVE_COUNT + 1 < 256, "seccomp architecture branch overflow");
  struct sock_filter filter[4 + NATIVE_COUNT + COMPAT_COUNT] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, COMPAT_ARCH, NATIVE_COUNT + 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
  };
  memcpy(filter + 4, native, sizeof(native));
  memcpy(filter + 4 + NATIVE_COUNT, compat, sizeof(compat));
  struct sock_fprog program = {sizeof(filter) / sizeof(filter[0]), filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
static void command(char *data, uint32_t length) {
  if (length < 8) fail();
  uint32_t counts[2]; memcpy(counts, data, 8);
  uint32_t argc = ntohl(counts[0]), envc = ntohl(counts[1]);
  if (!argc || argc > 65536 || envc > 65536) fail();
  char **argv = calloc((size_t)argc + 1, sizeof(char *));
  char **env = calloc((size_t)envc + 1, sizeof(char *));
  if (!argv || !env) fail();
  char *cursor = data + 8, *end = data + length, *cwd = string(&cursor, end);
  for (uint32_t i = 0; i < argc; i++) argv[i] = string(&cursor, end);
  for (uint32_t i = 0; i < envc; i++) env[i] = string(&cursor, end);
  if (cursor != end || cwd[0] != '/' || argv[0][0] != '/') fail();
  int in[2], out[2], err[2];
  if (pipe2(in, O_CLOEXEC) || pipe2(out, O_CLOEXEC) || pipe2(err, O_CLOEXEC)) fail();
  pid_t child = fork(); if (child < 0) fail();
  if (!child) {
    if (setsid() < 0 || chdir(cwd) || dup2(in[0], 0) < 0 ||
        dup2(out[1], 1) < 0 || dup2(err[1], 2) < 0 ||
        syscall(SYS_close_range, 3U, ~0U, 0U)) fail();
    sigset_t empty; sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL)) fail();
    signal(SIGCHLD, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    protect_keeper();
    execve(argv[0], argv, env); _exit(127);
  }
  close(in[0]); close(in[1]); in[1] = -1; close(out[1]); close(err[1]);
  free(argv); free(env);
  struct pollfd fds[3] = {{0, POLLIN, 0}, {out[0], POLLIN, 0}, {err[0], POLLIN, 0}};
  int status = 0, done = 0, residual = 0;
  sigset_t empty; sigemptyset(&empty);
  while (!done || fds[1].fd >= 0 || fds[2].fd >= 0) {
    if (!done) {
      pid_t reaped = waitpid(child, &status, WNOHANG);
      if (reaped < 0 && errno != EINTR) fail();
      if (reaped == child) {
        done = 1;
        if (in[1] >= 0) { close(in[1]); in[1] = -1; }
        for (;;) {
          int s; pid_t p = waitpid(-1, &s, WNOHANG);
          if (p > 0) continue;
          if (p < 0) { if (errno == EINTR) continue; if (errno == ECHILD) break; fail(); }
          residual = 1;
          if (kill(-1, SIGKILL) && errno != ESRCH) fail();
          do { p = waitpid(-1, &s, 0); } while (p < 0 && errno == EINTR);
          if (p < 0 && errno != ECHILD) fail();
        }
      }
    }
    if (done && fds[1].fd < 0 && fds[2].fd < 0) break;
    int result = ppoll(fds, 3, NULL, &empty);
    if (result < 0) { if (errno == EINTR) continue; fail(); }
    if (fds[0].revents) {
      char type; uint32_t size; char *body = receive(&type, &size);
      if (type == 'E' && size == 0) { if (in[1] >= 0) close(in[1]); in[1] = -1; }
      else if ((type == 'K' || type == 'T') && size == 0) { if (!done && kill(-1, type == 'K' ? SIGKILL : SIGTERM) && errno != ESRCH) fail(); }
      else fail();
      free(body);
    }
    for (int i = 1; i <= 2; i++) if (fds[i].fd >= 0 && fds[i].revents) {
      char buffer[16384]; ssize_t n = read(fds[i].fd, buffer, sizeof(buffer));
      if (n < 0) { if (errno == EINTR) continue; fail(); }
      if (!n) { close(fds[i].fd); fds[i].fd = -1; }
      else frame(i == 1 ? 'O' : 'X', buffer, (uint32_t)n);
    }
  }
  unsigned char report[5]; uint32_t wire = htonl((uint32_t)status);
  memcpy(report, &wire, 4); report[4] = (unsigned char)residual;
  frame('D', report, sizeof(report));
}
static int trusted_execution_boundary(void) {
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct data[2] = {{0}};
  struct statvfs mount;
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
      syscall(SYS_capget, &header, data) ||
      statvfs("/proc/self/exe", &mount) || !(mount.f_flag & ST_RDONLY)) return 0;
  for (size_t i = 0; i < 2; i++)
    if (data[i].effective || data[i].permitted || data[i].inheritable) return 0;
  return 1;
}
int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "--session-executor-v1") || getpid() != 1 ||
      !trusted_execution_boundary() || syscall(SYS_close_range, 3U, ~0U, 0U) ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) ||
      prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)) return 125;
  signal(SIGPIPE, SIG_DFL);
  struct sigaction action = {0}; action.sa_handler = changed; sigemptyset(&action.sa_mask);
  sigset_t blocked; sigemptyset(&blocked); sigaddset(&blocked, SIGCHLD);
  if (sigaction(SIGCHLD, &action, NULL) || sigprocmask(SIG_BLOCK, &blocked, NULL)) fail();
  frame('P', NULL, 0);
  for (;;) {
    char type; uint32_t size; char *data = receive(&type, &size);
    if ((type == 'K' || type == 'T') && size == 0) { free(data); continue; }
    if (type != 'R') fail();
    command(data, size); free(data);
  }
}
