#include "libproc.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int scenario(const char *name) {
  return strcmp(getenv("PROBE_SCENARIO"), name) == 0;
}
static void vnode(struct vnode_info_path *out, const char *name) {
  struct stat status;
  if (stat(name, &status) != 0) exit(97);
  out->vip_vi.vi_stat.vst_dev = status.st_dev;
  out->vip_vi.vi_stat.vst_ino = status.st_ino;
  out->vip_vi.vi_stat.vst_mode = status.st_mode;
  snprintf(out->vip_path, sizeof(out->vip_path), "%s", name);
}

int proc_listpids(uint32_t type, uint32_t uid, void *buffer, int capacity) {
  if (type != PROC_ALL_PIDS || uid != 0) exit(98);
  if (scenario("full-pids")) return capacity;
  if (scenario("empty-pids")) return 0;
  *(pid_t *)buffer = getpid();
  return sizeof(pid_t);
}
int proc_pidinfo(int pid, int flavor, uint64_t address, void *buffer, int capacity) {
  if (pid != getpid()) exit(99);
  if (flavor == PROC_PIDTBSDINFO) {
    ((struct proc_bsdinfo *)buffer)->pbi_uid = scenario("other-user") ? getuid() + 1 : getuid();
    return sizeof(struct proc_bsdinfo);
  }
  if (scenario("denied") || scenario("other-user")) { errno = EPERM; return 0; }
  if (scenario("short")) return 1;
  if (flavor == PROC_PIDVNODEPATHINFO) {
    struct proc_vnodepathinfo *out = buffer;
    if (scenario("cwd")) vnode(&out->pvi_cdir, getenv("PROBE_PATH"));
    return sizeof(*out);
  }
  if (flavor == PROC_PIDLISTFDS) {
    if (scenario("full-fds")) return capacity;
    if (scenario("fd") || scenario("truncated") || scenario("closed") || scenario("revoked")) {
      struct proc_fdinfo *out = buffer;
      out->proc_fd = 7; out->proc_fdtype = PROX_FDTYPE_VNODE;
      return sizeof(*out);
    }
    return 0;
  }
  if (flavor == PROC_PIDREGIONPATHINFO) {
    if ((scenario("mapping") || scenario("stalled-region")) && address == 0) {
      struct proc_regionwithpathinfo *out = buffer;
      vnode(&out->prp_vip, getenv("PROBE_PATH"));
      out->prp_prinfo.pri_address = 0;
      out->prp_prinfo.pri_size = scenario("stalled-region") ? 0 : 4096;
      return sizeof(*out);
    }
    errno = EINVAL; return 0;
  }
  exit(96);
}
int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int capacity) {
  (void)pid; (void)fd; (void)flavor; (void)capacity;
  if (scenario("closed")) { errno = EBADF; return 0; }
  if (scenario("revoked")) { errno = ENOENT; return 0; }
  struct vnode_fdinfowithpath *out = buffer;
  vnode(&out->pvip, getenv("PROBE_PATH"));
  if (scenario("truncated")) memset(out->pvip.vip_path, 'a', sizeof(out->pvip.vip_path));
  return sizeof(*out);
}
