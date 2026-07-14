#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <linux/ptrace.h>
#include <linux/sched.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/uio.h>
#if defined(__x86_64__)
#include <sys/user.h>
#elif defined(__aarch64__)
#include <asm/ptrace.h>
#include <elf.h>
#endif
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__)
#define AGENC_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AGENC_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "AgenC hermetic network boundary supports Linux x86_64 and aarch64"
#endif

#define AGENC_BOUNDARY_VIOLATION_EXIT 97
#define AGENC_MAX_TRACED_TASKS 8192
#define AGENC_ARRAY_LENGTH(value) (sizeof(value) / sizeof((value)[0]))

struct traced_task {
  pid_t pid;
  int newborn;
};

static struct traced_task traced_tasks[AGENC_MAX_TRACED_TASKS];
static size_t traced_task_count = 0;
static volatile sig_atomic_t forwarded_signal = 0;
static int boundary_failed = 0;
static int boundary_fatal = 0;

static void handle_signal(int signal_number) {
  forwarded_signal = signal_number;
}

static void add_traced_task(pid_t pid, int newborn) {
  size_t index;
  for (index = 0; index < traced_task_count; index += 1) {
    if (traced_tasks[index].pid == pid) {
      if (newborn != 0) {
        traced_tasks[index].newborn = 1;
      }
      return;
    }
  }
  if (traced_task_count >= AGENC_MAX_TRACED_TASKS) {
    fprintf(stderr, "AGENC_OS_NETWORK_BOUNDARY_ERROR task limit exceeded\n");
    boundary_fatal = 1;
    return;
  }
  traced_tasks[traced_task_count].pid = pid;
  traced_tasks[traced_task_count].newborn = newborn;
  traced_task_count += 1;
}

static int consume_newborn(pid_t pid) {
  size_t index;
  for (index = 0; index < traced_task_count; index += 1) {
    if (traced_tasks[index].pid == pid) {
      int newborn = traced_tasks[index].newborn;
      traced_tasks[index].newborn = 0;
      return newborn;
    }
  }
  add_traced_task(pid, 0);
  return 0;
}

static void remove_traced_task(pid_t pid) {
  size_t index;
  for (index = 0; index < traced_task_count; index += 1) {
    if (traced_tasks[index].pid == pid) {
      traced_tasks[index] = traced_tasks[traced_task_count - 1];
      traced_task_count -= 1;
      return;
    }
  }
}

static void kill_all_traced_tasks(void) {
  size_t index;
  for (index = 0; index < traced_task_count; index += 1) {
    (void)kill(traced_tasks[index].pid, SIGKILL);
  }
}

static void close_inherited_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) {
    return;
  }
#endif
  {
    long limit = sysconf(_SC_OPEN_MAX);
    int descriptor;
    if (limit < 0 || limit > 1048576L) {
      limit = 65536L;
    }
    for (descriptor = 3; descriptor < (int)limit; descriptor += 1) {
      (void)close(descriptor);
    }
  }
}

static int read_tracee_memory(
  pid_t pid,
  uint64_t remote_address,
  void *destination,
  size_t length
) {
  size_t offset = 0;
  unsigned char *bytes = destination;
  while (offset < length) {
    long word;
    size_t chunk = sizeof(word);
    errno = 0;
    word = ptrace(
      PTRACE_PEEKDATA,
      pid,
      (void *)(uintptr_t)(remote_address + offset),
      NULL
    );
    if (word == -1 && errno != 0) {
      return -1;
    }
    if (chunk > length - offset) {
      chunk = length - offset;
    }
    memcpy(bytes + offset, &word, chunk);
    offset += chunk;
  }
  return 0;
}

/*
 * A seccomp TRACE stop occurs before the syscall executes. Replacing its
 * number with -1 makes the kernel return ENOSYS to the tracee, so code may
 * catch the failure while the supervisor retains a sticky failing outcome.
 */
static int deny_current_syscall(pid_t pid) {
#if defined(__x86_64__)
  struct user_regs_struct registers;
  if (ptrace(PTRACE_GETREGS, pid, NULL, &registers) != 0) {
    return -1;
  }
  registers.orig_rax = (unsigned long)-1;
  if (ptrace(PTRACE_SETREGS, pid, NULL, &registers) != 0) {
    return -1;
  }
  return 0;
#elif defined(__aarch64__)
  struct user_pt_regs registers;
  struct iovec registers_view = {
    .iov_base = &registers,
    .iov_len = sizeof(registers),
  };
  if (ptrace(PTRACE_GETREGSET, pid, (void *)(intptr_t)NT_PRSTATUS, &registers_view) != 0) {
    return -1;
  }
  registers.regs[8] = UINT64_MAX;
  if (ptrace(PTRACE_SETREGSET, pid, (void *)(intptr_t)NT_PRSTATUS, &registers_view) != 0) {
    return -1;
  }
  return 0;
#endif
}

static void encode_hex(
  const unsigned char *input,
  size_t input_length,
  char *output,
  size_t output_length
) {
  static const char alphabet[] = "0123456789abcdef";
  size_t input_index;
  size_t output_index = 0;
  if (output_length == 0) {
    return;
  }
  for (
    input_index = 0;
    input_index < input_length && output_index + 2 < output_length;
    input_index += 1
  ) {
    unsigned char value = input[input_index];
    output[output_index++] = alphabet[value >> 4];
    output[output_index++] = alphabet[value & 0x0f];
  }
  output[output_index] = '\0';
}

static void read_process_executable(
  pid_t pid,
  char *executable_hex,
  size_t executable_hex_length
) {
  char proc_path[64];
  unsigned char raw[256];
  ssize_t length;
  (void)snprintf(proc_path, sizeof(proc_path), "/proc/%ld/exe", (long)pid);
  length = readlink(proc_path, (char *)raw, sizeof(raw));
  if (length > 0) {
    encode_hex(raw, (size_t)length, executable_hex, executable_hex_length);
  } else {
    (void)snprintf(executable_hex, executable_hex_length, "unavailable");
  }
}

static int report_violation(pid_t pid, const char *syscall_name, const char *detail) {
  char executable_hex[513];
  read_process_executable(pid, executable_hex, sizeof(executable_hex));
  fprintf(
    stderr,
    "AGENC_OS_NETWORK_BOUNDARY_VIOLATION pid=%ld syscall=%s target=%s exe_hex=%s\n",
    (long)pid,
    syscall_name,
    detail,
    executable_hex
  );
  fflush(stderr);
  return -1;
}

static int is_allowed_ipv4(const struct in_addr *address) {
  uint32_t host_address = ntohl(address->s_addr);
  return host_address == INADDR_ANY || (host_address >> 24) == 127U;
}

static int is_allowed_ipv6(const struct in6_addr *address) {
  if (IN6_IS_ADDR_UNSPECIFIED(address) || IN6_IS_ADDR_LOOPBACK(address)) {
    return 1;
  }
  if (IN6_IS_ADDR_V4MAPPED(address)) {
    struct in_addr mapped;
    memcpy(&mapped.s_addr, &address->s6_addr[12], sizeof(mapped.s_addr));
    return is_allowed_ipv4(&mapped);
  }
  return 0;
}

static int inspect_private_unix_path(
  pid_t pid,
  const char *syscall_name,
  const char *root_path,
  const char *relative_path
) {
  struct open_how how = {
    .flags = O_PATH | O_CLOEXEC,
    .resolve =
      RESOLVE_BENEATH |
      RESOLVE_NO_MAGICLINKS |
      RESOLVE_NO_SYMLINKS |
      RESOLVE_NO_XDEV,
  };
  char parent_path[sizeof(((struct sockaddr_un *)0)->sun_path) + 1];
  char *last_separator;
  int root_descriptor;
  int target_descriptor;
  int saved_errno;

  root_descriptor = open(root_path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root_descriptor < 0) {
    return report_violation(
      pid,
      syscall_name,
      "private-unix-root-unavailable"
    );
  }
  target_descriptor = (int)syscall(
    SYS_openat2,
    root_descriptor,
    relative_path,
    &how,
    sizeof(how)
  );
  if (target_descriptor >= 0) {
    (void)close(target_descriptor);
    (void)close(root_descriptor);
    return 0;
  }
  saved_errno = errno;
  if (saved_errno == ELOOP) {
    (void)close(root_descriptor);
    return report_violation(pid, syscall_name, "unix-path-symlink");
  }
  if (saved_errno == EXDEV) {
    (void)close(root_descriptor);
    return report_violation(pid, syscall_name, "unix-path-mount-escape");
  }
  if (saved_errno == ENOSYS) {
    (void)close(root_descriptor);
    return report_violation(pid, syscall_name, "openat2-unavailable");
  }
  if (saved_errno != ENOENT && saved_errno != ENOTDIR) {
    (void)close(root_descriptor);
    return report_violation(pid, syscall_name, "unix-path-uninspectable");
  }

  (void)snprintf(parent_path, sizeof(parent_path), "%s", relative_path);
  last_separator = strrchr(parent_path, '/');
  if (last_separator == NULL) {
    (void)snprintf(parent_path, sizeof(parent_path), ".");
  } else {
    *last_separator = '\0';
  }
  target_descriptor = (int)syscall(
    SYS_openat2,
    root_descriptor,
    parent_path,
    &how,
    sizeof(how)
  );
  if (target_descriptor >= 0) {
    (void)close(target_descriptor);
    (void)close(root_descriptor);
    return 0;
  }
  saved_errno = errno;
  (void)close(root_descriptor);
  if (saved_errno == ENOENT || saved_errno == ENOTDIR) {
    /* The kernel will fail the original pathname operation without I/O. */
    return 0;
  }
  if (saved_errno == ELOOP) {
    return report_violation(pid, syscall_name, "unix-path-symlink");
  }
  if (saved_errno == EXDEV) {
    return report_violation(pid, syscall_name, "unix-path-mount-escape");
  }
  if (saved_errno == ENOSYS) {
    return report_violation(pid, syscall_name, "openat2-unavailable");
  }
  return report_violation(pid, syscall_name, "unix-path-uninspectable");
}

static int inspect_unix_address(
  pid_t pid,
  const char *syscall_name,
  const struct sockaddr_un *address,
  socklen_t address_length
) {
  char detail[160];
  size_t path_offset = offsetof(struct sockaddr_un, sun_path);
  size_t path_length;
  size_t text_length;
  char path[sizeof(address->sun_path) + 1];
  char private_alias[sizeof(path)];
  const char *inspection_path;
  size_t inspection_length;
  if ((size_t)address_length <= path_offset) {
    return 0;
  }
  path_length = (size_t)address_length - path_offset;
  if (path_length > sizeof(address->sun_path)) {
    return report_violation(pid, syscall_name, "oversized-unix-address");
  }
  memcpy(path, address->sun_path, path_length);
  path[path_length] = '\0';
  if (path[0] == '\0') {
    /* Linux abstract sockets are scoped to the container network namespace. */
    return 0;
  }
  text_length = strnlen(path, path_length);
  inspection_path = path;
  inspection_length = text_length;
  if (
    text_length == strlen("/var/run/nscd/socket") &&
    memcmp(path, "/var/run/nscd/socket", text_length) == 0
  ) {
    char alias_target[16];
    ssize_t alias_length = readlink(
      "/var/run",
      alias_target,
      sizeof(alias_target)
    );
    if (
      !(
        (alias_length == 6 && memcmp(alias_target, "../run", 6) == 0) ||
        (alias_length == 4 && memcmp(alias_target, "/run", 4) == 0)
      )
    ) {
      return report_violation(pid, syscall_name, "unsafe-var-run-alias");
    }
    {
      int written = snprintf(
        private_alias,
        sizeof(private_alias),
        "/run/%s",
        path + 9
      );
      if (written < 0 || (size_t)written >= sizeof(private_alias)) {
        return report_violation(pid, syscall_name, "oversized-var-run-alias");
      }
      inspection_path = private_alias;
      inspection_length = (size_t)written;
    }
  }
  if (
    !(
      (inspection_length > 5 && strncmp(inspection_path, "/tmp/", 5) == 0) ||
      (inspection_length > 5 && strncmp(inspection_path, "/run/", 5) == 0)
    )
  ) {
    size_t index;
    size_t used = (size_t)snprintf(
      detail,
      sizeof(detail),
      "unix-path-outside-private-tmp:hex="
    );
    for (
      index = 0;
      index < text_length && used + 2 < sizeof(detail);
      index += 1
    ) {
      int written = snprintf(
        detail + used,
        sizeof(detail) - used,
        "%02x",
        (unsigned int)(unsigned char)path[index]
      );
      if (written != 2) {
        break;
      }
      used += 2;
    }
    return report_violation(pid, syscall_name, detail);
  }
  {
    size_t index;
    size_t segment_start = 1;
    for (index = 1; index <= inspection_length; index += 1) {
      if (index == inspection_length || inspection_path[index] == '/') {
        size_t segment_length = index - segment_start;
        if (segment_length == 0) {
          return report_violation(pid, syscall_name, "unix-path-noncanonical");
        }
        if (
          (segment_length == 1 && inspection_path[segment_start] == '.') ||
          (segment_length == 2 &&
           inspection_path[segment_start] == '.' &&
           inspection_path[segment_start + 1] == '.')
        ) {
          return report_violation(pid, syscall_name, "unix-path-traversal");
        }
        segment_start = index + 1;
      }
    }
  }
  return inspect_private_unix_path(
    pid,
    syscall_name,
    strncmp(inspection_path, "/tmp/", 5) == 0 ? "/tmp" : "/run",
    inspection_path + 5
  );
}

static int inspect_socket_address(
  pid_t pid,
  const char *syscall_name,
  uint64_t remote_address,
  uint64_t remote_length
) {
  struct sockaddr_storage storage;
  socklen_t address_length;
  sa_family_t family;
  char printable[INET6_ADDRSTRLEN];
  if (remote_address == 0 || remote_length < sizeof(sa_family_t)) {
    return report_violation(pid, syscall_name, "missing-or-short-address");
  }
  if (remote_length > sizeof(storage)) {
    return report_violation(pid, syscall_name, "oversized-address");
  }
  memset(&storage, 0, sizeof(storage));
  address_length = (socklen_t)remote_length;
  if (read_tracee_memory(pid, remote_address, &storage, address_length) != 0) {
    return report_violation(pid, syscall_name, "unreadable-address");
  }
  family = storage.ss_family;
  if (family == AF_UNSPEC || family == AF_NETLINK) {
    return 0;
  }
  if (family == AF_UNIX) {
    return inspect_unix_address(
      pid,
      syscall_name,
      (const struct sockaddr_un *)&storage,
      address_length
    );
  }
  if (family == AF_INET) {
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)&storage;
    if (address_length < sizeof(*ipv4)) {
      return report_violation(pid, syscall_name, "short-ipv4-address");
    }
    if (is_allowed_ipv4(&ipv4->sin_addr)) {
      return 0;
    }
    if (inet_ntop(AF_INET, &ipv4->sin_addr, printable, sizeof(printable)) == NULL) {
      return report_violation(pid, syscall_name, "public-ipv4-address");
    }
    return report_violation(pid, syscall_name, printable);
  }
  if (family == AF_INET6) {
    const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)&storage;
    if (address_length < sizeof(*ipv6)) {
      return report_violation(pid, syscall_name, "short-ipv6-address");
    }
    if (is_allowed_ipv6(&ipv6->sin6_addr)) {
      return 0;
    }
    if (inet_ntop(AF_INET6, &ipv6->sin6_addr, printable, sizeof(printable)) == NULL) {
      return report_violation(pid, syscall_name, "public-ipv6-address");
    }
    return report_violation(pid, syscall_name, printable);
  }
  return report_violation(pid, syscall_name, "unsupported-address-family");
}

static int inspect_socket_creation(pid_t pid, const uint64_t arguments[6]) {
  int domain = (int)arguments[0];
  int socket_type = (int)arguments[1] & 0xf;
  if (domain == AF_UNIX) {
    return
      socket_type == SOCK_STREAM ||
      socket_type == SOCK_DGRAM ||
      socket_type == SOCK_SEQPACKET
        ? 0
        : report_violation(pid, "socket", "unsafe-unix-socket-type");
  }
  if (domain == AF_INET || domain == AF_INET6) {
    return socket_type == SOCK_STREAM || socket_type == SOCK_DGRAM
      ? 0
      : report_violation(pid, "socket", "unsafe-inet-socket-type");
  }
  if (domain == AF_NETLINK) {
    return socket_type == SOCK_RAW || socket_type == SOCK_DGRAM
      ? 0
      : report_violation(pid, "socket", "unsafe-netlink-socket-type");
  }
#ifdef AF_ALG
  if (domain == AF_ALG) {
    return socket_type == SOCK_SEQPACKET
      ? 0
      : report_violation(pid, "socket", "unsafe-alg-socket-type");
  }
#endif
  return report_violation(pid, "socket", "unsupported-network-family");
}

static int inspect_sendmsg(pid_t pid, const char *name, uint64_t remote_message) {
  struct msghdr message;
  if (remote_message == 0) {
    return report_violation(pid, name, "missing-message");
  }
  if (read_tracee_memory(pid, remote_message, &message, sizeof(message)) != 0) {
    return report_violation(pid, name, "unreadable-message");
  }
  if (message.msg_name == NULL || message.msg_namelen == 0) {
    /* Connected sockets were already inspected at connect(2). */
    return 0;
  }
  return inspect_socket_address(
    pid,
    name,
    (uint64_t)(uintptr_t)message.msg_name,
    message.msg_namelen
  );
}

static int inspect_sendmmsg(pid_t pid, const uint64_t arguments[6]) {
  uint64_t remote_messages = arguments[1];
  unsigned int count = (unsigned int)arguments[2];
  unsigned int index;
  if (remote_messages == 0 || count > 1024U) {
    return report_violation(pid, "sendmmsg", "invalid-message-vector");
  }
  for (index = 0; index < count; index += 1) {
    struct mmsghdr message;
    uint64_t address = remote_messages + ((uint64_t)index * sizeof(message));
    if (read_tracee_memory(pid, address, &message, sizeof(message)) != 0) {
      return report_violation(pid, "sendmmsg", "unreadable-message-vector");
    }
    if (message.msg_hdr.msg_name != NULL && message.msg_hdr.msg_namelen != 0) {
      if (
        inspect_socket_address(
          pid,
          "sendmmsg",
          (uint64_t)(uintptr_t)message.msg_hdr.msg_name,
          message.msg_hdr.msg_namelen
        ) != 0
      ) {
        return -1;
      }
    }
  }
  return 0;
}

static int is_membership_option(int level, int option_name) {
  if (level == IPPROTO_IP) {
    return
      option_name == IP_ADD_MEMBERSHIP ||
      option_name == IP_ADD_SOURCE_MEMBERSHIP ||
      option_name == IP_BLOCK_SOURCE;
  }
  if (level == IPPROTO_IPV6) {
    return option_name == IPV6_JOIN_GROUP;
  }
  return 0;
}

static int inspect_clone(pid_t pid, const char *name, uint64_t flags) {
  if ((flags & CLONE_UNTRACED) != 0) {
    return report_violation(pid, name, "CLONE_UNTRACED");
  }
  return 0;
}

static int inspect_clone3(pid_t pid, const uint64_t arguments[6]) {
  struct clone_args clone_arguments;
  size_t argument_size = (size_t)arguments[1];
  if (arguments[0] == 0 || argument_size < sizeof(clone_arguments.flags)) {
    return report_violation(pid, "clone3", "missing-clone-arguments");
  }
  memset(&clone_arguments, 0, sizeof(clone_arguments));
  if (argument_size > sizeof(clone_arguments)) {
    argument_size = sizeof(clone_arguments);
  }
  if (
    read_tracee_memory(pid, arguments[0], &clone_arguments, argument_size) != 0
  ) {
    return report_violation(pid, "clone3", "unreadable-clone-arguments");
  }
  return inspect_clone(pid, "clone3", clone_arguments.flags);
}

static int inspect_seccomp_event(pid_t pid) {
  struct ptrace_syscall_info syscall_info;
  uint64_t arguments[6];
  uint64_t syscall_number;
  long result;
  memset(&syscall_info, 0, sizeof(syscall_info));
  result = ptrace(
    PTRACE_GET_SYSCALL_INFO,
    pid,
    sizeof(syscall_info),
    &syscall_info
  );
  if (result < 0) {
    return report_violation(pid, "observer", "syscall-info-unavailable");
  }
  if (
    syscall_info.op != PTRACE_SYSCALL_INFO_SECCOMP ||
    syscall_info.arch != AGENC_AUDIT_ARCH
  ) {
    return report_violation(pid, "observer", "unexpected-syscall-architecture");
  }
  syscall_number = syscall_info.seccomp.nr;
  memcpy(arguments, syscall_info.seccomp.args, sizeof(arguments));

#ifdef __NR_socket
  if (syscall_number == __NR_socket) {
    return inspect_socket_creation(pid, arguments);
  }
#endif
#ifdef __NR_connect
  if (syscall_number == __NR_connect) {
    return inspect_socket_address(pid, "connect", arguments[1], arguments[2]);
  }
#endif
#ifdef __NR_bind
  if (syscall_number == __NR_bind) {
    return inspect_socket_address(pid, "bind", arguments[1], arguments[2]);
  }
#endif
#ifdef __NR_sendto
  if (syscall_number == __NR_sendto) {
    if (arguments[4] == 0 || arguments[5] == 0) {
      return 0;
    }
    return inspect_socket_address(pid, "sendto", arguments[4], arguments[5]);
  }
#endif
#ifdef __NR_sendmsg
  if (syscall_number == __NR_sendmsg) {
    return inspect_sendmsg(pid, "sendmsg", arguments[1]);
  }
#endif
#ifdef __NR_sendmmsg
  if (syscall_number == __NR_sendmmsg) {
    return inspect_sendmmsg(pid, arguments);
  }
#endif
#ifdef __NR_setsockopt
  if (syscall_number == __NR_setsockopt) {
    if (is_membership_option((int)arguments[1], (int)arguments[2])) {
      return report_violation(pid, "setsockopt", "multicast-membership");
    }
    return 0;
  }
#endif
#ifdef __NR_clone
  if (syscall_number == __NR_clone) {
    return inspect_clone(pid, "clone", arguments[0]);
  }
#endif
#ifdef __NR_clone3
  if (syscall_number == __NR_clone3) {
    return inspect_clone3(pid, arguments);
  }
#endif
#ifdef __NR_seccomp
  if (syscall_number == __NR_seccomp) {
    if ((unsigned int)arguments[0] == SECCOMP_SET_MODE_FILTER) {
      return report_violation(pid, "seccomp", "filter-replacement-attempt");
    }
    return 0;
  }
#endif
#ifdef __NR_prctl
  if (syscall_number == __NR_prctl) {
    if ((int)arguments[0] == PR_SET_SECCOMP) {
      return report_violation(pid, "prctl", "seccomp-replacement-attempt");
    }
    return 0;
  }
#endif
  return report_violation(pid, "observer", "unrecognized-filtered-syscall");
}

static int install_network_filter(void) {
  struct sock_filter filter[64];
  struct sock_fprog program;
  size_t length = 0;

#define REQUIRE_FILTER_CAPACITY() \
  do { \
    if (length >= AGENC_ARRAY_LENGTH(filter)) { \
      errno = E2BIG; \
      return -1; \
    } \
  } while (0)
#define APPEND_STATEMENT(code_value, constant_value) \
  do { \
    REQUIRE_FILTER_CAPACITY(); \
    filter[length++] = (struct sock_filter)BPF_STMT( \
      (code_value), \
      (constant_value) \
    ); \
  } while (0)
#define APPEND_JUMP(code_value, constant_value, true_offset, false_offset) \
  do { \
    REQUIRE_FILTER_CAPACITY(); \
    filter[length++] = (struct sock_filter)BPF_JUMP( \
      (code_value), \
      (constant_value), \
      (true_offset), \
      (false_offset) \
    ); \
  } while (0)
#define TRACE_SYSCALL(syscall_number) \
  do { \
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (syscall_number), 0, 1); \
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE); \
  } while (0)

  APPEND_STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AGENC_AUDIT_ARCH, 1, 0);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  APPEND_STATEMENT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));

#ifdef __X32_SYSCALL_BIT
  APPEND_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
#endif

#ifdef __NR_io_uring_setup
  APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA));
#endif
#ifdef __NR_bpf
  APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_bpf, 0, 1);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
#endif
#ifdef __NR_unshare
  APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_unshare, 0, 1);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
#endif
#ifdef __NR_setns
  APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setns, 0, 1);
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
#endif
#ifdef __NR_socket
  {
    size_t socket_check = length;
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 0);
    APPEND_STATEMENT(
      BPF_LD | BPF_W | BPF_ABS,
      offsetof(struct seccomp_data, args[0])
    );
#ifdef AF_ALG
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_ALG, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
#endif
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_NETLINK, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
    APPEND_STATEMENT(BPF_ST, 0);
    APPEND_STATEMENT(
      BPF_LD | BPF_W | BPF_ABS,
      offsetof(struct seccomp_data, args[1])
    );
    APPEND_STATEMENT(BPF_ALU | BPF_AND | BPF_K, 0xf);
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_RAW, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    APPEND_STATEMENT(BPF_LD | BPF_MEM, 0);
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
    APPEND_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 1);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
    APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    filter[socket_check].jf = (unsigned char)(length - socket_check - 1);
  }
#endif
#ifdef __NR_connect
  TRACE_SYSCALL(__NR_connect);
#endif
#ifdef __NR_bind
  TRACE_SYSCALL(__NR_bind);
#endif
#ifdef __NR_sendto
  TRACE_SYSCALL(__NR_sendto);
#endif
#ifdef __NR_sendmsg
  TRACE_SYSCALL(__NR_sendmsg);
#endif
#ifdef __NR_sendmmsg
  TRACE_SYSCALL(__NR_sendmmsg);
#endif
#ifdef __NR_setsockopt
  TRACE_SYSCALL(__NR_setsockopt);
#endif
#ifdef __NR_clone
  TRACE_SYSCALL(__NR_clone);
#endif
#ifdef __NR_clone3
  TRACE_SYSCALL(__NR_clone3);
#endif
#ifdef __NR_seccomp
  TRACE_SYSCALL(__NR_seccomp);
#endif
#ifdef __NR_prctl
  TRACE_SYSCALL(__NR_prctl);
#endif
  APPEND_STATEMENT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

#undef TRACE_SYSCALL
#undef APPEND_JUMP
#undef APPEND_STATEMENT
#undef REQUIRE_FILTER_CAPACITY

  program.len = (unsigned short)length;
  program.filter = filter;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return -1;
  }
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0) {
    return -1;
  }
  return 0;
}

static int run_native_canary(void) {
  pid_t child = fork();
  if (child < 0) {
    return 2;
  }
  if (child > 0) {
    /* Exit before the detached child attempts a caught public connect. */
    return 0;
  }
  (void)setsid();
  child = fork();
  if (child < 0) {
    _exit(2);
  }
  if (child > 0) {
    _exit(0);
  }
  (void)clearenv();
  (void)usleep(50000);
  {
    int descriptor = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (descriptor >= 0) {
      struct sockaddr_in destination;
      memset(&destination, 0, sizeof(destination));
      destination.sin_family = AF_INET;
      destination.sin_port = htons(9);
      (void)inet_pton(AF_INET, "192.0.2.1", &destination.sin_addr);
      (void)connect(
        descriptor,
        (const struct sockaddr *)&destination,
        sizeof(destination)
      );
      (void)close(descriptor);
    }
  }
  {
    int descriptor = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (descriptor >= 0) {
      const char payload[] = "agenc-hermetic-canary";
      struct sockaddr_in destination;
      memset(&destination, 0, sizeof(destination));
      destination.sin_family = AF_INET;
      destination.sin_port = htons(53);
      (void)inet_pton(AF_INET, "192.0.2.53", &destination.sin_addr);
      (void)sendto(
        descriptor,
        payload,
        sizeof(payload),
        0,
        (const struct sockaddr *)&destination,
        sizeof(destination)
      );
      (void)close(descriptor);
    }
  }
  _exit(0);
}

static int run_clone_untraced_canary(void) {
#ifdef __NR_clone
  long result = syscall(
    __NR_clone,
    (unsigned long)(CLONE_UNTRACED | SIGCHLD),
    NULL,
    NULL,
    NULL,
    0UL
  );
  if (result == 0) {
    _exit(0);
  }
  if (result > 0) {
    (void)waitpid((pid_t)result, NULL, 0);
  }
#endif
  return 0;
}

static int run_seccomp_replacement_canary(void) {
#ifdef __NR_seccomp
  struct sock_filter filter[] = {
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  (void)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
#endif
  return 0;
}

static int run_vsock_canary(void) {
#ifdef AF_VSOCK
  int descriptor = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor >= 0) {
    (void)close(descriptor);
  }
#endif
  return 0;
}

static int run_unix_broker_canary(void) {
  int descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor >= 0) {
    struct sockaddr_un destination;
    memset(&destination, 0, sizeof(destination));
    destination.sun_family = AF_UNIX;
    (void)snprintf(
      destination.sun_path,
      sizeof(destination.sun_path),
      "/workspace/host-broker.sock"
    );
    (void)connect(
      descriptor,
      (const struct sockaddr *)&destination,
      sizeof(destination)
    );
    (void)close(descriptor);
  }
  return 0;
}

static int run_unix_traversal_canary(void) {
  int descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor >= 0) {
    struct sockaddr_un destination;
    memset(&destination, 0, sizeof(destination));
    destination.sun_family = AF_UNIX;
    (void)snprintf(
      destination.sun_path,
      sizeof(destination.sun_path),
      "/tmp/../boundary/host-broker.sock"
    );
    (void)connect(
      descriptor,
      (const struct sockaddr *)&destination,
      sizeof(destination)
    );
    (void)close(descriptor);
  }
  return 0;
}

static int run_unix_symlink_canary(void) {
  const char *link_path = "/tmp/agenc-boundary-link";
  int descriptor;
  (void)unlink(link_path);
  if (symlink("/boundary", link_path) != 0) {
    return 2;
  }
  descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor >= 0) {
    struct sockaddr_un destination;
    memset(&destination, 0, sizeof(destination));
    destination.sun_family = AF_UNIX;
    (void)snprintf(
      destination.sun_path,
      sizeof(destination.sun_path),
      "%s/host-broker.sock",
      link_path
    );
    (void)connect(
      descriptor,
      (const struct sockaddr *)&destination,
      sizeof(destination)
    );
    (void)close(descriptor);
  }
  (void)unlink(link_path);
  return 0;
}

static int run_unix_noncanonical_canary(void) {
  int descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor >= 0) {
    struct sockaddr_un destination;
    memset(&destination, 0, sizeof(destination));
    destination.sun_family = AF_UNIX;
    (void)snprintf(
      destination.sun_path,
      sizeof(destination.sun_path),
      "/tmp//agenc-boundary.sock"
    );
    (void)connect(
      descriptor,
      (const struct sockaddr *)&destination,
      sizeof(destination)
    );
    (void)close(descriptor);
  }
  return 0;
}

static int run_unix_private_canary(void) {
  struct sockaddr_un address;
  char socket_path[sizeof(address.sun_path)];
  int listener = -1;
  int client = -1;
  int accepted = -1;
  int status = 2;

  socket_path[0] = '\0';
  client = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (client < 0) {
    goto cleanup;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(
    address.sun_path,
    sizeof(address.sun_path),
    "/var/run/nscd/socket"
  );
  (void)connect(client, (const struct sockaddr *)&address, sizeof(address));
  (void)close(client);
  client = -1;

  (void)snprintf(
    socket_path,
    sizeof(socket_path),
    "/tmp/agenc-boundary-private-%ld.sock",
    (long)getpid()
  );
  (void)unlink(socket_path);
  listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) {
    goto cleanup;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(
    address.sun_path,
    sizeof(address.sun_path),
    "%s",
    socket_path
  );
  if (
    bind(listener, (const struct sockaddr *)&address, sizeof(address)) != 0 ||
    listen(listener, 1) != 0
  ) {
    goto cleanup;
  }
  client = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (
    client < 0 ||
    connect(client, (const struct sockaddr *)&address, sizeof(address)) != 0
  ) {
    goto cleanup;
  }
  accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  if (accepted < 0) {
    goto cleanup;
  }
  status = 0;

cleanup:
  if (accepted >= 0) (void)close(accepted);
  if (client >= 0) (void)close(client);
  if (listener >= 0) (void)close(listener);
  if (socket_path[0] != '\0') (void)unlink(socket_path);
  return status;
}

static int run_sigtrap_canary(void) {
  (void)raise(SIGTRAP);
  return 0;
}

static int trace_command(char *const command[]) {
  pid_t primary;
  int status;
  int primary_status = 125;
  int primary_finished = 0;
  const long options =
    PTRACE_O_EXITKILL |
    PTRACE_O_TRACECLONE |
    PTRACE_O_TRACEEXEC |
    PTRACE_O_TRACEEXIT |
    PTRACE_O_TRACEFORK |
    PTRACE_O_TRACESECCOMP |
    PTRACE_O_TRACEVFORK;

  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    perror("AGENC_OS_NETWORK_BOUNDARY_ERROR subreaper");
    return 125;
  }
  primary = fork();
  if (primary < 0) {
    perror("AGENC_OS_NETWORK_BOUNDARY_ERROR fork");
    return 125;
  }
  if (primary == 0) {
    (void)setpgid(0, 0);
    close_inherited_descriptors();
    if (ptrace(PTRACE_TRACEME, 0, NULL, NULL) != 0) {
      perror("AGENC_OS_NETWORK_BOUNDARY_ERROR traceme");
      _exit(126);
    }
    (void)raise(SIGSTOP);
    if (install_network_filter() != 0) {
      perror("AGENC_OS_NETWORK_BOUNDARY_ERROR seccomp");
      _exit(126);
    }
    execvp(command[0], command);
    perror("AGENC_OS_NETWORK_BOUNDARY_ERROR exec");
    _exit(127);
  }

  add_traced_task(primary, 0);
  do {
    status = 0;
  } while (waitpid(primary, &status, 0) < 0 && errno == EINTR);
  if (!WIFSTOPPED(status) || WSTOPSIG(status) != SIGSTOP) {
    fprintf(stderr, "AGENC_OS_NETWORK_BOUNDARY_ERROR tracee did not stop\n");
    kill_all_traced_tasks();
    return 125;
  }
  if (ptrace(PTRACE_SETOPTIONS, primary, NULL, (void *)options) != 0) {
    perror("AGENC_OS_NETWORK_BOUNDARY_ERROR setoptions");
    kill_all_traced_tasks();
    return 125;
  }
  if (ptrace(PTRACE_CONT, primary, NULL, NULL) != 0) {
    perror("AGENC_OS_NETWORK_BOUNDARY_ERROR initial-continue");
    kill_all_traced_tasks();
    return 125;
  }

  for (;;) {
    pid_t stopped_pid;
    unsigned int event;
    int stop_signal;

    if (forwarded_signal != 0) {
      (void)kill(-primary, forwarded_signal);
      forwarded_signal = 0;
    }
    stopped_pid = waitpid(-1, &status, __WALL);
    if (stopped_pid < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == ECHILD) {
        break;
      }
      perror("AGENC_OS_NETWORK_BOUNDARY_ERROR waitpid");
      boundary_fatal = 1;
      kill_all_traced_tasks();
      continue;
    }
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (WIFSIGNALED(status) && WTERMSIG(status) == SIGSYS) {
        fprintf(
          stderr,
          "AGENC_OS_NETWORK_BOUNDARY_VIOLATION pid=%ld syscall=kernel-filter target=forbidden-network-channel\n",
          (long)stopped_pid
        );
        fflush(stderr);
        boundary_failed = 1;
      }
      if (stopped_pid == primary) {
        primary_finished = 1;
        primary_status = WIFEXITED(status)
          ? WEXITSTATUS(status)
          : 128 + WTERMSIG(status);
      }
      remove_traced_task(stopped_pid);
      continue;
    }
    if (!WIFSTOPPED(status)) {
      continue;
    }

    add_traced_task(stopped_pid, 0);
    if (boundary_fatal != 0) {
      (void)kill(stopped_pid, SIGKILL);
      (void)ptrace(PTRACE_CONT, stopped_pid, NULL, (void *)(intptr_t)SIGKILL);
      continue;
    }
    if (consume_newborn(stopped_pid) != 0) {
      (void)ptrace(PTRACE_CONT, stopped_pid, NULL, NULL);
      continue;
    }

    stop_signal = WSTOPSIG(status);
    event = (unsigned int)status >> 16;
    if (stop_signal == SIGTRAP && event == PTRACE_EVENT_SECCOMP) {
      if (inspect_seccomp_event(stopped_pid) != 0) {
        boundary_failed = 1;
        if (deny_current_syscall(stopped_pid) != 0) {
          perror("AGENC_OS_NETWORK_BOUNDARY_ERROR deny-syscall");
          boundary_fatal = 1;
          kill_all_traced_tasks();
          (void)ptrace(
            PTRACE_CONT,
            stopped_pid,
            NULL,
            (void *)(intptr_t)SIGKILL
          );
        } else {
          (void)ptrace(PTRACE_CONT, stopped_pid, NULL, NULL);
        }
      } else {
        (void)ptrace(PTRACE_CONT, stopped_pid, NULL, NULL);
      }
      continue;
    }
    if (
      stop_signal == SIGTRAP &&
      (event == PTRACE_EVENT_CLONE ||
       event == PTRACE_EVENT_FORK ||
       event == PTRACE_EVENT_VFORK)
    ) {
      unsigned long new_pid = 0;
      if (ptrace(PTRACE_GETEVENTMSG, stopped_pid, NULL, &new_pid) != 0) {
        perror("AGENC_OS_NETWORK_BOUNDARY_ERROR geteventmsg");
        boundary_fatal = 1;
        kill_all_traced_tasks();
      } else {
        add_traced_task((pid_t)new_pid, 1);
      }
      (void)ptrace(PTRACE_CONT, stopped_pid, NULL, NULL);
      continue;
    }
    if (
      stop_signal == SIGTRAP &&
      (event == PTRACE_EVENT_EXEC || event == PTRACE_EVENT_EXIT)
    ) {
      (void)ptrace(PTRACE_CONT, stopped_pid, NULL, NULL);
      continue;
    }
    if (stop_signal == SIGTRAP && event != 0) {
      fprintf(
        stderr,
        "AGENC_OS_NETWORK_BOUNDARY_ERROR unexpected ptrace event=%u pid=%ld\n",
        event,
        (long)stopped_pid
      );
      boundary_fatal = 1;
      kill_all_traced_tasks();
      (void)ptrace(
        PTRACE_CONT,
        stopped_pid,
        NULL,
        (void *)(intptr_t)SIGKILL
      );
      continue;
    }
    (void)ptrace(
      PTRACE_CONT,
      stopped_pid,
      NULL,
      (void *)(intptr_t)stop_signal
    );
  }

  if (boundary_failed != 0 || boundary_fatal != 0) {
    return AGENC_BOUNDARY_VIOLATION_EXIT;
  }
  if (primary_finished == 0) {
    fprintf(stderr, "AGENC_OS_NETWORK_BOUNDARY_ERROR primary status missing\n");
    return 125;
  }
  return primary_status > 255 ? 255 : primary_status;
}

int main(int argc, char **argv) {
  struct sigaction action;
  if (argc == 2 && strcmp(argv[1], "--native-canary") == 0) {
    return run_native_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--clone-untraced-canary") == 0) {
    return run_clone_untraced_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--seccomp-replacement-canary") == 0) {
    return run_seccomp_replacement_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--vsock-canary") == 0) {
    return run_vsock_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--unix-broker-canary") == 0) {
    return run_unix_broker_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--unix-traversal-canary") == 0) {
    return run_unix_traversal_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--unix-symlink-canary") == 0) {
    return run_unix_symlink_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--unix-noncanonical-canary") == 0) {
    return run_unix_noncanonical_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--unix-private-canary") == 0) {
    return run_unix_private_canary();
  }
  if (argc == 2 && strcmp(argv[1], "--sigtrap-canary") == 0) {
    return run_sigtrap_canary();
  }
  if (argc < 2) {
    fprintf(stderr, "usage: %s COMMAND [ARG ...]\n", argv[0]);
    return 64;
  }
  memset(&action, 0, sizeof(action));
  action.sa_handler = handle_signal;
  (void)sigemptyset(&action.sa_mask);
  (void)sigaction(SIGINT, &action, NULL);
  (void)sigaction(SIGTERM, &action, NULL);
  return trace_command(&argv[1]);
}
