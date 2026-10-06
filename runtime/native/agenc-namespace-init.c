#define _GNU_SOURCE

/* Private, statically linked PID-namespace init. This file is not a shell or
 * a public launcher. AGB3 will supply a unique pipe and a sealed executable;
 * no command receives those descriptors. See DESIGN-RESIDUAL-INIT-V2.md. */
#include <dirent.h>
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

enum { REPORT_FD = 4, EXECUTABLE_FD = 5, FAILURE = 125 };
extern char **environ;

static bool read_at(int fd, void *data, size_t length, off_t offset) {
  size_t done = 0;
  while (done < length) {
    ssize_t count = pread(fd, (char *)data + done, length - done,
                          offset + (off_t)done);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    done += (size_t)count;
  }
  return true;
}

static bool static_executable(void) {
  Elf64_Ehdr header;
  struct stat executable;
  int seals = fcntl(EXECUTABLE_FD, F_GET_SEALS);
  const int required = F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE;
  if (seals < 0 || (seals & required) != required ||
      (fcntl(EXECUTABLE_FD, F_GETFL) & O_ACCMODE) != O_RDONLY ||
      fstat(EXECUTABLE_FD, &executable) != 0 || !S_ISREG(executable.st_mode) ||
      !read_at(EXECUTABLE_FD, &header, sizeof(header), 0) ||
      memcmp(header.e_ident, ELFMAG, SELFMAG) != 0 ||
      header.e_ident[EI_CLASS] != ELFCLASS64 ||
      header.e_phentsize != sizeof(Elf64_Phdr) || header.e_phnum == 0 ||
      header.e_phnum > 128 ||
      header.e_phoff > (uint64_t)executable.st_size ||
      (uint64_t)header.e_phnum * sizeof(Elf64_Phdr) >
          (uint64_t)executable.st_size - header.e_phoff) return false;
  for (unsigned int i = 0; i < header.e_phnum; ++i) {
    Elf64_Phdr program;
    if (!read_at(EXECUTABLE_FD, &program, sizeof(program),
                 (off_t)(header.e_phoff + i * sizeof(program))) ||
        program.p_type == PT_INTERP) return false;
  }
  /* bwrap --ro-bind-data copies the sealed image to a private, unlinked,
   * read-only bind. Some host LSM profiles reject direct memfd execution.
   * Compare that copy against the sealed source, never a task pathname. */
  int self_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  if (self_fd < 0) return false;
  struct stat self;
  struct statvfs mount;
  bool valid = fstat(self_fd, &self) == 0 && S_ISREG(self.st_mode) &&
      self.st_size == executable.st_size &&
      fstatvfs(self_fd, &mount) == 0 && (mount.f_flag & ST_RDONLY) != 0;
  unsigned char original[4096], copy[4096];
  for (off_t offset = 0; valid && offset < executable.st_size;) {
    off_t remaining = executable.st_size - offset;
    size_t length = remaining > (off_t)sizeof(original) ? sizeof(original)
                                                       : (size_t)remaining;
    valid = read_at(EXECUTABLE_FD, original, length, offset) &&
            read_at(self_fd, copy, length, offset) &&
            memcmp(original, copy, length) == 0;
    offset += (off_t)length;
  }
  if (close(self_fd) != 0) valid = false;
  return valid;
}

static bool private_descriptors(void) {
  struct stat report;
  int flags = fcntl(REPORT_FD, F_GETFL);
  if (flags < 0 || (flags & O_ACCMODE) != O_WRONLY ||
      fstat(REPORT_FD, &report) != 0 || !S_ISFIFO(report.st_mode) ||
      !static_executable()) return false;
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) return false;
  bool valid = true;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (entry->d_name[0] == '.') continue;
    char *end;
    long fd = strtol(entry->d_name, &end, 10);
    if (*end != '\0' || fd < 0 ||
        (fd > 2 && fd != REPORT_FD && fd != EXECUTABLE_FD &&
         fd != dirfd(directory))) { valid = false; break; }
    errno = 0;
  }
  if (errno != 0) valid = false;
  if (closedir(directory) != 0) valid = false;
  return valid;
}

static bool unprivileged(void) {
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct data[2] = {{0}};
  if (syscall(SYS_capget, &header, data) != 0 ||
      prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return false;
  for (size_t i = 0; i < 2; ++i) {
    if (data[i].effective || data[i].permitted || data[i].inheritable)
      return false;
  }
  for (int cap = 0; cap < 64; ++cap) {
    int present = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, cap, 0, 0);
    if (present == 0) continue;
    if (present < 0 && errno == EINVAL && cap > CAP_LAST_CAP) return true;
    return false;
  }
  return true;
}

static bool reset_signals(bool init) {
  const int signals[] = {SIGCHLD, SIGTERM, SIGINT, SIGHUP, SIGUSR2, SIGPIPE};
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i) {
    action.sa_handler = init && signals[i] == SIGPIPE ? SIG_IGN : SIG_DFL;
    if (sigaction(signals[i], &action, NULL) != 0) return false;
  }
  sigset_t empty;
  sigemptyset(&empty);
  return sigprocmask(SIG_SETMASK, &empty, NULL) == 0;
}

static void child_changed(int signal_number) { (void)signal_number; }

static bool watch_broker(void) {
  /* Exec can reset an inherited parent-death signal. Re-arm it, but do not
   * use getppid() as a liveness check: our parent is outside this namespace.
   * The report pipe's sole reader belongs to the broker and also closes the
   * race where that parent died before we could arm the signal. */
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) return false;
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = child_changed;
  sigemptyset(&action.sa_mask);
  sigset_t blocked;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGCHLD);
  return sigaction(SIGCHLD, &action, NULL) == 0 &&
         sigprocmask(SIG_BLOCK, &blocked, NULL) == 0;
}

static bool broker_alive(void) {
  struct pollfd report = {REPORT_FD, 0, 0};
  int result;
  do { result = poll(&report, 1, 0); } while (result < 0 && errno == EINTR);
  return result == 0 && report.revents == 0;
}

static pid_t wait_child(int *status, int options) {
  for (;;) {
    if (!broker_alive()) { errno = EPIPE; return -1; }
    pid_t child = waitpid(-1, status, options | WNOHANG);
    if (child < 0 && errno == EINTR) continue;
    if (child != 0 || (options & WNOHANG) != 0) return child;
    /* SIGCHLD is blocked around waitpid. Atomically unblock it while waiting
     * for either a child transition or loss of the broker's pipe reader.
     * No sleep, polling interval, or grace window decides residual status. */
    struct pollfd report = {REPORT_FD, 0, 0};
    sigset_t empty;
    sigemptyset(&empty);
    int result = ppoll(&report, 1, NULL, &empty);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || report.revents != 0) { errno = EPIPE; return -1; }
  }
}

static bool terminal_status(int status) {
  return WIFEXITED(status) || WIFSIGNALED(status);
}

static bool finish_children(bool *residual) {
  *residual = false;
  for (;;) {
    int status;
    pid_t child = wait_child(&status, WNOHANG);
    if (child > 0) {
      if (!terminal_status(status)) return false;
      continue;
    }
    if (child < 0) return errno == ECHILD;
    /* The command has been reaped. A zero return proves a live or stopped
     * descendant remains. A zombie alone cannot reach this branch. */
    *residual = true;
    if (kill(-1, SIGKILL) != 0 && errno != ESRCH) return false;
    child = wait_child(&status, 0);
    if (child < 0) return errno == ECHILD;
    if (!terminal_status(status)) return false;
    /* Re-drain, signal and reap: a descendant can fork while cleanup starts. */
  }
}

static bool report_result(int status, bool residual) {
  unsigned int value = WIFEXITED(status) ? (unsigned int)WEXITSTATUS(status)
                                       : (unsigned int)WTERMSIG(status);
  unsigned char frame[16] = {'A', 'G', 'I', '1', 1,
      WIFEXITED(status) ? 0 : 1, residual ? 1 : 0, 0,
      0, 0, 0, (unsigned char)value, 0, 0, 0, 0};
  /* One bounded atomic pipe write; the unique reader has not filled this
   * pipe. Never publish a partial report as a valid command outcome. */
  ssize_t count;
  do { count = write(REPORT_FD, frame, sizeof(frame)); }
  while (count < 0 && errno == EINTR);
  return count == (ssize_t)sizeof(frame) && close(REPORT_FD) == 0;
}

int main(int argc, char **argv) {
  if (argc < 3 || strcmp(argv[1], "--namespace-init-v1") != 0 ||
      argv[2][0] != '/' || getpid() != 1 || !private_descriptors() ||
      !unprivileged() || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 || !reset_signals(true) ||
      !watch_broker() || !broker_alive())
    return FAILURE;
  pid_t command = fork();
  if (command < 0) return FAILURE;
  if (command == 0) {
    if (close(REPORT_FD) != 0 || close(EXECUTABLE_FD) != 0 ||
        !reset_signals(false) || getppid() != 1 ||
        prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 || getppid() != 1)
      _exit(FAILURE);
    execve(argv[2], argv + 2, environ);
    const char message[] = "agenc namespace init: command exec failed\n";
    ssize_t ignored = write(STDERR_FILENO, message, sizeof(message) - 1);
    (void)ignored;
    _exit(127);
  }
  int command_status = 0;
  for (;;) {
    int status;
    pid_t child = wait_child(&status, 0);
    if (child < 0 || !terminal_status(status)) return FAILURE;
    if (child == command) { command_status = status; break; }
  }
  bool residual;
  if (!finish_children(&residual) || !report_result(command_status, residual))
    return FAILURE;
  return WIFEXITED(command_status) ? WEXITSTATUS(command_status)
                                 : 128 + WTERMSIG(command_status);
}
