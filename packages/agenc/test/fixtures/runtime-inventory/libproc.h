/* Minimal libproc test interface for exercising the probe on Linux.
 * This is a behavioral fixture, not a substitute for macOS ABI validation. */
#include <stdint.h>
#include <sys/types.h>
#define PROC_ALL_PIDS 1
#define PROC_PIDTBSDINFO 3
#define PROC_PIDLISTFDS 1
#define PROC_PIDVNODEPATHINFO 9
#define PROC_PIDREGIONPATHINFO 8
#define PROC_PIDFDVNODEPATHINFO 2
#define PROX_FDTYPE_VNODE 1
struct fixture_stat { dev_t vst_dev; ino_t vst_ino; mode_t vst_mode; };
struct vnode_info { struct fixture_stat vi_stat; };
struct vnode_info_path { struct vnode_info vip_vi; char vip_path[1024]; };
struct proc_vnodepathinfo { struct vnode_info_path pvi_cdir, pvi_rdir; };
struct proc_bsdinfo { uid_t pbi_uid; };
struct proc_fdinfo { int proc_fd; uint32_t proc_fdtype; };
struct vnode_fdinfowithpath { struct vnode_info_path pvip; };
struct proc_regioninfo { uint64_t pri_address, pri_size; };
struct proc_regionwithpathinfo { struct proc_regioninfo prp_prinfo; struct vnode_info_path prp_vip; };
int proc_listpids(uint32_t, uint32_t, void *, int);
int proc_pidinfo(int, int, uint64_t, void *, int);
int proc_pidfdinfo(int, int, int, void *, int);
