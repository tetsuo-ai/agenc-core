#define _GNU_SOURCE

/* Protected task filesystem operations. This process joins only the task mount
 * namespace, replaces its root/cwd, drops setup capabilities and installs a
 * syscall allowlist before accepting operations. Task programs are never run.
 *
 * fd 3 is an inherited private SOCK_SEQPACKET channel. The first packet supplies
 * the pinned task root and mount namespace using SCM_RIGHTS. Subsequent packets
 * use bounded binary fields; they contain no source code or host path authority.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/fs.h>
#include <linux/memfd.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

enum {
  RPC_FD = 3,
  WORKER_PROTOCOL_VERSION = 9,
  PACKET_LIMIT = 128 * 1024,
  CONTENT_LIMIT = 32 * 1024 * 1024,
  RETAINED_LIMIT = 128 * 1024 * 1024,
  CAP_LIMIT = 1024,
  DEPTH_LIMIT = 128,
  PATH_LIMIT = 16384,
  NAME_LIMIT = 255,
  SYMLINK_LIMIT = 40,
  OP_HELLO = 1,
  OP_BIND = 2,
  OP_READ = 3,
  OP_STAT = 4,
  OP_RELEASE = 5,
  OP_LIST = 6,
  OP_CAPTURE = 7,
  OP_EXPECTED = 8,
  OP_STAGE = 9,
  OP_APPEND = 10,
  OP_SEAL = 11,
  OP_ASSERT = 12,
  OP_WRITE = 13,
  OP_REMOVE = 14,
  OP_ASSERT_ORIGINAL = 15,
  OP_BIND_ENTRY = 16,
  OP_READLINK = 17,
  OP_REMOVE_SYMLINK = 18,
  OP_REMOVE_DIRECTORY = 19,
  OP_RENAME_FILE = 20,
  OP_EXPORT = 21,
  OP_EXPORT_STREAM = 22,
  OP_INSPECT_PATH = 23,
  OP_DESCRIBE_PATH = 24,
  OP_DESCRIBE_HANDLE = 25,
  OP_CREATE_DIRECTORY = 26,
  KIND_FILE = 1,
  KIND_DIRECTORY = 2,
  KIND_GUARD = 3,
  KIND_CONTENT = 4,
  KIND_ENTRY = 5
};
#define REOPEN_STATUS UINT32_MAX
#define ALL_SEALS (F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE)

struct cursor { const unsigned char *bytes; size_t length; size_t offset; };
struct chain { int fds[DEPTH_LIMIT]; size_t count; };
struct resolved {
  struct chain parent;
  int fd;
  char name[NAME_LIMIT + 1];
  /* Only guards may retain an absent ancestor followed by more components. */
  char remaining[PATH_LIMIT];
};
struct capability {
  uint32_t id;
  uint32_t kind;
  struct resolved target;
  char *path;
  struct stat identity;
  struct stat parent_identity;
  int snapshot;
  int original;
  int original_target;
  struct stat original_identity;
  bool existed;
  bool sealed;
  size_t retained;
  DIR *directory;
};

static struct capability capabilities[CAP_LIMIT];
static uint32_t next_id = 1;
static int root_fd = -1;
static size_t retained_bytes;
static unsigned char request_bytes[PACKET_LIMIT];
static unsigned char response_bytes[PACKET_LIMIT];
static uint32_t request_id;
static bool mutation_started;
static int response_fd = -1;

static uint32_t get_u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
    ((uint32_t)bytes[2] << 8) | bytes[3];
}
static void put_u32(unsigned char *bytes, uint32_t value) {
  bytes[0] = value >> 24; bytes[1] = value >> 16;
  bytes[2] = value >> 8; bytes[3] = value;
}
static void put_u64(unsigned char *bytes, uint64_t value) {
  put_u32(bytes, value >> 32); put_u32(bytes + 4, value);
}
static int take_u32(struct cursor *input, uint32_t *result) {
  if (input->length - input->offset < 4) { errno = EPROTO; return -1; }
  *result = get_u32(input->bytes + input->offset); input->offset += 4; return 0;
}
static char *take_string(struct cursor *input) {
  uint32_t length;
  if (take_u32(input, &length) < 0) return NULL;
  if (length >= PATH_LIMIT || length > input->length - input->offset ||
      memchr(input->bytes + input->offset, 0, length) != NULL) { errno = EPROTO; return NULL; }
  char *result = malloc((size_t)length + 1);
  if (result == NULL) return NULL;
  memcpy(result, input->bytes + input->offset, length); result[length] = 0;
  input->offset += length; return result;
}
static int finish(struct cursor *input) {
  if (input->offset != input->length) { errno = EPROTO; return -1; }
  return 0;
}

static ssize_t receive_packet(void *bytes, size_t capacity, int *fds, size_t *fd_count) {
  unsigned char control[CMSG_SPACE(4 * sizeof(int))];
  struct iovec vector = { .iov_base = bytes, .iov_len = capacity };
  struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1,
    .msg_control = control, .msg_controllen = sizeof(control) };
  ssize_t length;
  do { length = recvmsg(RPC_FD, &message, MSG_CMSG_CLOEXEC); } while (length < 0 && errno == EINTR);
  *fd_count = 0;
  if (length <= 0) return length;
  for (struct cmsghdr *item = CMSG_FIRSTHDR(&message); item != NULL; item = CMSG_NXTHDR(&message, item)) {
    if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS) continue;
    size_t count = (item->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    int *received = (int *)CMSG_DATA(item);
    for (size_t i = 0; i < count; i++) {
      if (*fd_count < 4) fds[(*fd_count)++] = received[i];
      else close(received[i]);
    }
  }
  if (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) {
    for (size_t i = 0; i < *fd_count; i++) close(fds[i]);
    *fd_count = 0; errno = E2BIG; return -1;
  }
  return length;
}
static int send_packet(const void *bytes, size_t length, int fd) {
  unsigned char control[CMSG_SPACE(sizeof(int))];
  struct iovec vector = { .iov_base = (void *)bytes, .iov_len = length };
  struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1 };
  if (fd >= 0) {
    memset(control, 0, sizeof(control));
    message.msg_control = control; message.msg_controllen = sizeof(control);
    struct cmsghdr *item = CMSG_FIRSTHDR(&message);
    item->cmsg_level = SOL_SOCKET; item->cmsg_type = SCM_RIGHTS; item->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(item), &fd, sizeof(fd));
  }
  ssize_t written;
  do { written = sendmsg(RPC_FD, &message, MSG_NOSIGNAL); } while (written < 0 && errno == EINTR);
  if (written < 0) return -1;
  if ((size_t)written != length) { errno = EIO; return -1; }
  return 0;
}
static int respond(uint32_t status, size_t length) {
  put_u32(response_bytes, request_id); put_u32(response_bytes + 4, status);
  put_u32(response_bytes + 8, mutation_started ? 1 : 0);
  return send_packet(response_bytes, 12 + length, status == 0 ? response_fd : -1);
}

static bool same_inode(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode;
}
static bool same_version(const struct stat *a, const struct stat *b) {
  return same_inode(a, b) && a->st_size == b->st_size &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static size_t encode_stat(unsigned char *bytes, const struct stat *value) {
  put_u64(bytes, value->st_dev); put_u64(bytes + 8, value->st_ino);
  put_u32(bytes + 16, value->st_mode); put_u64(bytes + 20, value->st_size);
  put_u64(bytes + 28, (uint64_t)value->st_mtim.tv_sec * 1000000000 + value->st_mtim.tv_nsec);
  put_u64(bytes + 36, (uint64_t)value->st_ctim.tv_sec * 1000000000 + value->st_ctim.tv_nsec);
  return 44;
}
static int ordinary_resource(int fd, struct stat *identity) {
  struct statfs filesystem;
  if (fstat(fd, identity) < 0 || fstatfs(fd, &filesystem) < 0) return -1;
  if (!S_ISREG(identity->st_mode) && !S_ISDIR(identity->st_mode) && !S_ISLNK(identity->st_mode)) {
    errno = EOPNOTSUPP; return -1;
  }
  /* pseudo files can be S_IFREG but still carry process/kernel authority. */
  switch ((unsigned long)filesystem.f_type) {
    case 0x9fa0: case 0x62656572: case 0x27e0eb: case 0x63677270:
    case 0x1cd1: case 0x64626720: case 0x74726163: case 0xcafe4a11:
    case 0x6e736673: case 0x73636673: case 0x50495045: case 0x19800202:
      errno = EOPNOTSUPP; return -1;
    default: return 0;
  }
}
static int reopen_regular_or_directory(int fd, int flags) {
  struct stat before, after;
  if (ordinary_resource(fd, &before) < 0) return -1;
  if ((!S_ISREG(before.st_mode) && !S_ISDIR(before.st_mode)) ||
      (S_ISDIR(before.st_mode) && flags != O_RDONLY)) { errno = EOPNOTSUPP; return -1; }
  unsigned char request[12];
  put_u32(request, request_id); put_u32(request + 4, REOPEN_STATUS); put_u32(request + 8, flags);
  if (send_packet(request, sizeof(request), fd) < 0) return -1;
  unsigned char reply[8]; int fds[4]; size_t count;
  ssize_t length = receive_packet(reply, sizeof(reply), fds, &count);
  if (length != 8 || count != 1 || get_u32(reply) != request_id || get_u32(reply + 4) != 0) {
    for (size_t i = 0; i < count; i++) close(fds[i]);
    errno = length == 8 && get_u32(reply + 4) != 0 ? (int)get_u32(reply + 4) : EPROTO;
    return -1;
  }
  if (fstat(fds[0], &after) < 0 || !same_inode(&before, &after)) {
    close(fds[0]); errno = ESTALE; return -1;
  }
  return fds[0];
}

static void close_chain(struct chain *chain) {
  while (chain->count > 0) close(chain->fds[--chain->count]);
}
static int push_chain(struct chain *chain, int fd) {
  if (chain->count == DEPTH_LIMIT) { errno = ENAMETOOLONG; return -1; }
  int copy = fcntl(fd, F_DUPFD_CLOEXEC, 4);
  if (copy < 0) return -1;
  chain->fds[chain->count++] = copy; return 0;
}
static void close_resolved(struct resolved *target) {
  close_chain(&target->parent);
  if (target->fd >= 0) close(target->fd);
  target->fd = -1;
}
static int confined_component(int parent, const char *name, int flags, mode_t mode) {
  struct open_how how = { .flags = (uint64_t)(flags | O_CLOEXEC), .mode = mode,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS };
  return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}

/* Walk from a held ancestry, not a reconstructed pathname. Each component is
 * confined with openat2; '..' only pops held ancestors and absolute symlinks
 * reset to the pinned task root. No symlink is ever followed by plain openat.
 */
static int append_canonical(char *canonical, const char *name) {
  if (canonical == NULL) return 0;
  size_t length = strlen(canonical), extra = length > 1 ? 1 : 0;
  if (length + extra + strlen(name) >= PATH_LIMIT) { errno = ENAMETOOLONG; return -1; }
  if (extra) canonical[length++] = '/';
  strcpy(canonical + length, name); return 0;
}

static int resolve_path_with_canonical(const struct capability *base, const char *path,
    bool allow_missing, bool follow_final, struct resolved *result, char *canonical) {
  memset(result, 0, sizeof(*result)); result->fd = -1;
  if (canonical != NULL) {
    if (base != NULL || path[0] != '/') { errno = EINVAL; return -1; }
    strcpy(canonical, "/");
  }
  if (strlen(path) >= PATH_LIMIT) { errno = ENAMETOOLONG; return -1; }
  if (base != NULL && path[0] != '/') {
    if (base->kind != KIND_DIRECTORY) { errno = ENOTDIR; return -1; }
    for (size_t i = 0; i < base->target.parent.count; i++)
      if (push_chain(&result->parent, base->target.parent.fds[i]) < 0) goto failed;
    struct stat parent, target;
    if (fstat(result->parent.fds[result->parent.count - 1], &parent) < 0 || fstat(base->target.fd, &target) < 0) goto failed;
    if (!same_inode(&parent, &target) && push_chain(&result->parent, base->target.fd) < 0) goto failed;
  } else if (push_chain(&result->parent, root_fd) < 0) goto failed;
  char pending[PATH_LIMIT]; strcpy(pending, path);
  size_t followed = 0;
  for (;;) {
    char *start = pending;
    while (*start == '/') start++;
    if (*start == 0) {
      result->fd = fcntl(result->parent.fds[result->parent.count - 1], F_DUPFD_CLOEXEC, 4);
      if (result->fd < 0) goto failed;
      if (result->parent.count > 1) close(result->parent.fds[--result->parent.count]);
      strcpy(result->name, "."); return 0;
    }
    char *end = strchr(start, '/');
    size_t size = end == NULL ? strlen(start) : (size_t)(end - start);
    if (size > NAME_LIMIT) { errno = ENAMETOOLONG; goto failed; }
    char name[NAME_LIMIT + 1]; memcpy(name, start, size); name[size] = 0;
    char rest[PATH_LIMIT]; strcpy(rest, end == NULL ? "" : end);
    bool last = rest[strspn(rest, "/")] == 0;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
      if (strcmp(name, "..") == 0 && result->parent.count > 1) {
        close(result->parent.fds[--result->parent.count]);
        if (canonical != NULL) {
          char *slash = strrchr(canonical, '/');
          if (slash == canonical) canonical[1] = 0; else *slash = 0;
        }
      }
      strcpy(pending, rest); continue;
    }
    int fd = confined_component(result->parent.fds[result->parent.count - 1], name, O_PATH | O_NOFOLLOW, 0);
    if (fd < 0) {
      if (errno == ENOENT && allow_missing) {
        // Missing components cannot be traversed through dot-dot or interpreted
        // as a trailing directory requirement by a regular-file transaction.
        if (path[strlen(path) - 1] == '/') { errno = ENOENT; goto failed; }
        if (append_canonical(canonical, name) < 0) goto failed;
        strcpy(result->name, name);
        const char *next = rest;
        size_t depth = result->parent.count;
        while (*next != 0) {
          next += strspn(next, "/");
          if (*next == 0) break;
          const char *stop = strchr(next, '/');
          size_t length = stop == NULL ? strlen(next) : (size_t)(stop - next);
          if (length > NAME_LIMIT || ++depth > DEPTH_LIMIT) { errno = ENAMETOOLONG; goto failed; }
          char component[NAME_LIMIT + 1]; memcpy(component, next, length); component[length] = 0;
          if (strcmp(component, ".") == 0 || strcmp(component, "..") == 0) { errno = ENOENT; goto failed; }
          if (result->remaining[0] != 0) strcat(result->remaining, "/");
          strcat(result->remaining, component);
          if (append_canonical(canonical, component) < 0) goto failed;
          next += length;
        }
        return 0;
      }
      goto failed;
    }
    struct stat identity;
    if (ordinary_resource(fd, &identity) < 0) { int saved = errno; close(fd); errno = saved; goto failed; }
    if (S_ISLNK(identity.st_mode) && (!last || follow_final)) {
      if (++followed > SYMLINK_LIMIT) { close(fd); errno = ELOOP; goto failed; }
      char target[PATH_LIMIT];
      ssize_t length = readlinkat(fd, "", target, sizeof(target) - 1);
      int saved = errno; close(fd); errno = saved;
      if (length < 0) goto failed;
      target[length] = 0;
      if ((size_t)length + strlen(rest) >= sizeof(pending)) { errno = ENAMETOOLONG; goto failed; }
      if (target[0] == '/') {
        close_chain(&result->parent);
        if (push_chain(&result->parent, root_fd) < 0) goto failed;
        if (canonical != NULL) strcpy(canonical, "/");
      }
      strcpy(pending, target); strcat(pending, rest); continue;
    }
    if (last) {
      if (rest[0] != 0 && !S_ISDIR(identity.st_mode)) { close(fd); errno = ENOTDIR; goto failed; }
      if (append_canonical(canonical, name) < 0) { close(fd); goto failed; }
      result->fd = fd; strcpy(result->name, name); return 0;
    }
    if (!S_ISDIR(identity.st_mode)) { close(fd); errno = ENOTDIR; goto failed; }
    int pushed = push_chain(&result->parent, fd); int saved = errno;
    close(fd); errno = saved;
    if (pushed < 0) goto failed;
    if (append_canonical(canonical, name) < 0) goto failed;
    strcpy(pending, rest);
  }
failed:
  { int saved = errno; close_resolved(result); errno = saved; return -1; }
}

static int resolve_path(const struct capability *base, const char *path,
    bool allow_missing, bool follow_final, struct resolved *result) {
  return resolve_path_with_canonical(base, path, allow_missing, follow_final, result, NULL);
}

/* Canonical provenance is generated by the same confined walk as the held
 * object, then revalidated against that object. No host proc paths or cwd
 * changes are involved. Unlike raw getcwd, this retains PATH_LIMIT support. */
static int describe_path(const char *path, bool follow, const struct capability *held, size_t *output_length) {
  struct resolved target, checked;
  struct stat before, after;
  char canonical[PATH_LIMIT], checked_canonical[PATH_LIMIT];
  if (path[0] != '/') { errno = EINVAL; return -1; }
  if (resolve_path_with_canonical(NULL, path, false, follow, &target, canonical) < 0) return -1;
  int result = ordinary_resource(target.fd, &before);
  if (result == 0 && held != NULL) {
    result = fstat(held->target.fd, &after);
    if (result == 0 && (!same_version(&before, &after) || before.st_nlink != after.st_nlink)) {
      errno = ESTALE; result = -1;
    }
  }
  if (result == 0) {
    result = resolve_path_with_canonical(NULL, canonical, false, false, &checked, checked_canonical);
    if (result == 0) {
      result = fstat(checked.fd, &after);
      if (result == 0 && (!same_version(&before, &after) || before.st_nlink != after.st_nlink ||
                         strcmp(canonical, checked_canonical) != 0)) { errno = ESTALE; result = -1; }
      int saved = errno; close_resolved(&checked); errno = saved;
    }
  }
  int saved = errno; close_resolved(&target); errno = saved;
  if (result < 0) return -1;
  size_t length = strlen(canonical);
  put_u64(response_bytes + 12, before.st_dev); put_u64(response_bytes + 20, before.st_ino);
  put_u32(response_bytes + 28, before.st_mode); put_u64(response_bytes + 32, before.st_nlink);
  put_u64(response_bytes + 40, before.st_size);
  /* Seconds plus nanoseconds avoid overflow even for timestamps outside the
   * signed 64-bit nanosecond range. The controller reconstructs exact integers. */
  put_u64(response_bytes + 48, (uint64_t)before.st_mtim.tv_sec); put_u32(response_bytes + 56, before.st_mtim.tv_nsec);
  put_u64(response_bytes + 60, (uint64_t)before.st_ctim.tv_sec); put_u32(response_bytes + 68, before.st_ctim.tv_nsec);
  put_u32(response_bytes + 72, (uint32_t)length);
  memcpy(response_bytes + 76, canonical, length);
  *output_length = 64 + length; return 0;
}

static struct capability *find_cap(uint32_t id, uint32_t kind) {
  for (size_t i = 0; i < CAP_LIMIT; i++) {
    if (capabilities[i].id == id && id != 0) {
      if (kind != 0 && capabilities[i].kind != kind) { errno = EINVAL; return NULL; }
      return &capabilities[i];
    }
  }
  errno = ESTALE; return NULL;
}
static struct capability *new_cap(uint32_t kind) {
  if (next_id == 0) { errno = EMFILE; return NULL; }
  for (size_t i = 0; i < CAP_LIMIT; i++) if (capabilities[i].id == 0) {
    struct capability *cap = &capabilities[i]; memset(cap, 0, sizeof(*cap));
    cap->id = next_id++; cap->kind = kind; cap->target.fd = -1;
    cap->snapshot = -1; cap->original = -1; cap->original_target = -1; return cap;
  }
  errno = EMFILE; return NULL;
}
static void release_cap(struct capability *cap) {
  if (cap->directory != NULL) closedir(cap->directory);
  close_resolved(&cap->target);
  if (cap->snapshot >= 0) close(cap->snapshot);
  if (cap->original >= 0) close(cap->original);
  if (cap->original_target >= 0) close(cap->original_target);
  free(cap->path); retained_bytes -= cap->retained;
  memset(cap, 0, sizeof(*cap));
}
static int copy_bytes(int source, int destination, off_t length) {
  unsigned char buffer[65536]; off_t offset = 0;
  while (offset < length) {
    size_t wanted = (uint64_t)(length - offset) < sizeof(buffer) ? (size_t)(length - offset) : sizeof(buffer);
    ssize_t count = pread(source, buffer, wanted, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { if (count == 0) errno = ESTALE; return -1; }
    ssize_t written = 0;
    while (written < count) {
      ssize_t size = pwrite(destination, buffer + written, (size_t)(count - written), offset + written);
      if (size < 0 && errno == EINTR) continue;
      if (size <= 0) { if (size == 0) errno = EIO; return -1; }
      written += size;
    }
    offset += count;
  }
  return 0;
}
static int compare_bytes(int left, int right) {
  struct stat first, second;
  if (fstat(left, &first) < 0 || fstat(right, &second) < 0) return -1;
  if (first.st_size != second.st_size || first.st_size < 0 || first.st_size > CONTENT_LIMIT) { errno = ESTALE; return -1; }
  unsigned char a[32768], b[32768];
  for (off_t offset = 0; offset < first.st_size;) {
    size_t wanted = (uint64_t)(first.st_size - offset) < sizeof(a) ? (size_t)(first.st_size - offset) : sizeof(a);
    ssize_t x = pread(left, a, wanted, offset), y = pread(right, b, wanted, offset);
    if (x < 0 || y < 0) return -1;
    if (x != (ssize_t)wanted || y != x || memcmp(a, b, wanted) != 0) { errno = ESTALE; return -1; }
    offset += (off_t)wanted;
  }
  return 0;
}
static int snapshot_file(struct capability *cap) {
  int readable = reopen_regular_or_directory(cap->target.fd, O_RDONLY);
  if (readable < 0) return -1;
  struct stat before, after;
  if (fstat(readable, &before) < 0) { close(readable); return -1; }
  if (before.st_size < 0 || before.st_size > CONTENT_LIMIT ||
      retained_bytes + (size_t)before.st_size > RETAINED_LIMIT) { close(readable); errno = EFBIG; return -1; }
  int snapshot = (int)syscall(SYS_memfd_create, "agenc-fs-snapshot", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (snapshot < 0) { close(readable); return -1; }
  if (copy_bytes(readable, snapshot, before.st_size) < 0 || fstat(readable, &after) < 0 ||
      !same_version(&before, &after) || fcntl(snapshot, F_ADD_SEALS, ALL_SEALS) < 0) {
    close(readable); close(snapshot); errno = ESTALE; return -1;
  }
  close(readable); cap->snapshot = snapshot;
  cap->original = fcntl(snapshot, F_DUPFD_CLOEXEC, 4);
  if (cap->original < 0) return -1;
  cap->identity = after; cap->retained = (size_t)after.st_size; retained_bytes += cap->retained;
  return 0;
}

static int guard_current_target(struct capability *cap, int expected, int target_fd,
    const struct stat *target_identity) {
  struct resolved current;
  if (resolve_path(NULL, cap->path, true, true, &current) < 0) return -1;
  struct stat held_parent, current_parent, held_target, current_target;
  bool same_parent = fstat(cap->target.parent.fds[cap->target.parent.count - 1], &held_parent) == 0 &&
    fstat(current.parent.fds[current.parent.count - 1], &current_parent) == 0 && same_inode(&held_parent, &current_parent) &&
    same_inode(&held_parent, &cap->parent_identity) &&
    strcmp(cap->target.name, current.name) == 0 &&
    strcmp(cap->target.remaining, current.remaining) == 0;
  bool same_target = expected < 0 ? current.fd < 0 :
    current.fd >= 0 && target_fd >= 0 && fstat(current.fd, &current_target) == 0 &&
    fstat(target_fd, &held_target) == 0 && same_inode(&held_target, &current_target) &&
    same_inode(&held_target, target_identity);
  close_resolved(&current);
  if (!same_parent || !same_target) { errno = ESTALE; return -1; }
  if (expected < 0) return 0;
  int file = reopen_regular_or_directory(target_fd, O_RDONLY);
  if (file < 0) return -1;
  int result = compare_bytes(file, expected); int saved = errno; close(file); errno = saved; return result;
}
static int guard_current(struct capability *cap, int expected) {
  return guard_current_target(cap, expected, cap->target.fd, &cap->identity);
}
static int expected_content(uint32_t id, int *fd) {
  if (id == 0) { *fd = -1; return 0; }
  struct capability *cap = find_cap(id, KIND_CONTENT);
  if (cap == NULL) return -1;
  if (!cap->sealed) { errno = EINVAL; return -1; }
  *fd = cap->target.fd; return 0;
}

static bool valid_name(const char *name) {
  return name[0] != 0 && strlen(name) <= NAME_LIMIT && strchr(name, '/') == NULL &&
    strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}
static int entry_current(struct capability *cap, bool version) {
  struct resolved current;
  if (resolve_path(NULL, cap->path, false, false, &current) < 0) return -1;
  struct stat parent, target;
  bool matches = fstat(current.parent.fds[current.parent.count - 1], &parent) == 0 &&
    same_inode(&parent, &cap->parent_identity) && strcmp(current.name, cap->target.name) == 0 &&
    fstat(current.fd, &target) == 0 && (version ? same_version(&target, &cap->identity) : same_inode(&target, &cap->identity));
  close_resolved(&current);
  if (!matches) { errno = ESTALE; return -1; }
  return 0;
}
static int named_inode(int parent, const char *name, const struct stat *expected) {
  int fd = confined_component(parent, name, O_PATH | O_NOFOLLOW, 0);
  if (fd < 0) return -1;
  struct stat current;
  int result = fstat(fd, &current); int saved = errno;
  close(fd); errno = saved;
  if (result < 0) return -1;
  if (!same_inode(&current, expected)) { errno = ESTALE; return -1; }
  return 0;
}
static int sync_directory(int fd) {
  int readable = reopen_regular_or_directory(fd, O_RDONLY);
  if (readable < 0) return -1;
  int result = fsync(readable); int saved = errno;
  close(readable); errno = saved; return result;
}

/* Parent creation is part of the admitted write, never capture/preflight.
 * Existing entries are not adopted: every missing component must be created
 * exclusively. Once opened, each directory stays held across subsequent steps.
 * A task exchange is checked against the full pathname before proceeding; all
 * syscalls themselves address held directories and never follow a new symlink.
 * Partial directory creation remains a mutation even if the leaf stays absent.
 * Parents are intentionally not recursively removed on failure or rollback.
 */
static int create_guard_parents(struct capability *cap) {
  while (cap->target.remaining[0] != 0) {
    if (guard_current(cap, -1) < 0) return -1;
    int parent = cap->target.parent.fds[cap->target.parent.count - 1];
    bool earlier_effect = mutation_started;
    mutation_started = true;
    if (mkdirat(parent, cap->target.name, 0777) < 0) {
      if (errno == EEXIST) mutation_started = earlier_effect;
      return -1;
    }
    int child = confined_component(parent, cap->target.name, O_PATH | O_DIRECTORY | O_NOFOLLOW, 0);
    if (child < 0) return -1;
    struct stat identity;
    int result = ordinary_resource(child, &identity);
    if (result == 0 && !S_ISDIR(identity.st_mode)) { errno = ENOTDIR; result = -1; }
    if (result == 0) result = push_chain(&cap->target.parent, child);
    int saved = errno; close(child); errno = saved;
    if (result < 0) return -1;
    cap->parent_identity = identity;
    char *slash = strchr(cap->target.remaining, '/');
    size_t length = slash == NULL ? strlen(cap->target.remaining) : (size_t)(slash - cap->target.remaining);
    memcpy(cap->target.name, cap->target.remaining, length); cap->target.name[length] = 0;
    if (slash == NULL) cap->target.remaining[0] = 0;
    else memmove(cap->target.remaining, slash + 1, strlen(slash + 1) + 1);
    if (sync_directory(parent) < 0 || guard_current(cap, -1) < 0) return -1;
  }
  return 0;
}

/* Never follow links while deleting a captured tree. Traversal uses held
 * directory descriptors and has finite depth/work even under task churn.
 * Errors after relocation retain mutation_started and the quarantine name in
 * the supervisor's original request receipt. There is no automatic retry.
 */
static int remove_tree(int directory, size_t depth, size_t *work) {
  if (depth >= DEPTH_LIMIT) { errno = ELOOP; return -1; }
  int readable = reopen_regular_or_directory(directory, O_RDONLY);
  if (readable < 0) return -1;
  DIR *stream = fdopendir(readable);
  if (stream == NULL) { close(readable); return -1; }
  int result = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) { if (errno != 0) result = -1; break; }
    if (++*work > 1000000) { errno = E2BIG; result = -1; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    int child = confined_component(directory, entry->d_name, O_PATH | O_NOFOLLOW, 0);
    if (child < 0) { result = -1; break; }
    struct stat identity;
    result = ordinary_resource(child, &identity);
    if (result == 0 && S_ISDIR(identity.st_mode)) result = remove_tree(child, depth + 1, work);
    if (result == 0) result = named_inode(directory, entry->d_name, &identity);
    if (result == 0) result = unlinkat(directory, entry->d_name, S_ISDIR(identity.st_mode) ? AT_REMOVEDIR : 0);
    int saved = errno; close(child); errno = saved;
    if (result < 0) break;
  }
  int saved = errno; closedir(stream); errno = saved;
  if (result == 0) result = sync_directory(directory);
  return result;
}

static int move_entry(struct capability *cap, const char *destination) {
  int parent = cap->target.parent.fds[cap->target.parent.count - 1];
  mutation_started = true;
  if (syscall(SYS_renameat2, parent, cap->target.name, parent, destination, RENAME_NOREPLACE) < 0) {
    if (errno == EEXIST) mutation_started = false;
    return -1;
  }
  if (named_inode(parent, destination, &cap->identity) < 0) {
    int saved = errno;
    /* A concurrent source replacement must never authorize recursive deletion
     * of the replacement. Restore only into a still-empty source name. */
    (void)syscall(SYS_renameat2, parent, destination, parent, cap->target.name, RENAME_NOREPLACE);
    errno = saved; return -1;
  }
  return sync_directory(parent);
}

static int dispatch(uint32_t operation, struct cursor *input, size_t *output_length) {
  uint32_t id, kind, base_id, offset, maximum;
  struct capability *cap;
  struct stat identity;
  *output_length = 0;
  if (operation == OP_HELLO) {
    if (finish(input) < 0 || fstat(root_fd, &identity) < 0) return -1;
    put_u32(response_bytes + 12, WORKER_PROTOCOL_VERSION); *output_length = 4 + encode_stat(response_bytes + 16, &identity); return 0;
  }
  if (operation == OP_DESCRIBE_PATH) {
    uint32_t follow;
    if (take_u32(input, &follow) < 0 || follow > 1) { errno = EINVAL; return -1; }
    char *path = take_string(input);
    if (path == NULL) return -1;
    int result = finish(input);
    if (result == 0) result = describe_path(path, follow != 0, NULL, output_length);
    int saved = errno; free(path); errno = saved; return result;
  }
  if (operation == OP_INSPECT_PATH) {
    uint32_t follow;
    if (take_u32(input, &follow) < 0 || follow > 1) { errno = EINVAL; return -1; }
    char *path = take_string(input);
    if (path == NULL) return -1;
    if (path[0] != '/' || finish(input) < 0) { free(path); errno = EINVAL; return -1; }
    struct resolved target;
    int result = resolve_path(NULL, path, false, follow != 0, &target);
    int saved = errno; free(path); errno = saved;
    if (result < 0) return -1;
    result = ordinary_resource(target.fd, &identity);
    saved = errno; close_resolved(&target); errno = saved;
    if (result < 0) return -1;
    *output_length = encode_stat(response_bytes + 12, &identity); return 0;
  }
  if (operation == OP_BIND_ENTRY) {
    if (take_u32(input, &base_id) < 0) return -1;
    char *name = take_string(input);
    if (name == NULL) return -1;
    struct capability *base = find_cap(base_id, KIND_DIRECTORY);
    if (base == NULL) { free(name); return -1; }
    if (finish(input) < 0 || !valid_name(name) || base->path[0] != '/' ||
        strlen(base->path) + strlen(name) + 2 >= PATH_LIMIT) { free(name); errno = EINVAL; return -1; }
    cap = new_cap(KIND_ENTRY);
    if (cap == NULL) { free(name); return -1; }
    cap->path = malloc(strlen(base->path) + strlen(name) + 2);
    int result = -1;
    if (cap->path != NULL) {
      strcpy(cap->path, base->path); strcat(cap->path, "/"); strcat(cap->path, name);
      result = resolve_path(base, name, false, false, &cap->target);
    }
    int saved = errno; free(name); errno = saved;
    if (result == 0) result = fstat(cap->target.parent.fds[cap->target.parent.count - 1], &cap->parent_identity);
    if (result == 0 && !same_inode(&cap->parent_identity, &base->identity)) { errno = ESTALE; result = -1; }
    if (result == 0) result = ordinary_resource(cap->target.fd, &cap->identity);
    if (result == 0) result = entry_current(cap, false);
    if (result < 0) { saved = errno; release_cap(cap); errno = saved; return -1; }
    cap->existed = true;
    put_u32(response_bytes + 12, cap->id);
    *output_length = 4 + encode_stat(response_bytes + 16, &cap->identity); return 0;
  }
  if (operation == OP_BIND || operation == OP_CAPTURE) {
    if (take_u32(input, &base_id) < 0 || take_u32(input, &kind) < 0) return -1;
    char *path = take_string(input);
    if (path == NULL) return -1;
    if (finish(input) < 0 || (kind != KIND_FILE && kind != KIND_DIRECTORY) ||
        (operation == OP_CAPTURE && (base_id != 0 || path[0] != '/'))) { free(path); errno = EPROTO; return -1; }
    struct capability *base = base_id == 0 ? NULL : find_cap(base_id, KIND_DIRECTORY);
    if (base_id != 0 && base == NULL) { free(path); return -1; }
    cap = new_cap(operation == OP_CAPTURE ? KIND_GUARD : kind);
    if (cap == NULL) { free(path); return -1; }
    cap->path = path;
    if (resolve_path(base, path, operation == OP_CAPTURE, true, &cap->target) < 0) goto cap_failed;
    if (fstat(cap->target.parent.fds[cap->target.parent.count - 1], &cap->parent_identity) < 0) goto cap_failed;
    cap->existed = cap->target.fd >= 0;
    memset(&identity, 0, sizeof(identity));
    if (cap->existed && ordinary_resource(cap->target.fd, &identity) < 0) goto cap_failed;
    if (cap->existed && ((kind == KIND_FILE && !S_ISREG(identity.st_mode)) ||
                         (kind == KIND_DIRECTORY && !S_ISDIR(identity.st_mode)))) { errno = EOPNOTSUPP; goto cap_failed; }
    cap->identity = identity;
    if (operation == OP_CAPTURE && cap->existed && snapshot_file(cap) < 0) goto cap_failed;
    if (operation == OP_CAPTURE && cap->existed) {
      cap->original_target = fcntl(cap->target.fd, F_DUPFD_CLOEXEC, 4);
      if (cap->original_target < 0) goto cap_failed;
      cap->original_identity = cap->identity;
    }
    put_u32(response_bytes + 12, cap->id); put_u32(response_bytes + 16, cap->existed ? 1 : 0);
    if (operation == OP_CAPTURE) {
      put_u32(response_bytes + 20, cap->target.remaining[0] != 0 ? 1 : 0);
      *output_length = 12 + encode_stat(response_bytes + 24, &cap->identity);
    } else *output_length = 8 + encode_stat(response_bytes + 20, &cap->identity);
    return 0;
cap_failed:
    { int saved = errno; release_cap(cap); errno = saved; return -1; }
  }
  if (operation == OP_STAGE) {
    if (finish(input) < 0) return -1;
    cap = new_cap(KIND_CONTENT); if (cap == NULL) return -1;
    cap->target.fd = (int)syscall(SYS_memfd_create, "agenc-fs-content", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (cap->target.fd < 0) { release_cap(cap); return -1; }
    put_u32(response_bytes + 12, cap->id); *output_length = 4; return 0;
  }
  if (take_u32(input, &id) < 0) return -1;
  cap = find_cap(id, 0); if (cap == NULL) return -1;
  if (operation == OP_CREATE_DIRECTORY) {
    uint32_t mode;
    if (cap->kind != KIND_DIRECTORY || take_u32(input, &mode) < 0 || mode > 0777) { errno = EINVAL; return -1; }
    char *name = take_string(input);
    if (name == NULL) return -1;
    if (!valid_name(name) || finish(input) < 0) { free(name); errno = EINVAL; return -1; }
    size_t ignored;
    int result = describe_path(cap->path, true, cap, &ignored);
    if (result == 0) {
      mutation_started = true;
      /* The parent remains descriptor-bound even if task code exchanges its
       * pathname after validation. mkdirat never traverses an existing leaf. */
      result = mkdirat(cap->target.fd, name, (mode_t)mode);
      if (result < 0 && errno == EEXIST) mutation_started = false;
      if (result == 0) result = sync_directory(cap->target.fd);
      if (result == 0) result = describe_path(cap->path, true, cap, &ignored);
    }
    int saved = errno; free(name); errno = saved; return result;
  }
  if (operation == OP_DESCRIBE_HANDLE) {
    if (finish(input) < 0 || (cap->kind != KIND_FILE && cap->kind != KIND_DIRECTORY)) { errno = EINVAL; return -1; }
    return describe_path(cap->path, true, cap, output_length);
  }
  if (operation == OP_RELEASE) {
    if (finish(input) < 0) return -1;
    release_cap(cap); return 0;
  }
  if (operation == OP_STAT) {
    if (finish(input) < 0 || cap->target.fd < 0 || fstat(cap->target.fd, &identity) < 0) return -1;
    *output_length = encode_stat(response_bytes + 12, &identity); return 0;
  }
  if (operation == OP_ASSERT_ORIGINAL) {
    if (cap->kind != KIND_GUARD || finish(input) < 0) { errno = EINVAL; return -1; }
    return guard_current_target(cap, cap->original, cap->original_target, &cap->original_identity);
  }
  if (operation == OP_READLINK) {
    if (cap->kind != KIND_ENTRY || !S_ISLNK(cap->identity.st_mode) || finish(input) < 0) { errno = EINVAL; return -1; }
    if (entry_current(cap, false) < 0) return -1;
    ssize_t count = readlinkat(cap->target.fd, "", (char *)response_bytes + 12, PATH_LIMIT);
    if (count < 0) return -1;
    if (count == PATH_LIMIT) { errno = ENAMETOOLONG; return -1; }
    if (entry_current(cap, false) < 0) return -1;
    *output_length = (size_t)count; return 0;
  }
  if (operation == OP_EXPORT || operation == OP_EXPORT_STREAM) {
    if (take_u32(input, &kind) < 0 || finish(input) < 0 ||
        (kind != KIND_FILE && kind != KIND_DIRECTORY) || cap->kind != kind) { errno = EINVAL; return -1; }
    if (operation == OP_EXPORT_STREAM && kind != KIND_FILE) { errno = EINVAL; return -1; }
    int fd = reopen_regular_or_directory(cap->target.fd, O_RDONLY);
    if (fd < 0) return -1;
    if (fstat(fd, &identity) < 0 || (kind == KIND_FILE && operation == OP_EXPORT ? !same_version(&identity, &cap->identity) : !same_inode(&identity, &cap->identity))) {
      close(fd); errno = ESTALE; return -1;
    }
    response_fd = fd;
    *output_length = encode_stat(response_bytes + 12, &identity); return 0;
  }
  if (operation == OP_READ || operation == OP_EXPECTED) {
    if (take_u32(input, &offset) < 0 || take_u32(input, &maximum) < 0 || finish(input) < 0) return -1;
    if (maximum > PACKET_LIMIT - 12 || maximum == 0) { errno = EFBIG; return -1; }
    int fd = -1;
    if (operation == OP_EXPECTED && cap->kind == KIND_GUARD && cap->snapshot >= 0) fd = fcntl(cap->snapshot, F_DUPFD_CLOEXEC, 4);
    else if (operation == OP_READ && (cap->kind == KIND_FILE ||
        (cap->kind == KIND_ENTRY && S_ISREG(cap->identity.st_mode)))) fd = reopen_regular_or_directory(cap->target.fd, O_RDONLY);
    else { errno = EINVAL; return -1; }
    if (fd < 0) return -1;
    struct stat before, after;
    if (fstat(fd, &before) < 0 || (operation == OP_READ && !same_version(&before, &cap->identity))) {
      close(fd); errno = ESTALE; return -1;
    }
    ssize_t count = pread(fd, response_bytes + 12, maximum, offset);
    int saved = errno;
    if (count >= 0 && (fstat(fd, &after) < 0 || !same_version(&before, &after))) { count = -1; saved = ESTALE; }
    close(fd); errno = saved;
    if (count < 0) return -1;
    *output_length = (size_t)count; return 0;
  }
  if (operation == OP_LIST) {
    if (cap->kind != KIND_DIRECTORY || take_u32(input, &maximum) < 0 || finish(input) < 0 || maximum > 512 || maximum == 0) { errno = EINVAL; return -1; }
    if (cap->directory == NULL) {
      int fd = reopen_regular_or_directory(cap->target.fd, O_RDONLY);
      if (fd < 0) return -1;
      cap->directory = fdopendir(fd);
      if (cap->directory == NULL) { close(fd); return -1; }
    }
    size_t size = 4; uint32_t count = 0;
    while (count < maximum && size + NAME_LIMIT + 8 < PACKET_LIMIT - 12) {
      errno = 0; struct dirent *entry = readdir(cap->directory);
      if (entry == NULL) { if (errno != 0) return -1; break; }
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
      size_t length = strlen(entry->d_name);
      put_u32(response_bytes + 12 + size, (uint32_t)length); size += 4;
      memcpy(response_bytes + 12 + size, entry->d_name, length); size += length;
      put_u32(response_bytes + 12 + size, entry->d_type); size += 4; count++;
    }
    put_u32(response_bytes + 12, count); *output_length = size; return 0;
  }
  if (operation == OP_APPEND) {
    if (cap->kind != KIND_CONTENT || cap->sealed || take_u32(input, &offset) < 0) { errno = EINVAL; return -1; }
    size_t length = input->length - input->offset;
    if (offset != cap->retained || length + cap->retained > CONTENT_LIMIT || length + retained_bytes > RETAINED_LIMIT) { errno = EFBIG; return -1; }
    ssize_t written = pwrite(cap->target.fd, input->bytes + input->offset, length, offset);
    if (written < 0) return -1;
    cap->retained += (size_t)written; retained_bytes += (size_t)written;
    if ((size_t)written != length) { errno = EIO; return -1; }
    return 0;
  }
  if (operation == OP_SEAL) {
    if (cap->kind != KIND_CONTENT || finish(input) < 0 || fcntl(cap->target.fd, F_ADD_SEALS, ALL_SEALS) < 0) return -1;
    cap->sealed = true; return 0;
  }
  if (operation == OP_REMOVE_SYMLINK || operation == OP_REMOVE_DIRECTORY || operation == OP_RENAME_FILE) {
    if (cap->kind != KIND_ENTRY) { errno = EINVAL; return -1; }
    char *destination = take_string(input);
    if (destination == NULL) return -1;
    if (!valid_name(destination) || strcmp(destination, cap->target.name) == 0) { free(destination); errno = EINVAL; return -1; }
    int result = -1, expected = -1;
    if (operation == OP_RENAME_FILE) {
      uint32_t content_id;
      if (!S_ISREG(cap->identity.st_mode) || take_u32(input, &content_id) < 0 ||
          expected_content(content_id, &expected) < 0 || expected < 0) { free(destination); errno = EINVAL; return -1; }
    } else if ((operation == OP_REMOVE_SYMLINK && !S_ISLNK(cap->identity.st_mode)) ||
               (operation == OP_REMOVE_DIRECTORY && !S_ISDIR(cap->identity.st_mode)) ||
               strncmp(destination, ".agenc-delete-", 14) != 0) { free(destination); errno = EINVAL; return -1; }
    if (finish(input) < 0 || entry_current(cap, operation == OP_RENAME_FILE) < 0) goto entry_finished;
    if (operation == OP_RENAME_FILE) {
      int readable = reopen_regular_or_directory(cap->target.fd, O_RDONLY);
      if (readable < 0) goto entry_finished;
      result = compare_bytes(readable, expected); int saved = errno;
      close(readable); errno = saved;
      if (result < 0 || entry_current(cap, true) < 0) { result = -1; goto entry_finished; }
    }
    result = move_entry(cap, destination);
    if (result < 0) goto entry_finished;
    if (operation == OP_RENAME_FILE) {
      if (fstat(cap->target.fd, &identity) < 0) { result = -1; goto entry_finished; }
      *output_length = encode_stat(response_bytes + 12, &identity);
    } else {
      int parent = cap->target.parent.fds[cap->target.parent.count - 1];
      size_t work = 0;
      if (operation == OP_REMOVE_DIRECTORY) result = remove_tree(cap->target.fd, 0, &work);
      if (result == 0) result = named_inode(parent, destination, &cap->identity);
      if (result == 0) result = unlinkat(parent, destination, operation == OP_REMOVE_DIRECTORY ? AT_REMOVEDIR : 0);
      if (result == 0) result = sync_directory(parent);
    }
entry_finished:
    { int saved = errno; free(destination); errno = saved; return result; }
  }
  if (operation == OP_ASSERT || operation == OP_WRITE || operation == OP_REMOVE) {
    uint32_t expected_id, content_id = 0; int expected;
    if (cap->kind != KIND_GUARD || take_u32(input, &expected_id) < 0 || expected_content(expected_id, &expected) < 0) return -1;
    if (operation == OP_WRITE && take_u32(input, &content_id) < 0) return -1;
    if (finish(input) < 0 || guard_current(cap, expected) < 0) return -1;
    if (operation == OP_ASSERT) return 0;
    int parent = cap->target.parent.fds[cap->target.parent.count - 1];
    if (operation == OP_REMOVE) {
      if (expected < 0) { errno = EINVAL; return -1; }
      mutation_started = true;
      if (unlinkat(parent, cap->target.name, 0) < 0) return -1;
      close(cap->target.fd); cap->target.fd = -1; cap->existed = false; return 0;
    }
    int content;
    if (expected_content(content_id, &content) < 0 || content < 0 || fstat(content, &identity) < 0) { errno = EINVAL; return -1; }
    if (expected < 0 && create_guard_parents(cap) < 0) return -1;
    parent = cap->target.parent.fds[cap->target.parent.count - 1];
    bool earlier_effect = mutation_started;
    int writable;
    if (expected < 0) {
      mutation_started = true;
      writable = confined_component(parent, cap->target.name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0666);
    } else {
      writable = reopen_regular_or_directory(cap->target.fd, O_RDWR);
      if (writable >= 0 && compare_bytes(writable, expected) < 0) { close(writable); return -1; }
      if (writable >= 0) mutation_started = true;
    }
    if (writable < 0) {
      if (errno == EEXIST) mutation_started = earlier_effect;
      return -1;
    }
    if (expected < 0) {
      /* Retain the created inode even after a partial write, so observation and
       * rollback address this effect. A formerly unlinked target may still be
       * held by the guard and must not receive a later write accidentally. */
      int created = fcntl(writable, F_DUPFD_CLOEXEC, 4);
      if (created < 0) { close(writable); return -1; }
      if (cap->target.fd >= 0) close(cap->target.fd);
      cap->target.fd = created;
      if (fstat(writable, &cap->identity) < 0) { close(writable); return -1; }
      cap->existed = true;
    }
    int result = copy_bytes(content, writable, identity.st_size);
    if (result == 0) result = ftruncate(writable, identity.st_size);
    if (result == 0) result = fsync(writable);
    if (result == 0) result = fstat(writable, &cap->identity);
    if (result == 0 && expected < 0) result = sync_directory(parent);
    int saved = errno; close(writable); errno = saved;
    if (result < 0 || cap->target.fd < 0) return -1;
    cap->existed = true; *output_length = encode_stat(response_bytes + 12, &cap->identity); return 0;
  }
  errno = EOPNOTSUPP; return -1;
}

#define ALLOW_SYSCALL(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
static int restrict_worker(void) {
  uint32_t kept = (1U << CAP_DAC_OVERRIDE) | (1U << CAP_DAC_READ_SEARCH) | (1U << CAP_FOWNER);
  gid_t group = 0;
  if (setgroups(1, &group) < 0 || setgid(0) < 0 || setuid(0) < 0) return -1;
  for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
    if (capability < 32 && (kept & (1U << capability))) continue;
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) < 0) return -1;
  }
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{ .effective = kept, .permitted = kept }, {0}};
  if (syscall(SYS_capset, &header, data) < 0 || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
#if defined(__x86_64__)
  const uint32_t architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const uint32_t architecture = AUDIT_ARCH_AARCH64;
#else
#error Unsupported protected filesystem worker architecture
#endif
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    ALLOW_SYSCALL(SYS_read), ALLOW_SYSCALL(SYS_write), ALLOW_SYSCALL(SYS_close),
    ALLOW_SYSCALL(SYS_recvmsg), ALLOW_SYSCALL(SYS_sendmsg), ALLOW_SYSCALL(SYS_fstat),
    ALLOW_SYSCALL(SYS_fstatfs), ALLOW_SYSCALL(SYS_fcntl), ALLOW_SYSCALL(SYS_openat2),
    ALLOW_SYSCALL(SYS_readlinkat), ALLOW_SYSCALL(SYS_getdents64), ALLOW_SYSCALL(SYS_lseek),
    ALLOW_SYSCALL(SYS_pread64), ALLOW_SYSCALL(SYS_pwrite64), ALLOW_SYSCALL(SYS_ftruncate),
    ALLOW_SYSCALL(SYS_fsync), ALLOW_SYSCALL(SYS_unlinkat), ALLOW_SYSCALL(SYS_memfd_create),
    ALLOW_SYSCALL(SYS_mkdirat),
    ALLOW_SYSCALL(SYS_renameat2),
    ALLOW_SYSCALL(SYS_brk), ALLOW_SYSCALL(SYS_mmap), ALLOW_SYSCALL(SYS_munmap),
    ALLOW_SYSCALL(SYS_getrandom),
    ALLOW_SYSCALL(SYS_mremap), ALLOW_SYSCALL(SYS_mprotect), ALLOW_SYSCALL(SYS_futex),
    ALLOW_SYSCALL(SYS_rt_sigreturn), ALLOW_SYSCALL(SYS_exit), ALLOW_SYSCALL(SYS_exit_group),
#ifdef SYS_newfstatat
    ALLOW_SYSCALL(SYS_newfstatat),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS)
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1 || geteuid() != 0) return 125;
  unsigned char boot[4]; int fds[4]; size_t count;
  if (receive_packet(boot, sizeof(boot), fds, &count) != 4 || count != 2 || memcmp(boot, "AFS1", 4) != 0) return 125;
  root_fd = fds[0];
  struct stat root;
  if (fstat(root_fd, &root) < 0 || !S_ISDIR(root.st_mode) ||
      setns(fds[1], CLONE_NEWNS) < 0 || fchdir(root_fd) < 0 || chroot(".") < 0 || chdir("/") < 0) return 125;
  close(fds[1]);
  /* Task file creation must not inherit the controller service's private umask. */
  umask(0022);
  if (restrict_worker() < 0) return 125;
  request_id = 0; put_u32(response_bytes + 12, WORKER_PROTOCOL_VERSION);
  if (respond(0, 4) < 0) return 125;
  for (;;) {
    ssize_t length = receive_packet(request_bytes, sizeof(request_bytes), fds, &count);
    for (size_t i = 0; i < count; i++) close(fds[i]);
    if (length == 0) return 0;
    if (length < 8 || count != 0) return 125;
    request_id = get_u32(request_bytes); uint32_t operation = get_u32(request_bytes + 4);
    struct cursor input = { .bytes = request_bytes + 8, .length = (size_t)length - 8, .offset = 0 };
    size_t output_length = 0; mutation_started = false; response_fd = -1;
    int result = dispatch(operation, &input, &output_length);
    int sent = respond(result < 0 ? (uint32_t)(errno == 0 ? EIO : errno) : 0, result < 0 ? 0 : output_length);
    if (response_fd >= 0) close(response_fd);
    response_fd = -1;
    if (sent < 0) return 125;
  }
}
