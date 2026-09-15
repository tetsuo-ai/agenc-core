#define _GNU_SOURCE

/* Runs inside the already-contained task command scope. fd 3 is this immutable
 * executable, fd 4 is a sealed bootstrap memfd. Task stdin is never bootstrap
 * transport. No task code executes until the complete bounded frame is valid. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/sysmacros.h>
#include <sys/prctl.h>
#include <unistd.h>

enum { BOOTSTRAP_FD = 4, MAX_BYTES = 2 * 1024 * 1024, MAX_STRINGS = 65536 };
static unsigned char *bytes;
static size_t offset, length;
static int startup_fd = -1;
extern char **environ;

static bool startup_message(uint32_t kind, uint32_t value, int descriptor) {
  unsigned char payload[12] = {'A', 'D', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  for (int i = 0; i < 4; i++) { payload[7-i] = (unsigned char)(kind >> (8*i)); payload[11-i] = (unsigned char)(value >> (8*i)); }
  struct iovec iov = {payload, sizeof(payload)};
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  if (descriptor >= 0) {
    message.msg_control = control.bytes; message.msg_controllen = sizeof(control.bytes);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
  }
  ssize_t sent;
  do { sent = sendmsg(startup_fd, &message, MSG_NOSIGNAL); } while (sent < 0 && errno == EINTR);
  return sent == (ssize_t)sizeof(payload);
}

static void invalid(void) {
  if (startup_fd >= 0) (void)startup_message(2, (uint32_t)(errno ? errno : EINVAL), -1);
  fputs("agenc: invalid private task bootstrap\n", stderr);
  _exit(125);
}

static uint32_t integer(void) {
  if (length - offset < 4) invalid();
  unsigned char *p = bytes + offset;
  offset += 4;
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint64_t wide_integer(void) {
  uint64_t high = integer();
  return (high << 32) | integer();
}
static bool same_time(struct timespec actual, int64_t nanoseconds) {
  int64_t seconds = nanoseconds / 1000000000;
  int64_t remainder = nanoseconds % 1000000000;
  if (remainder < 0) { remainder += 1000000000; seconds--; }
  return actual.tv_sec == seconds && actual.tv_nsec == remainder;
}

static char *string(void) {
  uint32_t size = integer();
  if (size > length - offset || memchr(bytes + offset, 0, size) != NULL) invalid();
  char *result = malloc((size_t)size + 1);
  if (result == NULL) invalid();
  memcpy(result, bytes + offset, size);
  result[size] = 0; offset += size;
  return result;
}

static char **strings(bool environment) {
  uint32_t count = integer();
  if (count > MAX_STRINGS || (!environment && count == 0)) invalid();
  char **result = calloc((size_t)count + 1, sizeof(char *));
  if (result == NULL) invalid();
  for (uint32_t i = 0; i < count; i++) {
    result[i] = string();
    if (environment) {
      char *equals = strchr(result[i], '=');
      if (equals == NULL || equals == result[i]) invalid();
    }
  }
  return result;
}

int main(int argc, char **argv) {
  (void)argv;
  if (prctl(PR_SET_DUMPABLE, 0) < 0) invalid();
  if (argc != 1) invalid();
  struct stat metadata;
  int seals = fcntl(BOOTSTRAP_FD, F_GET_SEALS);
  int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
  if (fstat(BOOTSTRAP_FD, &metadata) < 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_size < 4 || metadata.st_size > MAX_BYTES || seals < 0 || (seals & required) != required) invalid();
  length = (size_t)metadata.st_size;
  bytes = malloc(length);
  if (bytes == NULL) invalid();
  size_t received = 0;
  while (received < length) {
    ssize_t count = pread(BOOTSTRAP_FD, bytes + received, length - received, (off_t)received);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) invalid();
    received += (size_t)count;
  }
  bool detached = memcmp(bytes, "AGL3", 4) == 0;
  bool bound_files = detached || memcmp(bytes, "AGL2", 4) == 0;
  if (!bound_files && memcmp(bytes, "AGL1", 4) != 0) invalid();
  offset = 4;
  char *program = string();
  if (program[0] == 0) invalid();
  char **arguments = strings(false);
  char **environment = strings(true);
  uint32_t count = bound_files ? integer() : 0;
  uint32_t roles[2] = {0, 0};
  if ((bound_files && !detached && count == 0) || count > 2) invalid();
  if (detached) {
    startup_fd = (int)count + 5;
    int kind = 0; socklen_t size = sizeof(kind);
    if (getsockopt(startup_fd, SOL_SOCKET, SO_TYPE, &kind, &size) < 0 || kind != SOCK_SEQPACKET ||
        fcntl(startup_fd, F_SETFD, FD_CLOEXEC) < 0) invalid();
  }
  for (uint32_t index = 0; index < count; index++) {
    uint32_t role = integer();
    uint64_t device = wide_integer(), inode = wide_integer();
    uint32_t mode = integer();
    uint64_t size = wide_integer();
    int64_t modified = (int64_t)wide_integer(), changed = (int64_t)wide_integer();
    struct stat held;
    if ((role != 1 && role != 2) || (index > 0 && role <= roles[index - 1]) ||
        fstat((int)index + 5, &held) < 0 || (uint64_t)held.st_dev != device ||
        (uint64_t)held.st_ino != inode || (uint32_t)held.st_mode != mode ||
        (role == 1 ? !S_ISDIR(held.st_mode) : !S_ISREG(held.st_mode))) invalid();
    if (role == 2 && ((uint64_t)held.st_size != size ||
        !same_time(held.st_mtim, modified) || !same_time(held.st_ctim, changed))) invalid();
    roles[index] = role;
    if (detached && role == 2) invalid();
  }
  char *log_path = detached ? string() : NULL;
  if (detached && (log_path[0] != '/' || strlen(log_path) >= 16384)) invalid();
  if (offset != length) invalid();
  for (uint32_t index = 0; index < count; index++) {
    int fd = (int)index + 5;
    if ((roles[index] == 1 ? fchdir(fd) : dup2(fd, 0)) < 0) invalid();
    close(fd);
  }
  close(3); close(BOOTSTRAP_FD);
  if (detached) {
    if (setsid() < 0 && !(errno == EPERM && getsid(0) == getpid())) invalid();
    int log = open(log_path, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
    if (log < 0 || fstat(log, &metadata) < 0 || !S_ISREG(metadata.st_mode)) invalid();
    int input = open("/dev/null", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    struct stat input_metadata;
    if (input < 0 || fstat(input, &input_metadata) < 0 || !S_ISCHR(input_metadata.st_mode) ||
        major(input_metadata.st_rdev) != 1 || minor(input_metadata.st_rdev) != 3 ||
        dup2(input, 0) < 0 || dup2(log, 1) < 0 || dup2(log, 2) < 0) invalid();
    close(input);
    if (!startup_message(1, (uint32_t)getpid(), log)) invalid();
    close(log);
  }
  /* Replace runc's default HOME and every other inherited value. execvp uses
   * this exact PATH for lookup, and preserves the independently supplied argv[0]. */
  environ = environment;
  execvp(program, arguments);
  int failure = errno;
  if (startup_fd >= 0) (void)startup_message(2, (uint32_t)failure, -1);
  fputs("agenc: task executable could not be started\n", stderr);
  return failure == ENOENT ? 127 : 126;
}
