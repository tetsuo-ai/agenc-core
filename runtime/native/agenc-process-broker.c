#define _GNU_SOURCE

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
  AGENC_BROKER_FAILURE = -1,
  AGENC_BROKER_SUCCESS = 0,
  AGENC_BROKER_ERROR_EXIT = 125,
  AGENC_BROKER_EXEC_EXIT = 127,
  AGENC_BROKER_STATUS_FD = 3,
  AGENC_BROKER_BOOTSTRAP_FD = 4,
  AGENC_BROKER_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024,
  AGENC_BROKER_MAX_STRINGS = 65536,
  AGENC_BROKER_BOOTSTRAP_TIMEOUT_MS = 10000,
  AGENC_BROKER_FIRST_SIGNAL_INDEX = 0,
  AGENC_BROKER_PRCTL_ENABLED = 1,
  AGENC_BROKER_PRCTL_UNUSED = 0,
  AGENC_BROKER_FORK_FAILED_PID = -1,
  AGENC_BROKER_FORK_CHILD_PID = 0,
  AGENC_BROKER_ANY_CHILD_PID = -1,
  AGENC_BROKER_INVALID_ROOT_PID = -1,
  AGENC_BROKER_MAXIMUM_UNSAFE_PID = 1,
  AGENC_BROKER_NO_SIGNAL = 0,
  AGENC_BROKER_NO_WAITED_PID = 0,
  AGENC_BROKER_EMPTY_CHILD_COUNT = 0,
  AGENC_BROKER_EMPTY_WAIT_STATUS = 0,
  AGENC_BROKER_NO_BYTES = 0,
  AGENC_BROKER_ZERO_FILL = 0,
  AGENC_BROKER_CHILD_READ_END = 0,
  AGENC_BROKER_CHILD_READ_FOUND = 1,
  AGENC_BROKER_CHILDREN_PATH_CAPACITY = 128,
  AGENC_BROKER_CLEANUP_RETRY_SECONDS = 0,
  AGENC_BROKER_CLEANUP_RETRY_NANOSECONDS = 1000000,
  AGENC_BROKER_SIGNAL_EXIT_BASE = 128
};

#define AGENC_BROKER_ARRAY_LENGTH(array) (sizeof(array) / sizeof(*(array)))
#define AGENC_BROKER_MESSAGE_LENGTH(message)                                   \
  (sizeof(message) - sizeof(*(message)))

typedef int (*direct_child_action)(pid_t child_pid, const void *context);

struct child_signal_context {
  int signal_number;
};

struct launch_payload {
  char *bytes;
  char *program;
  char **argv;
  char **environment;
};

int main(int argc, char **argv);
static int describe_v2_protocol(void);
static int launch_v2_supervised_target(sigset_t *wait_mask);
static int v2_pending_stop(void);
static int v2_owner_alive(void);
static int v2_read(void *buffer, size_t length, int64_t deadline, bool require_eof);
static int v2_descriptor_inventory(bool with_source);
static int v2_sealed_snapshot(const unsigned char *bytes, size_t size);
static void v2_free_payload(struct launch_payload *payload);
static int v2_seccomp_argv(const struct launch_payload *payload, bool has_fd);
static int read_v2_payload(struct launch_payload *payload, int *snapshot_fd);
static _Noreturn void run_v2_target_child(struct launch_payload *payload, int snapshot_fd, pid_t broker_pid);
static int launch_supervised_target(int argc, sigset_t *wait_mask);
static int complete_broker_cleanup(void);
static int validate_invocation(int argc);
static int prepare_broker(sigset_t *wait_mask);
static int block_control_signals(sigset_t *wait_mask);
static int enable_child_subreaper(void);
static int install_broker_handlers(void);
static int arm_owner_death_signal(pid_t owner_pid);
static int verify_initial_child_ownership(void);
static int read_launch_payload(struct launch_payload *payload);
static int64_t monotonic_milliseconds(void);
static int read_bootstrap_exact(void *buffer, size_t length, int64_t deadline);
static uint32_t bootstrap_u32(const unsigned char *bytes);
static char *take_bootstrap_string(char **cursor, const char *end);
static int start_root_process(const char *program, char **target_argv);
static _Noreturn void run_target_child(const char *program, char **target_argv);
static int monitor_root_process(const sigset_t *wait_mask, int *root_status);
static int forward_requested_signal(void);
static int wait_for_broker_signal(const sigset_t *wait_mask,
                                  int *observed_signal);
static void record_control_signal(int observed_signal);
static int observe_residual_descendants(bool *residual_observed);
static int publish_cleanup_status(bool residual_observed);
static void report_message(const char *message);
static void report_errno(const char *message);
static void request_graceful_stop(int signal_number);
static void request_forced_stop(int signal_number);
static int install_handler(int signal_number, void (*handler)(int));
static void reset_child_signals(void);
static FILE *open_direct_children(void);
static int read_direct_child(FILE *stream, pid_t *child_pid);
static int visit_direct_children(direct_child_action action,
                                 const void *context, size_t *count_out);
static int count_direct_children(size_t *count_out);
static int signal_direct_child(pid_t child_pid, const void *context);
static int signal_direct_children(int signal_number);
static void signal_root_directly(int signal_number);
static bool reached_by_group_signal(pid_t pid, int signal_number);
static int signal_owned_tree(int signal_number);
static int reap_nonblocking(bool *has_children);
static int reap_until_blocked(int *root_status, bool *root_finished);
static int force_cleanup_descendants(void);
static int write_status(const char *message, size_t length);
static _Noreturn void exit_like_root(int status);

static const int broker_wait_signals[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR2,
                                          SIGCHLD};
static const int child_reset_signals[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR2,
                                          SIGPIPE};
static const char broker_ready_status[] = "S";
static const char broker_clean_status[] = "C";
static const char broker_residual_clean_status[] = "RC";

static volatile sig_atomic_t requested_signal = AGENC_BROKER_NO_SIGNAL;
static pid_t root_pid = AGENC_BROKER_INVALID_ROOT_PID;

int main(int argc, char **argv) {
  sigset_t wait_mask;
  int root_status = AGENC_BROKER_EMPTY_WAIT_STATUS;

  if (argc == 2 && strcmp(argv[1], "--describe-protocol") == 0)
    return describe_v2_protocol();
  int launch_status = argc == 2 && strcmp(argv[1], "--bootstrap-v2") == 0
      ? launch_v2_supervised_target(&wait_mask)
      : launch_supervised_target(argc, &wait_mask);
  if (launch_status != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (monitor_root_process(&wait_mask, &root_status) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (complete_broker_cleanup() != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  exit_like_root(root_status);
}

static int launch_supervised_target(int argc, sigset_t *wait_mask) {
  struct launch_payload payload = {0};
  int launch_result;

  if (validate_invocation(argc) != AGENC_BROKER_SUCCESS ||
      prepare_broker(wait_mask) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  if (read_launch_payload(&payload) != AGENC_BROKER_SUCCESS) {
    report_message("invalid private bootstrap payload");
    return AGENC_BROKER_FAILURE;
  }
  /* No bootstrap descriptor or controller environment reaches the task. */
  (void)close(AGENC_BROKER_BOOTSTRAP_FD);
  char **bootstrap_environment = environ;
  environ = payload.environment;
  launch_result =
      start_root_process(payload.program, payload.argv);
  environ = bootstrap_environment;
  free(payload.argv);
  free(payload.environment);
  free(payload.bytes);
  if (launch_result != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  (void)close(STDIN_FILENO);
  return AGENC_BROKER_SUCCESS;
}

static int complete_broker_cleanup(void) {
  bool residual_observed = false;

  if (observe_residual_descendants(&residual_observed) !=
      AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  if (force_cleanup_descendants() != AGENC_BROKER_SUCCESS) {
    report_errno("descendant cleanup failed");
    return AGENC_BROKER_FAILURE;
  }
  if (publish_cleanup_status(residual_observed) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  (void)close(AGENC_BROKER_STATUS_FD);
  return AGENC_BROKER_SUCCESS;
}

static int validate_invocation(int argc) {
  if (argc == 1) {
    return AGENC_BROKER_SUCCESS;
  }
  report_message("expected private bootstrap on FD 4, no arguments");
  return AGENC_BROKER_FAILURE;
}

static int prepare_broker(sigset_t *wait_mask) {
  pid_t owner_pid = getppid();

  if (block_control_signals(wait_mask) != AGENC_BROKER_SUCCESS) {
    report_errno("signal mask setup failed");
    return AGENC_BROKER_FAILURE;
  }
  if (enable_child_subreaper() != AGENC_BROKER_SUCCESS) {
    report_errno("ownership setup failed");
    return AGENC_BROKER_FAILURE;
  }
  if (install_broker_handlers() != AGENC_BROKER_SUCCESS) {
    report_errno("signal setup failed");
    return AGENC_BROKER_FAILURE;
  }
  if (arm_owner_death_signal(owner_pid) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  if (verify_initial_child_ownership() != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  return AGENC_BROKER_SUCCESS;
}

static int block_control_signals(sigset_t *wait_mask) {
  size_t index = AGENC_BROKER_FIRST_SIGNAL_INDEX;

  sigemptyset(wait_mask);
  for (; index < AGENC_BROKER_ARRAY_LENGTH(broker_wait_signals); ++index) {
    sigaddset(wait_mask, broker_wait_signals[index]);
  }
  return sigprocmask(SIG_BLOCK, wait_mask, NULL);
}

static int enable_child_subreaper(void) {
  return prctl(PR_SET_CHILD_SUBREAPER, AGENC_BROKER_PRCTL_ENABLED,
               AGENC_BROKER_PRCTL_UNUSED, AGENC_BROKER_PRCTL_UNUSED,
               AGENC_BROKER_PRCTL_UNUSED);
}

static int install_broker_handlers(void) {
  /*
   * Install SIGUSR2 before arming PDEATHSIG. Otherwise an owner exit in the
   * small interval between those operations would take the default action and
   * terminate the broker before it could reap the owned tree.
   */
  if (install_handler(SIGTERM, request_graceful_stop) != AGENC_BROKER_SUCCESS ||
      install_handler(SIGINT, request_graceful_stop) != AGENC_BROKER_SUCCESS ||
      install_handler(SIGHUP, request_forced_stop) != AGENC_BROKER_SUCCESS ||
      install_handler(SIGUSR2, request_forced_stop) != AGENC_BROKER_SUCCESS ||
      install_handler(SIGPIPE, SIG_IGN) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_FAILURE;
  }
  return AGENC_BROKER_SUCCESS;
}

static int arm_owner_death_signal(pid_t owner_pid) {
  if (prctl(PR_SET_PDEATHSIG, SIGUSR2, AGENC_BROKER_PRCTL_UNUSED,
            AGENC_BROKER_PRCTL_UNUSED,
            AGENC_BROKER_PRCTL_UNUSED) != AGENC_BROKER_SUCCESS) {
    report_errno("owner-death setup failed");
    return AGENC_BROKER_FAILURE;
  }
  return getppid() == owner_pid ? AGENC_BROKER_SUCCESS : AGENC_BROKER_FAILURE;
}

static int verify_initial_child_ownership(void) {
  size_t child_count = AGENC_BROKER_EMPTY_CHILD_COUNT;

  if (count_direct_children(&child_count) != AGENC_BROKER_SUCCESS ||
      child_count != AGENC_BROKER_EMPTY_CHILD_COUNT) {
    report_message("child ownership enumeration unavailable");
    return AGENC_BROKER_FAILURE;
  }
  return AGENC_BROKER_SUCCESS;
}

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int read_bootstrap_exact(void *buffer, size_t length, int64_t deadline) {
  size_t offset = 0;
  while (offset < length) {
    int64_t now = monotonic_milliseconds();
    if (now < 0 || now >= deadline) return AGENC_BROKER_FAILURE;
    struct pollfd descriptor = {AGENC_BROKER_BOOTSTRAP_FD, POLLIN, 0};
    int ready = poll(&descriptor, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) return AGENC_BROKER_FAILURE;
    ssize_t received = read(descriptor.fd, (char *)buffer + offset, length - offset);
    if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (received <= 0) return AGENC_BROKER_FAILURE;
    offset += (size_t)received;
  }
  return AGENC_BROKER_SUCCESS;
}

static uint32_t bootstrap_u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
         ((uint32_t)bytes[2] << 8) | bytes[3];
}

static char *take_bootstrap_string(char **cursor, const char *end) {
  char *value = *cursor;
  char *terminator = memchr(value, 0, (size_t)(end - value));
  if (terminator == NULL) return NULL;
  *cursor = terminator + 1;
  return value;
}

static int read_launch_payload(struct launch_payload *payload) {
  /* AGB1, then big-endian payload length, argv count, environment count.
   * The bounded body contains NUL-terminated program, argv, and NAME=VALUE
   * strings. Transport is separate from task stdin and the status descriptor.
   * No target instruction runs until the complete frame has been validated. */
  unsigned char header[16];
  int64_t now = monotonic_milliseconds();
  if (now < 0) return AGENC_BROKER_FAILURE;
  int64_t deadline = now + AGENC_BROKER_BOOTSTRAP_TIMEOUT_MS;
  if (read_bootstrap_exact(header, sizeof(header), deadline) != 0 ||
      memcmp(header, "AGB1", 4) != 0) return AGENC_BROKER_FAILURE;
  uint32_t size = bootstrap_u32(header + 4);
  uint32_t argc = bootstrap_u32(header + 8);
  uint32_t envc = bootstrap_u32(header + 12);
  if (size == 0 || size > AGENC_BROKER_MAX_PAYLOAD_BYTES || argc == 0 ||
      argc >= AGENC_BROKER_MAX_STRINGS ||
      envc >= AGENC_BROKER_MAX_STRINGS - argc) return AGENC_BROKER_FAILURE;
  payload->bytes = malloc(size);
  payload->argv = calloc((size_t)argc + 1, sizeof(char *));
  payload->environment = calloc((size_t)envc + 1, sizeof(char *));
  if (payload->bytes == NULL || payload->argv == NULL || payload->environment == NULL ||
      read_bootstrap_exact(payload->bytes, size, deadline) != 0) goto failure;
  char *cursor = payload->bytes;
  const char *end = cursor + size;
  payload->program = take_bootstrap_string(&cursor, end);
  if (payload->program == NULL || payload->program[0] == 0) goto failure;
  for (uint32_t index = 0; index < argc; ++index) {
    payload->argv[index] = take_bootstrap_string(&cursor, end);
    if (payload->argv[index] == NULL) goto failure;
  }
  for (uint32_t index = 0; index < envc; ++index) {
    char *entry = take_bootstrap_string(&cursor, end);
    if (entry == NULL) goto failure;
    char *equals = strchr(entry, '=');
    if (equals == NULL || equals == entry) goto failure;
    payload->environment[index] = entry;
  }
  if (cursor != end) goto failure;
  return AGENC_BROKER_SUCCESS;
failure:
  free(payload->bytes);
  free(payload->argv);
  free(payload->environment);
  return AGENC_BROKER_FAILURE;
}

static int start_root_process(const char *program, char **target_argv) {
  root_pid = fork();
  if (root_pid == AGENC_BROKER_FORK_FAILED_PID) {
    report_errno("fork failed");
    return AGENC_BROKER_FAILURE;
  }
  if (root_pid == AGENC_BROKER_FORK_CHILD_PID) {
    run_target_child(program, target_argv);
  }
  return AGENC_BROKER_SUCCESS;
}

static _Noreturn void run_target_child(const char *program,
                                       char **target_argv) {
  pid_t broker_pid = getppid();

  reset_child_signals();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, AGENC_BROKER_PRCTL_UNUSED,
            AGENC_BROKER_PRCTL_UNUSED,
            AGENC_BROKER_PRCTL_UNUSED) != AGENC_BROKER_SUCCESS ||
      getppid() != broker_pid || setsid() < AGENC_BROKER_SUCCESS) {
    _exit(AGENC_BROKER_ERROR_EXIT);
  }
  if (write_status(broker_ready_status,
                   AGENC_BROKER_MESSAGE_LENGTH(broker_ready_status)) !=
      AGENC_BROKER_SUCCESS) {
    _exit(AGENC_BROKER_ERROR_EXIT);
  }
  (void)close(AGENC_BROKER_STATUS_FD);
  execvp(program, target_argv);
  report_errno("exec failed");
  _exit(AGENC_BROKER_EXEC_EXIT);
}

static int monitor_root_process(const sigset_t *wait_mask, int *root_status) {
  bool root_finished = false;

  while (!root_finished) {
    int observed_signal;

    if (reap_until_blocked(root_status, &root_finished) !=
        AGENC_BROKER_SUCCESS) {
      report_errno("wait failed");
      (void)signal_owned_tree(SIGKILL);
      return AGENC_BROKER_FAILURE;
    }
    if (root_finished) {
      break;
    }
    if (forward_requested_signal() != AGENC_BROKER_SUCCESS) {
      report_message("child ownership enumeration failed");
      signal_root_directly(SIGKILL);
      return AGENC_BROKER_FAILURE;
    }
    if (wait_for_broker_signal(wait_mask, &observed_signal) !=
        AGENC_BROKER_SUCCESS) {
      report_errno("signal wait failed");
      (void)signal_owned_tree(SIGKILL);
      return AGENC_BROKER_FAILURE;
    }
    record_control_signal(observed_signal);
  }
  return AGENC_BROKER_SUCCESS;
}

static int forward_requested_signal(void) {
  if (requested_signal == AGENC_BROKER_NO_SIGNAL) {
    return AGENC_BROKER_SUCCESS;
  }
  return signal_owned_tree((int)requested_signal);
}

static int wait_for_broker_signal(const sigset_t *wait_mask,
                                  int *observed_signal) {
  do {
    *observed_signal = sigwaitinfo(wait_mask, NULL);
  } while (*observed_signal < AGENC_BROKER_SUCCESS && errno == EINTR);
  return *observed_signal < AGENC_BROKER_SUCCESS ? AGENC_BROKER_FAILURE
                                                 : AGENC_BROKER_SUCCESS;
}

static void record_control_signal(int observed_signal) {
  if (observed_signal == SIGTERM || observed_signal == SIGINT) {
    request_graceful_stop(observed_signal);
  } else if (observed_signal == SIGHUP || observed_signal == SIGUSR2) {
    request_forced_stop(observed_signal);
  }
}

static int observe_residual_descendants(bool *residual_observed) {
  size_t child_count = AGENC_BROKER_EMPTY_CHILD_COUNT;

  if (count_direct_children(&child_count) != AGENC_BROKER_SUCCESS) {
    report_message("residual enumeration failed");
    return AGENC_BROKER_FAILURE;
  }
  *residual_observed = child_count > AGENC_BROKER_EMPTY_CHILD_COUNT;
  return AGENC_BROKER_SUCCESS;
}

static int publish_cleanup_status(bool residual_observed) {
  const char *status_message =
      residual_observed ? broker_residual_clean_status : broker_clean_status;
  size_t status_length =
      residual_observed
          ? AGENC_BROKER_MESSAGE_LENGTH(broker_residual_clean_status)
          : AGENC_BROKER_MESSAGE_LENGTH(broker_clean_status);

  return write_status(status_message, status_length);
}

static void report_message(const char *message) {
  (void)dprintf(STDERR_FILENO, "agenc-process-broker: %s\n", message);
}

static void report_errno(const char *message) {
  int saved_errno = errno;

  (void)dprintf(STDERR_FILENO, "agenc-process-broker: %s: %s\n", message,
                strerror(saved_errno));
  errno = saved_errno;
}

static void request_graceful_stop(int signal_number) {
  (void)signal_number;
  if (requested_signal != SIGKILL) {
    requested_signal = SIGTERM;
  }
}

static void request_forced_stop(int signal_number) {
  (void)signal_number;
  requested_signal = SIGKILL;
}

static int install_handler(int signal_number, void (*handler)(int)) {
  struct sigaction action;

  memset(&action, AGENC_BROKER_ZERO_FILL, sizeof(action));
  action.sa_handler = handler;
  sigemptyset(&action.sa_mask);
  return sigaction(signal_number, &action, NULL);
}

static void reset_child_signals(void) {
  struct sigaction action;
  sigset_t mask;
  size_t index = AGENC_BROKER_FIRST_SIGNAL_INDEX;

  memset(&action, AGENC_BROKER_ZERO_FILL, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  for (; index < AGENC_BROKER_ARRAY_LENGTH(child_reset_signals); ++index) {
    (void)sigaction(child_reset_signals[index], &action, NULL);
  }
  sigemptyset(&mask);
  (void)sigprocmask(SIG_SETMASK, &mask, NULL);
}

static FILE *open_direct_children(void) {
  char path[AGENC_BROKER_CHILDREN_PATH_CAPACITY];
  int path_length;

  path_length = snprintf(path, sizeof(path), "/proc/self/task/%ld/children",
                         (long)getpid());
  if (path_length < AGENC_BROKER_SUCCESS ||
      (size_t)path_length >= sizeof(path)) {
    return NULL;
  }
  return fopen(path, "r");
}

static int read_direct_child(FILE *stream, pid_t *child_pid) {
  long candidate;
  int scan_result = fscanf(stream, "%ld", &candidate);

  if (scan_result == EOF) {
    return ferror(stream) == AGENC_BROKER_SUCCESS ? AGENC_BROKER_CHILD_READ_END
                                                  : AGENC_BROKER_FAILURE;
  }
  if (scan_result != AGENC_BROKER_CHILD_READ_FOUND ||
      candidate <= AGENC_BROKER_MAXIMUM_UNSAFE_PID || candidate > INT32_MAX) {
    return AGENC_BROKER_FAILURE;
  }
  *child_pid = (pid_t)candidate;
  return AGENC_BROKER_CHILD_READ_FOUND;
}

static int visit_direct_children(direct_child_action action,
                                 const void *context, size_t *count_out) {
  FILE *stream = open_direct_children();
  size_t count = AGENC_BROKER_EMPTY_CHILD_COUNT;
  int result = AGENC_BROKER_SUCCESS;

  if (stream == NULL) {
    return AGENC_BROKER_FAILURE;
  }
  for (;;) {
    pid_t child_pid;
    int read_result = read_direct_child(stream, &child_pid);

    if (read_result == AGENC_BROKER_CHILD_READ_END) {
      break;
    }
    if (read_result != AGENC_BROKER_CHILD_READ_FOUND || count == SIZE_MAX ||
        (action != NULL &&
         action(child_pid, context) != AGENC_BROKER_SUCCESS)) {
      result = AGENC_BROKER_FAILURE;
      break;
    }
    ++count;
  }
  (void)fclose(stream);
  if (result == AGENC_BROKER_SUCCESS) {
    *count_out = count;
  }
  return result;
}

static int count_direct_children(size_t *count_out) {
  return visit_direct_children(NULL, NULL, count_out);
}

/*
 * The root becomes a session leader before exec, so kill(-root_pid) already
 * reaches it and every descendant that stayed in its process group. A second
 * direct kill of the same process is not idempotent for a graceful signal:
 * a target scheduled between the two calls observes SIGTERM twice, and many
 * programs treat a repeated SIGTERM as "abandon the shutdown". Forced SIGKILL
 * keeps the redundant delivery; a duplicate cannot change its outcome and it
 * still covers a member that joins the group between the two calls.
 */
static bool reached_by_group_signal(pid_t pid, int signal_number) {
  if (signal_number == SIGKILL || root_pid <= AGENC_BROKER_MAXIMUM_UNSAFE_PID) {
    return false;
  }
  return getpgid(pid) == root_pid;
}

static int signal_direct_child(pid_t child_pid, const void *context) {
  const struct child_signal_context *signal_context = context;

  if (child_pid == root_pid ||
      reached_by_group_signal(child_pid, signal_context->signal_number) ||
      kill(child_pid, signal_context->signal_number) == AGENC_BROKER_SUCCESS ||
      errno == ESRCH) {
    return AGENC_BROKER_SUCCESS;
  }
  return AGENC_BROKER_FAILURE;
}

static int signal_direct_children(int signal_number) {
  size_t count = AGENC_BROKER_EMPTY_CHILD_COUNT;
  const struct child_signal_context context = {signal_number};

  return visit_direct_children(signal_direct_child, &context, &count);
}

static void signal_root_directly(int signal_number) {
  if (root_pid <= AGENC_BROKER_MAXIMUM_UNSAFE_PID) {
    return;
  }
  (void)kill(-root_pid, signal_number);
  if (!reached_by_group_signal(root_pid, signal_number)) {
    (void)kill(root_pid, signal_number);
  }
}

static int signal_owned_tree(int signal_number) {
  int result = AGENC_BROKER_SUCCESS;

  if (root_pid > AGENC_BROKER_MAXIMUM_UNSAFE_PID) {
    if (kill(-root_pid, signal_number) != AGENC_BROKER_SUCCESS &&
        errno != ESRCH) {
      result = AGENC_BROKER_FAILURE;
    }
    if (!reached_by_group_signal(root_pid, signal_number) &&
        kill(root_pid, signal_number) != AGENC_BROKER_SUCCESS &&
        errno != ESRCH) {
      result = AGENC_BROKER_FAILURE;
    }
  }
  if (signal_direct_children(signal_number) != AGENC_BROKER_SUCCESS) {
    result = AGENC_BROKER_FAILURE;
  }
  return result;
}

static int reap_nonblocking(bool *has_children) {
  int status;
  pid_t waited;

  *has_children = false;
  for (;;) {
    waited = waitpid(AGENC_BROKER_ANY_CHILD_PID, &status, WNOHANG);
    if (waited > AGENC_BROKER_NO_WAITED_PID) {
      continue;
    }
    if (waited == AGENC_BROKER_NO_WAITED_PID) {
      *has_children = true;
      return AGENC_BROKER_SUCCESS;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == ECHILD) {
      return AGENC_BROKER_SUCCESS;
    }
    return AGENC_BROKER_FAILURE;
  }
}

static int reap_until_blocked(int *root_status, bool *root_finished) {
  for (;;) {
    int status;
    pid_t waited = waitpid(AGENC_BROKER_ANY_CHILD_PID, &status, WNOHANG);

    if (waited > AGENC_BROKER_NO_WAITED_PID) {
      if (waited == root_pid) {
        *root_status = status;
        *root_finished = true;
      }
      continue;
    }
    if (waited == AGENC_BROKER_NO_WAITED_PID) {
      return AGENC_BROKER_SUCCESS;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == ECHILD && *root_finished) {
      return AGENC_BROKER_SUCCESS;
    }
    return AGENC_BROKER_FAILURE;
  }
}

static int force_cleanup_descendants(void) {
  const struct timespec retry = {AGENC_BROKER_CLEANUP_RETRY_SECONDS,
                                 AGENC_BROKER_CLEANUP_RETRY_NANOSECONDS};

  for (;;) {
    bool has_children = false;

    if (reap_nonblocking(&has_children) != AGENC_BROKER_SUCCESS) {
      return AGENC_BROKER_FAILURE;
    }
    if (!has_children) {
      return AGENC_BROKER_SUCCESS;
    }
    if (signal_direct_children(SIGKILL) != AGENC_BROKER_SUCCESS) {
      return AGENC_BROKER_FAILURE;
    }
    (void)nanosleep(&retry, NULL);
  }
}

static int write_status(const char *message, size_t length) {
  size_t offset = AGENC_BROKER_NO_BYTES;

  while (offset < length) {
    ssize_t written =
        write(AGENC_BROKER_STATUS_FD, message + offset, length - offset);
    if (written > AGENC_BROKER_NO_BYTES) {
      offset += (size_t)written;
      continue;
    }
    if (written < AGENC_BROKER_NO_BYTES && errno == EINTR) {
      continue;
    }
    return AGENC_BROKER_FAILURE;
  }
  return AGENC_BROKER_SUCCESS;
}

static _Noreturn void exit_like_root(int status) {
  if (WIFEXITED(status)) {
    _exit(WEXITSTATUS(status));
  }
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    struct sigaction action;
    sigset_t mask;

    memset(&action, AGENC_BROKER_ZERO_FILL, sizeof(action));
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    (void)sigaction(signal_number, &action, NULL);
    sigemptyset(&mask);
    (void)sigprocmask(SIG_SETMASK, &mask, NULL);
    (void)kill(getpid(), signal_number);
    _exit(AGENC_BROKER_SIGNAL_EXIT_BASE + signal_number);
  }
  _exit(AGENC_BROKER_ERROR_EXIT);
}

/* AGB2 is deliberately independent of the legacy AGB1 bootstrap. Only the
 * canonical guarded caller selects --bootstrap-v2. No children exist until
 * its complete owner-bound frame, descriptor snapshot, commit and EOF pass. */
static pid_t v2_expected_owner = 0;

static int v2_pending_stop(void) {
  sigset_t pending;
  if (sigpending(&pending) != 0) return AGENC_BROKER_FAILURE;
  if (requested_signal != AGENC_BROKER_NO_SIGNAL) return AGENC_BROKER_FAILURE;
  const int stop[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR2};
  for (size_t i = 0; i < AGENC_BROKER_ARRAY_LENGTH(stop); ++i) {
    if (sigismember(&pending, stop[i]) != 0) return AGENC_BROKER_FAILURE;
  }
  return AGENC_BROKER_SUCCESS;
}

static int v2_owner_alive(void) {
  return (v2_expected_owner == 0 || getppid() == v2_expected_owner) &&
                 v2_pending_stop() == 0
             ? AGENC_BROKER_SUCCESS : AGENC_BROKER_FAILURE;
}

static int v2_read(void *buffer, size_t length, int64_t deadline,
                   bool require_eof) {
  size_t offset = 0;
  do {
    int64_t now = monotonic_milliseconds();
    if (now < 0 || now >= deadline || v2_owner_alive() != 0) return -1;
    int wait_ms = deadline - now > 50 ? 50 : (int)(deadline - now);
    struct pollfd descriptor = {AGENC_BROKER_BOOTSTRAP_FD, POLLIN, 0};
    int ready = poll(&descriptor, 1, wait_ms);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return -1;
    if (ready == 0) continue;
    unsigned char extra;
    ssize_t n = read(descriptor.fd, require_eof ? (void *)&extra : (char *)buffer + offset,
                     require_eof ? 1 : length - offset);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (require_eof) return n == 0 ? 0 : -1;
    if (n <= 0) return -1;
    offset += (size_t)n;
  } while (require_eof || offset < length);
  return v2_owner_alive();
}

static int v2_descriptor_inventory(bool with_source) {
  for (int fd = 0; fd <= AGENC_BROKER_BOOTSTRAP_FD; ++fd)
    if (fcntl(fd, F_GETFD) < 0) return -1;
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) return -1;
  int own = dirfd(directory), result = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (entry->d_name[0] == '.') continue;
    char *end;
    errno = 0;
    long fd = strtol(entry->d_name, &end, 10);
    if (errno != 0 || *end != 0 || fd < 0 || fd > INT_MAX) { result = -1; break; }
    if (fd != own && fd > (with_source ? 5 : 4)) {
      (void)close((int)fd);
      result = -1;
    }
    errno = 0;
  }
  if (errno != 0) result = -1;
  if (closedir(directory) != 0) result = -1;
  return result;
}

static int v2_sealed_snapshot(const unsigned char *bytes, size_t size) {
  int fd = memfd_create("agenc-seccomp", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (fd < 0) return -1;
  if (fd < 6) {
    int moved = fcntl(fd, F_DUPFD_CLOEXEC, 6);
    (void)close(fd);
    if (moved < 0) return -1;
    fd = moved;
  }
  size_t offset = 0;
  while (offset < size) {
    ssize_t n = write(fd, bytes + offset, size - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) goto failure;
    offset += (size_t)n;
  }
  const int seals = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
  struct stat st;
  if (fcntl(fd, F_ADD_SEALS, seals) != 0 ||
      fcntl(fd, F_GET_SEALS) != seals || fstat(fd, &st) != 0 ||
      st.st_size != (off_t)size || lseek(fd, 0, SEEK_SET) != 0) goto failure;
  return fd;
failure:
  (void)close(fd);
  return -1;
}

static int describe_v2_protocol(void) {
  const unsigned char bytes[8] = {0};
  int fd = v2_sealed_snapshot(bytes, sizeof(bytes));
  if (fd < 0) return AGENC_BROKER_ERROR_EXIT;
  if (close(fd) != 0) return AGENC_BROKER_ERROR_EXIT;
  return puts("AGB2 owner-pid seccomp-snapshot-sealed-v1") < 0
      ? AGENC_BROKER_ERROR_EXIT : 0;
}

static void v2_free_payload(struct launch_payload *payload) {
  free(payload->argv);
  free(payload->environment);
  free(payload->bytes);
  memset(payload, 0, sizeof(*payload));
}

static int v2_seccomp_argv(const struct launch_payload *payload, bool has_fd) {
  unsigned count = 0;
  bool delimiter = false;
  for (size_t i = 1; payload->argv[i] != NULL; ++i) {
    const char *arg = payload->argv[i];
    if (strcmp(arg, "--") == 0) { delimiter = true; break; }
    if (strcmp(arg, "--seccomp") == 0) {
      if (payload->argv[i + 1] == NULL || strcmp(payload->argv[++i], "3") != 0)
        return -1;
      ++count;
    }
    const char *forbidden[] = {
      "--add-seccomp-fd", "--ro-bind-fd", "--bind-fd", "--args", "--file",
      "--bind-data", "--ro-bind-data", "--sync-fd", "--info-fd",
      "--json-status-fd", "--userns", "--userns2", "--pidns", "--block-fd",
      "--userns-block-fd"
    };
    for (size_t j = 0; j < AGENC_BROKER_ARRAY_LENGTH(forbidden); ++j) {
      size_t length = strlen(forbidden[j]);
      if (strncmp(arg, forbidden[j], length) == 0 &&
          (arg[length] == '\0' || arg[length] == '=')) return -1;
    }
    if (strncmp(arg, "--seccomp=", 10) == 0) return -1;
  }
  return delimiter && count == (has_fd ? 1U : 0U) ? 0 : -1;
}

static int read_v2_payload(struct launch_payload *payload, int *snapshot_fd) {
  unsigned char header[28];
  int64_t now = monotonic_milliseconds();
  if (now < 0) return -1;
  int64_t deadline = now + AGENC_BROKER_BOOTSTRAP_TIMEOUT_MS;
  if (v2_read(header, sizeof(header), deadline, false) != 0 ||
      memcmp(header, "AGB2", 4) != 0) return -1;
  uint32_t size = bootstrap_u32(header + 4), argc = bootstrap_u32(header + 8);
  uint32_t envc = bootstrap_u32(header + 12), maps = bootstrap_u32(header + 20);
  uint32_t owner = bootstrap_u32(header + 24);
  if (owner <= 1 || owner > INT32_MAX || (uint32_t)(pid_t)owner != owner ||
      bootstrap_u32(header + 16) != 0 || maps > 1 || size == 0 ||
      size > AGENC_BROKER_MAX_PAYLOAD_BYTES || argc == 0 ||
      argc >= AGENC_BROKER_MAX_STRINGS || envc >= AGENC_BROKER_MAX_STRINGS - argc)
    return -1;
  v2_expected_owner = (pid_t)owner;
  if (v2_owner_alive() != 0 || arm_owner_death_signal(v2_expected_owner) != 0 ||
      v2_owner_alive() != 0 || v2_descriptor_inventory(maps == 1) != 0) return -1;
  payload->bytes = malloc(size);
  payload->argv = calloc((size_t)argc + 1, sizeof(char *));
  payload->environment = calloc((size_t)envc + 1, sizeof(char *));
  if (!payload->bytes || !payload->argv || !payload->environment ||
      v2_read(payload->bytes, size, deadline, false) != 0) goto failure;
  char *cursor = payload->bytes;
  const char *end = cursor + size;
  uint32_t data_length = 0;
  if (maps == 1) {
    if (size < 16) goto failure;
    const unsigned char *map = (unsigned char *)cursor;
    data_length = bootstrap_u32(map + 12);
    if (bootstrap_u32(map) != 5 || bootstrap_u32(map + 4) != 3 ||
        bootstrap_u32(map + 8) != 1 || data_length < 8 || data_length > 32768 ||
        data_length % 8 != 0 || data_length > size - 16) goto failure;
    cursor += 16;
  }
  const char *strings_end = end - data_length;
  payload->program = take_bootstrap_string(&cursor, strings_end);
  if (!payload->program || payload->program[0] != '/') goto failure;
  for (uint32_t i = 0; i < argc; ++i) {
    payload->argv[i] = take_bootstrap_string(&cursor, strings_end);
    if (!payload->argv[i]) goto failure;
  }
  for (uint32_t i = 0; i < envc; ++i) {
    char *entry = take_bootstrap_string(&cursor, strings_end);
    if (!entry) goto failure;
    char *equals = strchr(entry, '=');
    if (!equals || equals == entry) goto failure;
    size_t name_length = (size_t)(equals - entry);
    for (uint32_t j = 0; j < i; ++j)
      if (strncmp(entry, payload->environment[j], name_length) == 0 &&
          payload->environment[j][name_length] == '=') goto failure;
    payload->environment[i] = entry;
  }
  if (cursor != strings_end || strcmp(payload->argv[0], payload->program) != 0 ||
      v2_seccomp_argv(payload, maps == 1) != 0) goto failure;
  unsigned char commit;
  if (v2_read(&commit, 1, deadline, false) != 0 || commit != 0xa5 ||
      v2_read(NULL, 0, deadline, true) != 0) goto failure;
  if (maps == 1) {
    struct stat st;
    if (fstat(5, &st) != 0 || !S_ISREG(st.st_mode) ||
        st.st_size != (off_t)data_length) goto failure;
    unsigned char verified[32768];
    size_t offset = 0;
    while (offset < data_length) {
      if (v2_owner_alive() != 0) goto failure;
      ssize_t n = pread(5, verified + offset, data_length - offset, (off_t)offset);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) goto failure;
      offset += (size_t)n;
    }
    if (memcmp(verified, strings_end, data_length) != 0) goto failure;
    *snapshot_fd = v2_sealed_snapshot(verified, data_length);
    if (*snapshot_fd < 0) goto failure;
    if (close(5) != 0) goto failure;
  }
  return v2_owner_alive();
failure:
  return -1;
}

static _Noreturn void run_v2_target_child(struct launch_payload *payload,
                                         int snapshot_fd, pid_t broker_pid) {
  if (broker_pid <= 1 || getppid() != broker_pid ||
      prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 ||
      getppid() != broker_pid || setsid() < 0 || v2_pending_stop() != 0)
    _exit(AGENC_BROKER_ERROR_EXIT);
  reset_child_signals();
  if (getppid() != broker_pid ||
      write_status(broker_ready_status, AGENC_BROKER_MESSAGE_LENGTH(broker_ready_status)) != 0)
    _exit(AGENC_BROKER_ERROR_EXIT);
  if (close(AGENC_BROKER_STATUS_FD) != 0) _exit(AGENC_BROKER_ERROR_EXIT);
  if (snapshot_fd >= 0) {
    if (dup2(snapshot_fd, 3) != 3 || fcntl(3, F_SETFD, 0) != 0 ||
        close(snapshot_fd) != 0) _exit(AGENC_BROKER_ERROR_EXIT);
  }
  if (getppid() != broker_pid) _exit(AGENC_BROKER_ERROR_EXIT);
  execvp(payload->program, payload->argv);
  report_errno("exec failed");
  _exit(AGENC_BROKER_EXEC_EXIT);
}

static int launch_v2_supervised_target(sigset_t *wait_mask) {
  struct launch_payload payload = {0};
  int snapshot_fd = -1, result = -1;
  if (block_control_signals(wait_mask) != 0 || install_broker_handlers() != 0 ||
      enable_child_subreaper() != 0) return -1;
  if (read_v2_payload(&payload, &snapshot_fd) != 0 ||
      verify_initial_child_ownership() != 0 || v2_owner_alive() != 0) goto done;
  if (close(AGENC_BROKER_BOOTSTRAP_FD) != 0) goto done;
  pid_t broker_pid = getpid();
  char **bootstrap_environment = environ;
  environ = payload.environment;
  /* No capability helper or other child exists before this sole root fork. */
  if (v2_owner_alive() != 0) { environ = bootstrap_environment; goto done; }
  root_pid = fork();
  if (root_pid == 0) run_v2_target_child(&payload, snapshot_fd, broker_pid);
  environ = bootstrap_environment;
  if (root_pid < 0) goto done;
  result = 0;
  (void)close(STDIN_FILENO);
 done:
  if (snapshot_fd >= 0) (void)close(snapshot_fd);
  v2_free_payload(&payload);
  return result;
}
