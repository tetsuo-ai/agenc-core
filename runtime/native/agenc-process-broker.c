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
#include <sys/socket.h>
#include <sys/syscall.h>
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
static int read_owned_payload(struct launch_payload *payload, int *snapshot_fd,
                              const char *magic);
static int v3_high_fd(int fd);
static bool v3_path_contains(const char *parent, const char *path);
static bool v3_paths_overlap(const char *left, const char *right);
static bool v3_normal_path(const char *path);
static int v3_artifact_path(char *target, char *parent);
static char **v3_init_argv(const struct launch_payload *payload, char *target,
                            const char *parent);
static int v3_image_reference(void);
static _Noreturn void run_v3_target_child(struct launch_payload *payload,
    char **argv, int snapshot, int reference, int writer, pid_t broker);
static bool v3_trusted_abort(void);
static int describe_v3_protocol(void);
static int launch_v3_supervised_target(sigset_t *wait_mask);
static int complete_v3_cleanup(int root_status);
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
static void record_descendant_termination(pid_t waited, int status);
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
static bool v2_reporting = false;
static bool v2_descendant_terminated = false;
static bool v3_reporting = false;

static int run_one_shot_server(void);

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--one-shot-server-v1") == 0)
    return run_one_shot_server();
  sigset_t wait_mask;
  int root_status = AGENC_BROKER_EMPTY_WAIT_STATUS;

  if (argc == 2 && strcmp(argv[1], "--describe-protocol") == 0)
    return describe_v2_protocol();
  if (argc == 2 && strcmp(argv[1], "--describe-protocol-v3") == 0)
    return describe_v3_protocol();
  v3_reporting = argc == 2 && strcmp(argv[1], "--bootstrap-v3") == 0;
  int launch_status = v3_reporting ? launch_v3_supervised_target(&wait_mask)
      : argc == 2 && strcmp(argv[1], "--bootstrap-v2") == 0
      ? launch_v2_supervised_target(&wait_mask)
      : launch_supervised_target(argc, &wait_mask);
  if (launch_status != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (monitor_root_process(&wait_mask, &root_status) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (v3_reporting) return complete_v3_cleanup(root_status);
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
  /* AGB1 keeps its original conservative enumeration-based metadata. AGB2
   * reports a termination only when waitpid confirms a signalled descendant.
   * Reaping a naturally exited helper is cleanup, not a termination. */
  if (v2_reporting) residual_observed = v2_descendant_terminated;
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

static void record_descendant_termination(pid_t waited, int status) {
  /* Includes containment's kernel parent-death kill of the namespace helper.
   * A successful kill() alone is insufficient: it also succeeds on zombies.
   * The root's signal exit is already represented by the command exit status. */
  if (v2_reporting && waited != root_pid && WIFSIGNALED(status)) {
    v2_descendant_terminated = true;
  }
}

static int reap_nonblocking(bool *has_children) {
  int status;
  pid_t waited;

  *has_children = false;
  for (;;) {
    waited = waitpid(AGENC_BROKER_ANY_CHILD_PID, &status, WNOHANG);
    if (waited > AGENC_BROKER_NO_WAITED_PID) {
      record_descendant_termination(waited, status);
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
      record_descendant_termination(waited, status);
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
  return read_owned_payload(payload, snapshot_fd, "AGB2");
}

static int read_owned_payload(struct launch_payload *payload, int *snapshot_fd,
                              const char *magic) {
  unsigned char header[28];
  int64_t now = monotonic_milliseconds();
  if (now < 0) return -1;
  int64_t deadline = now + AGENC_BROKER_BOOTSTRAP_TIMEOUT_MS;
  if (v2_read(header, sizeof(header), deadline, false) != 0 ||
      memcmp(header, magic, 4) != 0) return -1;
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
  v2_reporting = true;
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

/* AGB3 is selected only by the trusted direct planner. The image header is
 * generated from this build's static helper, never from task input. */
#ifdef AGENC_NAMESPACE_INIT_IMAGE_HEADER
#include AGENC_NAMESPACE_INIT_IMAGE_HEADER
static const bool v3_has_image = true;
#else
static const unsigned char agenc_namespace_init_image[] = {0};
static const bool v3_has_image = false;
#endif

static const char v3_placeholder_bytes[] = "AGENC_NAMESPACE_INIT_ENTRY_V1\n";
static int v3_report_reader = -1;

static int v3_high_fd(int fd) {
  if (fd < 0 || fd >= 7) return fd;
  int moved = fcntl(fd, F_DUPFD_CLOEXEC, 7);
  (void)close(fd);
  return moved;
}

static bool v3_path_contains(const char *parent, const char *path) {
  size_t length = strlen(parent);
  if (strcmp(parent, "/") == 0) return path[0] == '/';
  return strncmp(parent, path, length) == 0 &&
      (path[length] == '\0' || path[length] == '/');
}

static bool v3_paths_overlap(const char *left, const char *right) {
  return v3_path_contains(left, right) || v3_path_contains(right, left);
}

static bool v3_normal_path(const char *path) {
  size_t size = strlen(path);
  return path[0] == '/' && size < PATH_MAX &&
      (size == 1 || path[size - 1] != '/') && strstr(path, "//") == NULL &&
      strstr(path, "/./") == NULL && strstr(path, "/../") == NULL &&
      (size < 2 || strcmp(path + size - 2, "/.") != 0) &&
      (size < 3 || strcmp(path + size - 3, "/..") != 0);
}

static int v3_artifact_path(char *target, char *parent) {
  if (!v3_has_image || sizeof(agenc_namespace_init_image) < 64 ||
      sizeof(agenc_namespace_init_image) > 2 * 1024 * 1024) return -1;
  char executable[PATH_MAX];
  if (realpath("/proc/self/exe", executable) == NULL) return -1;
  char *basename = strrchr(executable, '/');
  if (basename == NULL || strcmp(basename, "/agenc-process-broker") != 0) return -1;
  *basename = '\0';
  basename = strrchr(executable, '/');
  if (basename == NULL || strcmp(basename, "/dist") != 0) return -1;
  if (snprintf(target, PATH_MAX, "%s/agenc-namespace-init-entry", executable) >= PATH_MAX)
    return -1;
  strcpy(parent, executable);
  struct stat st;
  char canonical[PATH_MAX];
  if (lstat(target, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      (st.st_mode & 0022) != 0 || (st.st_uid != geteuid() && st.st_uid != 0) ||
      st.st_size != (off_t)(sizeof(v3_placeholder_bytes) - 1) ||
      realpath(target, canonical) == NULL || strcmp(canonical, target) != 0) return -1;
  int fd = open(target, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  char bytes[sizeof(v3_placeholder_bytes)];
  ssize_t count;
  do { count = read(fd, bytes, sizeof(bytes)); } while (count < 0 && errno == EINTR);
  int closed = close(fd);
  return count == (ssize_t)(sizeof(v3_placeholder_bytes) - 1) && closed == 0 &&
      memcmp(bytes, v3_placeholder_bytes, sizeof(v3_placeholder_bytes) - 1) == 0 ? 0 : -1;
}

/* Strict grammar for this one generated route, not a generic bwrap API. */
static char **v3_init_argv(const struct launch_payload *payload, char *target,
                            const char *parent) {
  bool pid = false, user = false, death = false, proc = false, readonly = false, readonly_root = false;
  size_t delimiter = 0, argc = 0;
  for (; payload->argv[argc] != NULL; ++argc) {}
  for (size_t i = 1; i < argc;) {
    const char *arg = payload->argv[i++];
    if (strcmp(arg, "--") == 0) { delimiter = i - 1; break; }
    if (strcmp(arg, "--unshare-pid") == 0) { if (pid) return NULL; pid = true; continue; }
    if (strcmp(arg, "--unshare-user") == 0) { if (user) return NULL; user = true; continue; }
    if (strcmp(arg, "--die-with-parent") == 0) { if (death) return NULL; death = true; continue; }
    if (strcmp(arg, "--new-session") == 0 || strcmp(arg, "--unshare-net") == 0) continue;
    bool bind = strcmp(arg, "--bind") == 0 || strcmp(arg, "--ro-bind") == 0 ||
                strcmp(arg, "--dev-bind") == 0;
    bool symlink = strcmp(arg, "--symlink") == 0;
    bool mount = bind || symlink || strcmp(arg, "--tmpfs") == 0 ||
                 strcmp(arg, "--dev") == 0 || strcmp(arg, "--proc") == 0 ||
                 strcmp(arg, "--remount-ro") == 0 || strcmp(arg, "--dir") == 0;
    if (!mount && strcmp(arg, "--seccomp") != 0 && strcmp(arg, "--chdir") != 0) return NULL;
    size_t values = bind || symlink ? 2 : 1;
    if (values > argc - i) return NULL;
    const char *source = payload->argv[i];
    const char *dest = payload->argv[i + values - 1];
    i += values;
    if (!mount) continue;
    if (!v3_normal_path(dest)) return NULL;
    char canonical[PATH_MAX];
    if (realpath(dest, canonical) != NULL && strcmp(canonical, dest) != 0 &&
        (v3_paths_overlap(dest, target) || v3_paths_overlap(canonical, target))) return NULL;
    if (strcmp(arg, "--proc") == 0 && strcmp(dest, "/proc") == 0) proc = true;
    if (strcmp(arg, "--ro-bind") == 0 && strcmp(source, parent) == 0 && strcmp(dest, parent) == 0) {
      if (readonly) return NULL;
      readonly = true;
      continue;
    }
    /* The generated launcher repeats mkdir scaffolding for existing
     * canonical ancestors already exposed by the initial read-only root.
     * Before the trusted bind these operations create no new mount/alias. */
    if (strcmp(arg, "--dir") == 0 && readonly_root && !readonly &&
        strcmp(dest, target) != 0 && v3_path_contains(dest, target)) {
      struct stat directory;
      if (realpath(dest, canonical) != NULL && strcmp(canonical, dest) == 0 &&
          stat(dest, &directory) == 0 && S_ISDIR(directory.st_mode)) continue;
      return NULL;
    }
    if (v3_paths_overlap(dest, target)) {
      /* Only the initial read-only root may precede the narrower trusted
       * runtime bind. No writable root, mask, alias or later overlay. */
      if (readonly || strcmp(arg, "--ro-bind") != 0 ||
          strcmp(source, "/") != 0 || strcmp(dest, "/") != 0) return NULL;
      readonly_root = true;
    }
    if (bind && strcmp(arg, "--ro-bind") != 0 &&
        realpath(source, canonical) != NULL && v3_paths_overlap(canonical, target)) return NULL;
  }
  if (!pid || !user || !death || !proc || !readonly || delimiter == 0 ||
      delimiter + 1 >= argc || payload->argv[delimiter + 1][0] != '/') return NULL;
  struct stat command, artifact;
  if (stat(payload->argv[delimiter + 1], &command) != 0 || stat(target, &artifact) != 0 ||
      (command.st_dev == artifact.st_dev && command.st_ino == artifact.st_ino)) return NULL;
  char **argv = calloc(argc + 9, sizeof(char *));
  if (argv == NULL) return NULL;
  size_t position = 0;
  for (size_t i = 0; i < delimiter; ++i) argv[position++] = payload->argv[i];
  argv[position++] = "--as-pid-1";
  argv[position++] = "--perms"; argv[position++] = "0500";
  argv[position++] = "--ro-bind-data"; argv[position++] = "6";
  argv[position++] = target;
  argv[position++] = "--"; argv[position++] = target;
  argv[position++] = "--namespace-init-v1";
  for (size_t i = delimiter + 1; i < argc; ++i) argv[position++] = payload->argv[i];
  return argv;
}

static int v3_image_reference(void) {
  int writable = v2_sealed_snapshot(agenc_namespace_init_image, sizeof(agenc_namespace_init_image));
  if (writable < 0) return -1;
  char path[64];
  int length = snprintf(path, sizeof(path), "/proc/self/fd/%d", writable);
  int reference = length > 0 && (size_t)length < sizeof(path)
      ? open(path, O_RDONLY | O_CLOEXEC) : -1;
  int closed = close(writable);
  if (closed != 0) { if (reference >= 0) (void)close(reference); return -1; }
  reference = v3_high_fd(reference);
  if (reference < 0) return -1;
  struct stat st;
  unsigned char buffer[4096];
  if (fstat(reference, &st) != 0 || st.st_size != (off_t)sizeof(agenc_namespace_init_image) ||
      fcntl(reference, F_GET_SEALS) != (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)) goto fail;
  for (size_t offset = 0; offset < sizeof(agenc_namespace_init_image);) {
    size_t count = sizeof(agenc_namespace_init_image) - offset;
    if (count > sizeof(buffer)) count = sizeof(buffer);
    ssize_t read_count = pread(reference, buffer, count, (off_t)offset);
    if (read_count < 0 && errno == EINTR) continue;
    if (read_count <= 0 || (size_t)read_count > count ||
        memcmp(buffer, agenc_namespace_init_image + offset, (size_t)read_count) != 0) goto fail;
    offset += (size_t)read_count;
  }
  if (lseek(reference, 0, SEEK_SET) == 0) return reference;
fail:
  (void)close(reference);
  return -1;
}

static int describe_v3_protocol(void) {
  char target[PATH_MAX], parent[PATH_MAX];
  if (v3_artifact_path(target, parent) != 0) return AGENC_BROKER_ERROR_EXIT;
  int reference = v3_image_reference();
  if (reference < 0 || close(reference) != 0) return AGENC_BROKER_ERROR_EXIT;
  return puts("AGB3 owner-pid sealed-static-init-ro-artifact-v1") < 0 ? AGENC_BROKER_ERROR_EXIT : 0;
}

static _Noreturn void run_v3_target_child(struct launch_payload *payload,
    char **argv, int snapshot, int reference, int writer, pid_t broker) {
  if (getppid() != broker || prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 ||
      getppid() != broker || setsid() < 0 || v2_pending_stop() != 0) _exit(125);
  reset_child_signals();
  if (getppid() != broker || write_status("S", 1) != 0 || close(3) != 0) _exit(125);
  if (snapshot >= 0 && dup2(snapshot, 3) != 3) _exit(125);
  if (dup2(writer, 4) != 4 || dup2(reference, 5) != 5 || dup2(reference, 6) != 6 ||
      close(writer) != 0 || close(reference) != 0 || close(v3_report_reader) != 0 ||
      (snapshot >= 0 && close(snapshot) != 0)) _exit(125);
  /* dup2 cleared CLOEXEC on exactly the four intended roles. FD6 shares the
   * reference offset, initially zero; the init verifies FD5 with pread. */
  if (getppid() != broker) _exit(125);
  execve(payload->program, argv, payload->environment);
  _exit(127);
}

static int launch_v3_supervised_target(sigset_t *wait_mask) {
  struct launch_payload payload = {0};
  int snapshot = -1, reference = -1, writer = -1, result = -1;
  char target[PATH_MAX], parent[PATH_MAX];
  char **argv = NULL;
  if (block_control_signals(wait_mask) != 0 || install_broker_handlers() != 0 ||
      enable_child_subreaper() != 0) return -1;
  if (read_owned_payload(&payload, &snapshot, "AGB3") != 0 ||
      verify_initial_child_ownership() != 0 || v2_owner_alive() != 0 ||
      v3_artifact_path(target, parent) != 0 ||
      (argv = v3_init_argv(&payload, target, parent)) == NULL) goto done;
  if (close(4) != 0) goto done;
  if (snapshot >= 0 && (snapshot = v3_high_fd(snapshot)) < 0) goto done;
  reference = v3_image_reference();
  if (reference < 0) goto done;
  int pipe_fds[2];
  if (pipe2(pipe_fds, O_CLOEXEC) != 0) goto done;
  v3_report_reader = v3_high_fd(pipe_fds[0]);
  writer = v3_high_fd(pipe_fds[1]);
  if (v3_report_reader < 0 || writer < 0 ||
      fcntl(v3_report_reader, F_SETFL, O_NONBLOCK) != 0 || v2_owner_alive() != 0) goto done;
  pid_t broker = getpid();
  root_pid = fork();
  if (root_pid == 0) run_v3_target_child(&payload, argv, snapshot, reference, writer, broker);
  if (root_pid < 0) goto done;
  result = 0;
  (void)close(STDIN_FILENO);
done:
  if (snapshot >= 0) (void)close(snapshot);
  if (reference >= 0) (void)close(reference);
  if (writer >= 0) (void)close(writer);
  if (result != 0 && v3_report_reader >= 0) { (void)close(v3_report_reader); v3_report_reader = -1; }
  free(argv);
  v2_free_payload(&payload);
  return result;
}

static bool v3_trusted_abort(void) {
  if (requested_signal != 0) return true;
  sigset_t pending;
  if (sigpending(&pending) != 0) return false;
  const int controls[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR2};
  for (size_t i = 0; i < AGENC_BROKER_ARRAY_LENGTH(controls); ++i)
    if (sigismember(&pending, controls[i]) == 1) return true;
  return false;
}

static int complete_v3_cleanup(int root_status) {
  bool unused;
  if (observe_residual_descendants(&unused) != 0 || force_cleanup_descendants() != 0)
    return AGENC_BROKER_ERROR_EXIT;
  unsigned char report[17];
  size_t length = 0;
  bool eof = false;
  while (length < sizeof(report)) {
    ssize_t count = read(v3_report_reader, report + length, sizeof(report) - length);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) break;
    if (count == 0) { eof = true; break; }
    length += (size_t)count;
  }
  (void)close(v3_report_reader); v3_report_reader = -1;
  bool valid = eof && length == 16 && memcmp(report, "AGI1", 4) == 0 &&
      report[4] == 1 && report[5] <= 1 && report[6] <= 1 && report[7] == 0 &&
      bootstrap_u32(report + 12) == 0;
  uint32_t value = valid ? bootstrap_u32(report + 8) : 0;
  valid = valid && (report[5] == 0 ? value <= 255 : value >= 1 && value <= 64);
  int normalized = valid ? (int)value + (report[5] == 1 ? 128 : 0) : 125;
  valid = valid && WIFEXITED(root_status) && WEXITSTATUS(root_status) == normalized;
  unsigned char terminal[12] = {'A','G','C','3',
      valid ? 0 : v3_trusted_abort() ? 1 : 2,
      valid ? report[6] : 2, valid ? report[5] : 2,
      valid ? (unsigned char)value : 0, 0,0,0,0};
  if (write_status((const char *)terminal, sizeof(terminal)) != 0 || close(3) != 0)
    return AGENC_BROKER_ERROR_EXIT;
  return valid ? normalized : AGENC_BROKER_ERROR_EXIT;
}


/* One-shot bypass executor. Its lifetime is itself held by the ordinary
 * subreaper broker. Each command receives new stdio and a new session, and
 * the existing owned-tree cleanup proves quiescence before its final frame.
 * The control channel is never inherited by a command. */
static int server_exact(int fd, void *buffer, size_t length, bool writing) {
  char *cursor = buffer;
  while (length > 0) {
    ssize_t n = writing ? write(fd, cursor, length) : read(fd, cursor, length);
    if (n < 0 && errno == EINTR && requested_signal == 0) continue;
    if (n <= 0 || requested_signal != 0) return -1;
    cursor += n; length -= (size_t)n;
  }
  return 0;
}
static int server_frame(char type, const void *data, uint32_t length) {
  unsigned char header[5] = {(unsigned char)type,
    (unsigned char)(length >> 24), (unsigned char)(length >> 16),
    (unsigned char)(length >> 8), (unsigned char)length};
  return server_exact(1, header, sizeof(header), true) ||
    (length > 0 && server_exact(1, (void *)data, length, true)) ? -1 : 0;
}
static char *server_receive(char *type, uint32_t *length) {
  unsigned char header[5];
  if (server_exact(0, header, sizeof(header), false)) return NULL;
  *type = (char)header[0]; *length = bootstrap_u32(header + 1);
  if (*length > AGENC_BROKER_MAX_PAYLOAD_BYTES) return NULL;
  char *data = calloc((size_t)*length + 1, 1);
  if (data == NULL) return NULL;
  if (server_exact(0, data, *length, false)) { free(data); return NULL; }
  return data;
}
static void server_child_changed(int signal_number) { (void)signal_number; }
static int server_command(char *data, uint32_t length) {
  if (length < 8) return -1;
  uint32_t argc = bootstrap_u32((unsigned char *)data);
  uint32_t envc = bootstrap_u32((unsigned char *)data + 4);
  if (!argc || argc >= AGENC_BROKER_MAX_STRINGS ||
      envc >= AGENC_BROKER_MAX_STRINGS - argc) return -1;
  char **args = calloc((size_t)argc + 1, sizeof(char *));
  char **env = calloc((size_t)envc + 1, sizeof(char *));
  int result = -1, in[2] = {-1, -1}, out[2] = {-1, -1}, err[2] = {-1, -1};
  if (args == NULL || env == NULL) goto finish;
  char *cursor = data + 8, *end = data + length;
  char *cwd = take_bootstrap_string(&cursor, end);
  char *program = take_bootstrap_string(&cursor, end);
  if (cwd == NULL || cwd[0] != '/' || program == NULL || !program[0]) goto finish;
  for (uint32_t i = 0; i < argc; ++i) {
    args[i] = take_bootstrap_string(&cursor, end);
    if (args[i] == NULL) goto finish;
  }
  for (uint32_t i = 0; i < envc; ++i) {
    env[i] = take_bootstrap_string(&cursor, end);
    if (env[i] == NULL) goto finish;
    char *equals = strchr(env[i], '=');
    if (equals == NULL || equals == env[i]) goto finish;
  }
  if (cursor != end ||
      socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, in) ||
      socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, out) ||
      socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, err)) goto finish;
  pid_t owner = getpid();
  root_pid = fork();
  if (root_pid < 0) goto finish;
  if (root_pid == 0) {
    reset_child_signals();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) || getppid() != owner ||
        setsid() < 0 || chdir(cwd) || dup2(in[0], 0) < 0 ||
        dup2(out[1], 1) < 0 || dup2(err[1], 2) < 0 ||
        syscall(SYS_close_range, 3U, ~0U, 0U)) _exit(125);
    environ = env;
    execvp(program, args);
    report_errno("exec failed"); _exit(127);
  }
  close(in[0]); in[0] = -1;
  if (shutdown(in[1], SHUT_WR)) goto finish;
  close(out[1]); out[1] = -1; close(err[1]); err[1] = -1;
  struct pollfd fds[3] = {{0, POLLIN, 0}, {out[0], POLLIN, 0}, {err[0], POLLIN, 0}};
  bool done = false, residual = false;
  int status = 0;
  sigset_t empty; sigemptyset(&empty);
  for (;;) {
    if (requested_signal != 0) goto finish;
    if (!done) {
      if (reap_until_blocked(&status, &done)) goto finish;
      if (done) {
        if (observe_residual_descendants(&residual) || force_cleanup_descendants()) goto finish;
        close(in[1]); in[1] = -1;
      }
    }
    if (done && fds[1].fd < 0 && fds[2].fd < 0) break;
    int ready = ppoll(fds, 3, NULL, &empty);
    if (ready < 0) { if (errno == EINTR) continue; goto finish; }
    if (fds[0].revents) {
      char type; uint32_t size;
      char *body = server_receive(&type, &size);
      if (body == NULL) goto finish;
      free(body);
      if (size != 0 || (type != 'T' && type != 'K' && type != 'E')) goto finish;
      if (!done && type != 'E' && signal_owned_tree(type == 'K' ? SIGKILL : SIGTERM)) goto finish;
    }
    for (int i = 1; i <= 2; ++i) if (fds[i].fd >= 0 && fds[i].revents) {
      char bytes[16384];
      ssize_t n = read(fds[i].fd, bytes, sizeof(bytes));
      if (n < 0) { if (errno == EINTR) continue; goto finish; }
      if (n == 0) {
        close(fds[i].fd); fds[i].fd = -1;
        if (i == 1) out[0] = -1; else err[0] = -1;
      } else if (server_frame(i == 1 ? 'O' : 'X', bytes, (uint32_t)n)) goto finish;
    }
  }
  unsigned char report[5] = {(unsigned char)((uint32_t)status >> 24),
    (unsigned char)((uint32_t)status >> 16), (unsigned char)((uint32_t)status >> 8),
    (unsigned char)status, residual ? 1 : 0};
  result = server_frame('D', report, sizeof(report));
finish:
  for (int i = 0; i < 2; ++i) {
    if (in[i] >= 0) close(in[i]);
    if (out[i] >= 0) close(out[i]);
    if (err[i] >= 0) close(err[i]);
  }
  free(args); free(env);
  if (result != 0) (void)signal_owned_tree(SIGKILL);
  if (force_cleanup_descendants()) result = -1;
  root_pid = AGENC_BROKER_INVALID_ROOT_PID;
  return result;
}
static int run_one_shot_server(void) {
  sigset_t mask, empty;
  if (prepare_broker(&mask) || install_handler(SIGCHLD, server_child_changed) ||
      /* Decline unsupported kernels before accepting any command. */
      syscall(SYS_close_range, ~0U, ~0U, 0U) ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) || server_frame('P', NULL, 0)) return 125;
  sigemptyset(&empty);
  for (;;) {
    struct pollfd input = {0, POLLIN, 0};
    if (requested_signal != 0) return 125;
    int ready = ppoll(&input, 1, NULL, &empty);
    if (ready < 0) { if (errno == EINTR) continue; return 125; }
    char type; uint32_t length;
    char *body = server_receive(&type, &length);
    if (body == NULL) return 125;
    int result = type == 'R' ? server_command(body, length) : -1;
    free(body);
    if (result != 0) return 125;
  }
}
