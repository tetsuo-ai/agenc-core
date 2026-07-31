#define _GNU_SOURCE

#include <errno.h>
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
  AGENC_BROKER_PROGRAM_ARGUMENT = 1,
  AGENC_BROKER_ARGV0_ARGUMENT = 2,
  AGENC_BROKER_FIRST_TARGET_ARGUMENT = 3,
  AGENC_BROKER_MINIMUM_ARGUMENT_COUNT = 3,
  AGENC_BROKER_TARGET_ARGV0_INDEX = 0,
  AGENC_BROKER_TARGET_FIRST_ARGUMENT = 1,
  AGENC_BROKER_TARGET_NULL_SLOT_COUNT = 1,
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

int main(int argc, char **argv);
static int validate_invocation(int argc);
static int prepare_broker(sigset_t *wait_mask);
static int block_control_signals(sigset_t *wait_mask);
static int enable_child_subreaper(void);
static int install_broker_handlers(void);
static int arm_owner_death_signal(pid_t owner_pid);
static int verify_initial_child_ownership(void);
static char **create_target_argv(int argc, char **argv);
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
  char **target_argv;
  int root_status = AGENC_BROKER_EMPTY_WAIT_STATUS;
  bool residual_observed = false;

  if (validate_invocation(argc) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (prepare_broker(&wait_mask) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  target_argv = create_target_argv(argc, argv);
  if (target_argv == NULL) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (start_root_process(argv[AGENC_BROKER_PROGRAM_ARGUMENT], target_argv) !=
      AGENC_BROKER_SUCCESS) {
    free(target_argv);
    return AGENC_BROKER_ERROR_EXIT;
  }
  free(target_argv);
  (void)close(STDIN_FILENO);

  if (monitor_root_process(&wait_mask, &root_status) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (observe_residual_descendants(&residual_observed) !=
      AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (force_cleanup_descendants() != AGENC_BROKER_SUCCESS) {
    report_errno("descendant cleanup failed");
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (publish_cleanup_status(residual_observed) != AGENC_BROKER_SUCCESS) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  (void)close(AGENC_BROKER_STATUS_FD);
  exit_like_root(root_status);
}

static int validate_invocation(int argc) {
  if (argc >= AGENC_BROKER_MINIMUM_ARGUMENT_COUNT) {
    return AGENC_BROKER_SUCCESS;
  }
  report_message("expected program and argv0");
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

static char **create_target_argv(int argc, char **argv) {
  size_t target_argument_count =
      (size_t)argc - (size_t)AGENC_BROKER_ARGV0_ARGUMENT;
  size_t target_pointer_count =
      target_argument_count + AGENC_BROKER_TARGET_NULL_SLOT_COUNT;
  char **target_argv = calloc(target_pointer_count, sizeof(*target_argv));
  int source_index;
  size_t target_index = AGENC_BROKER_TARGET_FIRST_ARGUMENT;

  if (target_argv == NULL) {
    return NULL;
  }
  target_argv[AGENC_BROKER_TARGET_ARGV0_INDEX] =
      argv[AGENC_BROKER_ARGV0_ARGUMENT];
  for (source_index = AGENC_BROKER_FIRST_TARGET_ARGUMENT; source_index < argc;
       ++source_index, ++target_index) {
    target_argv[target_index] = argv[source_index];
  }
  target_argv[target_index] = NULL;
  return target_argv;
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

static int signal_direct_child(pid_t child_pid, const void *context) {
  const struct child_signal_context *signal_context = context;

  if (child_pid == root_pid ||
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
  (void)kill(root_pid, signal_number);
}

static int signal_owned_tree(int signal_number) {
  int result = AGENC_BROKER_SUCCESS;

  if (root_pid > AGENC_BROKER_MAXIMUM_UNSAFE_PID) {
    if (kill(-root_pid, signal_number) != AGENC_BROKER_SUCCESS &&
        errno != ESRCH) {
      result = AGENC_BROKER_FAILURE;
    }
    if (kill(root_pid, signal_number) != AGENC_BROKER_SUCCESS &&
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
