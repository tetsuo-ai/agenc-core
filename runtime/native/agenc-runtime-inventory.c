/*
 * macOS runtime usage probe. libproc supplies paths directly from each process;
 * unlike lsof, this never enumerates mounts or stats unrelated mountpoints. Only paths
 * inside the supplied runtime root are emitted. The caller owns the deadline:
 * even a libproc call stuck in kernel I/O must not delay an install indefinitely.
 *
 * Keep the same visibility as unprivileged lsof: command lines are collected by
 * ps in the caller; this probe covers accessible cwd/root, vnode descriptors
 * and file-backed mappings (including executable text and native addons).
 * Any unexpected error makes the entire inventory inconclusive.
 */
#include <errno.h>
#include <fts.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define BUFFER_LIMIT (16 * 1024 * 1024)
#define REGION_LIMIT 1000000

static const char *runtime_root;
static size_t root_length;
struct identity { dev_t device; ino_t inode; char *path; };
static struct identity *identities;
static size_t identity_count;

static void fail(const char *message) {
  fprintf(stderr, "agenc-runtime-inventory: %s\n", message);
  exit(1);
}

static int gone(pid_t pid) {
  return kill(pid, 0) == -1 && errno == ESRCH;
}

static void emit_path(const char *path, size_t capacity) {
  const char *end = memchr(path, '\0', capacity);
  if (end == NULL || end == path + capacity - 1) fail("possibly truncated path");
  if ((size_t)(end - path) < root_length ||
      strncmp(path, runtime_root, root_length) != 0 ||
      (path[root_length] != '/' && path[root_length] != '\0')) return;
  if (strchr(path, '\n') != NULL || strchr(path, '\r') != NULL) fail("ambiguous path");
  if (puts(path) == EOF) fail("cannot write path");
}

static int compare_identity(const void *left, const void *right) {
  const struct identity *a = left, *b = right;
  if (a->device != b->device) return a->device < b->device ? -1 : 1;
  return a->inode == b->inode ? 0 : a->inode < b->inode ? -1 : 1;
}

/* lsof +D also matches inode aliases. Retain that protection for a process
 * opening a hardlink outside the runtime root. Walk only the candidate root,
 * without following symlinks or descending into another filesystem. */
static void collect_identities(char *root) {
  char *paths[] = { root, NULL };
  FTS *walk = fts_open(paths, FTS_PHYSICAL | FTS_XDEV | FTS_NOCHDIR, NULL);
  if (walk == NULL) fail("cannot walk runtime root");
  FTSENT *entry;
  size_t capacity = 0;
  dev_t device = 0;
  for (;;) {
    errno = 0;
    entry = fts_read(walk);
    if (entry == NULL) { if (errno != 0) fail("incomplete runtime walk"); break; }
    if (entry->fts_info == FTS_DP) continue;
    if (entry->fts_info == FTS_ERR || entry->fts_info == FTS_DNR ||
        entry->fts_info == FTS_NS || entry->fts_info == FTS_DC) {
      fail("cannot inspect runtime entry");
    }
    if (entry->fts_level == 0) device = entry->fts_statp->st_dev;
    if (entry->fts_statp->st_dev != device) fail("runtime entry crosses filesystems");
    if (entry->fts_info == FTS_SL || entry->fts_info == FTS_SLNONE) continue;
    if (identity_count == capacity) {
      capacity = capacity == 0 ? 1024 : capacity * 2;
      if (capacity > 1048576) fail("runtime walk exhausted");
      void *grown = realloc(identities, capacity * sizeof(*identities));
      if (grown == NULL) fail("cannot allocate runtime identities");
      identities = grown;
    }
    char *path = strdup(entry->fts_path);
    if (path == NULL) fail("cannot allocate runtime path");
    identities[identity_count++] = (struct identity){ device, entry->fts_statp->st_ino, path };
  }
  if (fts_close(walk) != 0 || identity_count == 0) fail("cannot finish runtime walk");
  qsort(identities, identity_count, sizeof(*identities), compare_identity);
}

static void emit_vnode(const struct vnode_info_path *vnode) {
  emit_path(vnode->vip_path, sizeof(vnode->vip_path));
  struct identity key = { vnode->vip_vi.vi_stat.vst_dev, vnode->vip_vi.vi_stat.vst_ino, NULL };
  struct identity *found = bsearch(&key, identities, identity_count, sizeof(*identities), compare_identity);
  if (found == NULL) return;
  size_t i = (size_t)(found - identities);
  while (i > 0 && compare_identity(&identities[i - 1], &key) == 0) i--;
  for (; i < identity_count && compare_identity(&identities[i], &key) == 0; i++) {
    if (puts(identities[i].path) == EOF) fail("cannot write runtime identity");
  }
}

/* Leave spare slots so a growing process/descriptor list cannot be mistaken
 * for a complete snapshot. Retry with a larger buffer, with a hard size bound. */
static void *list(pid_t pid, int *used, int processes) {
  for (int capacity = 4096; capacity <= BUFFER_LIMIT; capacity *= 2) {
    void *buffer = malloc((size_t)capacity);
    if (buffer == NULL) fail("cannot allocate inventory");
    errno = 0;
    int size = processes
      ? proc_listpids(PROC_ALL_PIDS, 0, buffer, capacity)
      : proc_pidinfo(pid, PROC_PIDLISTFDS, 0, buffer, capacity);
    if (size < 0 || (size == 0 && errno != 0)) {
      free(buffer);
      if (!processes && gone(pid)) { *used = 0; return NULL; }
      fail("cannot enumerate processes or descriptors");
    }
    size_t slot = processes ? sizeof(pid_t) : sizeof(struct proc_fdinfo);
    if (size % (int)slot != 0) fail("incomplete inventory record");
    if (size < capacity - (int)slot) { *used = size; return buffer; }
    free(buffer);
  }
  fail("inventory buffer exhausted");
  return NULL;
}

static void inspect_process(pid_t pid) {
  struct proc_vnodepathinfo cwd;
  memset(&cwd, 0, sizeof(cwd));
  int size = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &cwd, sizeof(cwd));
  if (size != (int)sizeof(cwd)) {
    int denied = size <= 0 && (errno == EPERM || errno == EACCES);
    if (gone(pid)) return;
    /* Unprivileged lsof cannot inspect these processes either. Never ignore
     * an inaccessible process owned by this user or one with unknown owner. */
    if (denied) {
      struct proc_bsdinfo owner;
      int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &owner, sizeof(owner));
      if (bytes == (int)sizeof(owner) && owner.pbi_uid != getuid()) return;
    }
    fail("cannot inspect process directories");
  }
  emit_vnode(&cwd.pvi_cdir);
  emit_vnode(&cwd.pvi_rdir);

  int used;
  struct proc_fdinfo *fds = list(pid, &used, 0);
  for (size_t i = 0; i < (size_t)used / sizeof(*fds); i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    struct vnode_fdinfowithpath file;
    memset(&file, 0, sizeof(file));
    size = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &file, sizeof(file));
    if (size != (int)sizeof(file)) {
      /* A descriptor may close or be revoked between enumeration and lookup. */
      if (size <= 0 && (errno == EBADF || errno == ENOENT || gone(pid))) continue;
      fail("cannot inspect open file");
    }
    if (file.pvip.vip_path[0] == '\0') fail("open file path unavailable");
    emit_vnode(&file.pvip);
  }
  free(fds);

  uint64_t address = 0;
  for (int i = 0; i < REGION_LIMIT; i++) {
    struct proc_regionwithpathinfo region;
    memset(&region, 0, sizeof(region));
#ifdef PROC_PIDREGIONPATHINFO2
    size = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO2, address, &region, sizeof(region));
#else
    size = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region));
#endif
    if (size <= 0 && (errno == EINVAL || gone(pid))) return;
    if (size != (int)sizeof(region)) fail("cannot inspect mapped file");
    if (region.prp_vip.vip_path[0] == '\0' && region.prp_vip.vip_vi.vi_stat.vst_mode != 0) {
      fail("mapped file path unavailable");
    }
    emit_vnode(&region.prp_vip);
    uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
    if (next <= address || next < region.prp_prinfo.pri_address) fail("invalid memory region");
    address = next;
  }
  fail("mapped file inventory exhausted");
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] != '/') fail("expected an absolute runtime root");
  runtime_root = argv[1];
  root_length = strlen(runtime_root);
  if (root_length < 2 || runtime_root[root_length - 1] == '/' ||
      strchr(runtime_root, '\n') != NULL || strchr(runtime_root, '\r') != NULL) fail("invalid runtime root");
  collect_identities(argv[1]);
  int used;
  pid_t *pids = list(0, &used, 1);
  if (used == 0) fail("empty process inventory");
  for (size_t i = 0; i < (size_t)used / sizeof(*pids); i++) {
    if (pids[i] > 0) inspect_process(pids[i]);
  }
  free(pids);
  if (puts("AGENC_RUNTIME_INVENTORY_OK") == EOF || fflush(stdout) != 0) fail("cannot finish inventory");
  return 0;
}
