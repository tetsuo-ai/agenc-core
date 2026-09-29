/* Linux-only diagnostic preload. Records syscall timing and byte counts,
 * never data or filenames. Compile: cc -shared -fPIC -O2 native-io.c -o native-io.so
 * Opt in with LD_PRELOAD and AGENC_RUNTIME_TIMING (task-owned absolute prefix).
 * Kept separate from production code; use only for diagnostic replay runs.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}
static void record(const char *name, int fd, double start, long result, long bytes) {
  int saved = errno;
  double elapsed = now()-start;
  const char *prefix = getenv("AGENC_RUNTIME_TIMING");
  if (prefix && *prefix) {
    struct stat st;
    if (fstat(fd, &st) == 0 && !S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) { errno=saved; return; }
    char link[64], target[4096];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(link, target, sizeof(target)-1);
    if (length > 0) {
      target[length]=0;
      if (strncmp(target,prefix,strlen(prefix))==0) { errno=saved; return; }
    }
    char path[4096], line[512];
    int n = snprintf(path, sizeof(path), "%s.%d.native.jsonl", prefix, getpid());
    if (n > 0 && n < (int)sizeof(path)) {
      int out = syscall(SYS_openat, AT_FDCWD, path, O_WRONLY|O_APPEND|O_CREAT|O_CLOEXEC, 0600);
      if (out >= 0) {
        n = snprintf(line, sizeof(line), "{\"name\":\"native.%s\",\"pid\":%d,\"fd\":%d,\"start_ms\":%.6f,\"duration_ms\":%.6f,\"result\":%ld,\"bytes\":%ld}\n", name, getpid(), fd, start, elapsed, result, bytes);
        if (n > 0 && n < (int)sizeof(line)) syscall(SYS_write, out, line, n);
        syscall(SYS_close, out);
      }
    }
  }
  errno = saved;
}
int fsync(int fd) { double t=now(); int r=syscall(SYS_fsync,fd); record("fsync",fd,t,r,0); return r; }
int fdatasync(int fd) { double t=now(); int r=syscall(SYS_fdatasync,fd); record("fdatasync",fd,t,r,0); return r; }
ssize_t write(int fd,const void *buf,size_t count) { double t=now(); ssize_t r=syscall(SYS_write,fd,buf,count); record("write",fd,t,r,r>0?r:0); return r; }
ssize_t pwrite(int fd,const void *buf,size_t count,off_t offset) { double t=now(); ssize_t r=syscall(SYS_pwrite64,fd,buf,count,offset); record("pwrite",fd,t,r,r>0?r:0); return r; }
ssize_t pwrite64(int fd,const void *buf,size_t count,off64_t offset) { return pwrite(fd,buf,count,offset); }
ssize_t writev(int fd,const struct iovec *iov,int count) { double t=now(); ssize_t r=syscall(SYS_writev,fd,iov,count); record("writev",fd,t,r,r>0?r:0); return r; }
