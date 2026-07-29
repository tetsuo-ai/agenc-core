#define _GNU_SOURCE

#include <errno.h>
#include <signal.h>
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

#define AGENC_BROKER_ERROR_EXIT 125
#define AGENC_BROKER_EXEC_EXIT 127
#define AGENC_BROKER_STATUS_FD 3

static volatile sig_atomic_t requested_signal = 0;
static pid_t root_pid = -1;

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
  memset(&action, 0, sizeof(action));
  action.sa_handler = handler;
  sigemptyset(&action.sa_mask);
  return sigaction(signal_number, &action, NULL);
}

static void reset_child_signals(void) {
  struct sigaction action;
  sigset_t mask;
  int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR2, SIGPIPE};
  size_t index;

  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  for (index = 0; index < sizeof(signals) / sizeof(signals[0]); index += 1) {
    (void)sigaction(signals[index], &action, NULL);
  }
  sigemptyset(&mask);
  (void)sigprocmask(SIG_SETMASK, &mask, NULL);
}

static int scan_direct_children(
  int signal_number,
  size_t *count_out
) {
  char path[128];
  FILE *stream;
  size_t count = 0;
  long candidate;
  int path_length;
  int scan_result = EOF;

  path_length = snprintf(
    path,
    sizeof(path),
    "/proc/self/task/%ld/children",
    (long)getpid()
  );
  if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
    return -1;
  }
  stream = fopen(path, "r");
  if (stream == NULL) {
    return -1;
  }
  while ((scan_result = fscanf(stream, "%ld", &candidate)) == 1) {
    if (candidate <= 1 || candidate > INT32_MAX || count == SIZE_MAX) {
      (void)fclose(stream);
      return -1;
    }
    count += 1;
    if (signal_number != 0 && (pid_t)candidate != root_pid) {
      if (
        kill((pid_t)candidate, signal_number) != 0 &&
        errno != ESRCH
      ) {
        (void)fclose(stream);
        return -1;
      }
    }
  }
  if (ferror(stream) != 0 || scan_result != EOF) {
    (void)fclose(stream);
    return -1;
  }
  (void)fclose(stream);
  *count_out = count;
  return 0;
}

static int signal_direct_children(int signal_number) {
  size_t count = 0;

  return scan_direct_children(signal_number, &count);
}

static int signal_owned_tree(int signal_number) {
  int failed = 0;

  if (root_pid > 1) {
    if (kill(-root_pid, signal_number) != 0 && errno != ESRCH) {
      failed = -1;
    }
    if (kill(root_pid, signal_number) != 0 && errno != ESRCH) {
      failed = -1;
    }
  }
  if (signal_direct_children(signal_number) != 0) {
    failed = -1;
  }
  return failed;
}

static int reap_nonblocking(int *has_children) {
  int status;
  pid_t waited;

  *has_children = 0;
  for (;;) {
    waited = waitpid(-1, &status, WNOHANG);
    if (waited > 0) {
      continue;
    }
    if (waited == 0) {
      *has_children = 1;
      return 0;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == ECHILD) {
      return 0;
    }
    return -1;
  }
}

static int reap_until_blocked(
  int *root_status,
  int *root_finished
) {
  for (;;) {
    int status;
    pid_t waited = waitpid(-1, &status, WNOHANG);

    if (waited > 0) {
      if (waited == root_pid) {
        *root_status = status;
        *root_finished = 1;
      }
      continue;
    }
    if (waited == 0) {
      return 0;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == ECHILD && *root_finished) {
      return 0;
    }
    return -1;
  }
}

static int force_cleanup_descendants(void) {
  const struct timespec retry = {0, 1000000};

  for (;;) {
    int has_children = 0;
    if (reap_nonblocking(&has_children) != 0) {
      return -1;
    }
    if (!has_children) {
      return 0;
    }
    if (signal_direct_children(SIGKILL) != 0) {
      return -1;
    }
    (void)nanosleep(&retry, NULL);
  }
}

static int write_status(const char *message, size_t length) {
  size_t offset = 0;

  while (offset < length) {
    ssize_t written = write(
      AGENC_BROKER_STATUS_FD,
      message + offset,
      length - offset
    );
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    return -1;
  }
  return 0;
}

static void exit_like_root(int status) {
  if (WIFEXITED(status)) {
    _exit(WEXITSTATUS(status));
  }
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    struct sigaction action;
    sigset_t mask;

    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    (void)sigaction(signal_number, &action, NULL);
    sigemptyset(&mask);
    (void)sigprocmask(SIG_SETMASK, &mask, NULL);
    (void)kill(getpid(), signal_number);
    _exit(128 + signal_number);
  }
  _exit(AGENC_BROKER_ERROR_EXIT);
}

int main(int argc, char **argv) {
  pid_t owner_pid;
  int root_status = 0;
  int root_finished = 0;
  int residual_observed = 0;
  char **target_argv;
  sigset_t wait_mask;
  int index;

  if (argc < 3) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: expected program and argv0\n"
    );
    return AGENC_BROKER_ERROR_EXIT;
  }

  owner_pid = getppid();
  sigemptyset(&wait_mask);
  sigaddset(&wait_mask, SIGTERM);
  sigaddset(&wait_mask, SIGINT);
  sigaddset(&wait_mask, SIGHUP);
  sigaddset(&wait_mask, SIGUSR2);
  sigaddset(&wait_mask, SIGCHLD);
  if (sigprocmask(SIG_BLOCK, &wait_mask, NULL) != 0) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: signal mask setup failed: %s\n",
      strerror(errno)
    );
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: ownership setup failed: %s\n",
      strerror(errno)
    );
    return AGENC_BROKER_ERROR_EXIT;
  }
  /*
   * Install SIGUSR2 before arming PDEATHSIG. Otherwise an owner exit in the
   * small interval between those operations would take the default action and
   * terminate the broker before it could reap the owned tree.
   */
  if (
    install_handler(SIGTERM, request_graceful_stop) != 0 ||
    install_handler(SIGINT, request_graceful_stop) != 0 ||
    install_handler(SIGHUP, request_forced_stop) != 0 ||
    install_handler(SIGUSR2, request_forced_stop) != 0 ||
    install_handler(SIGPIPE, SIG_IGN) != 0
  ) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: signal setup failed: %s\n",
      strerror(errno)
    );
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (prctl(PR_SET_PDEATHSIG, SIGUSR2, 0, 0, 0) != 0) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: owner-death setup failed: %s\n",
      strerror(errno)
    );
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (getppid() != owner_pid) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  {
    size_t child_count = 0;
    if (
      scan_direct_children(0, &child_count) != 0 ||
      child_count != 0
    ) {
      dprintf(
        STDERR_FILENO,
        "agenc-process-broker: child ownership enumeration unavailable\n"
      );
      return AGENC_BROKER_ERROR_EXIT;
    }
  }

  target_argv = calloc((size_t)argc - 1, sizeof(char *));
  if (target_argv == NULL) {
    return AGENC_BROKER_ERROR_EXIT;
  }
  target_argv[0] = argv[2];
  for (index = 3; index < argc; index += 1) {
    target_argv[index - 2] = argv[index];
  }
  target_argv[argc - 2] = NULL;

  root_pid = fork();
  if (root_pid < 0) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: fork failed: %s\n",
      strerror(errno)
    );
    free(target_argv);
    return AGENC_BROKER_ERROR_EXIT;
  }
  if (root_pid == 0) {
    pid_t broker_pid = getppid();
    reset_child_signals();
    if (
      prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 ||
      getppid() != broker_pid ||
      setsid() < 0
    ) {
      _exit(AGENC_BROKER_ERROR_EXIT);
    }
    if (write_status("S", 1U) != 0) {
      _exit(AGENC_BROKER_ERROR_EXIT);
    }
    (void)close(AGENC_BROKER_STATUS_FD);
    execvp(argv[1], target_argv);
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: exec failed: %s\n",
      strerror(errno)
    );
    _exit(AGENC_BROKER_EXEC_EXIT);
  }

  free(target_argv);
  (void)close(STDIN_FILENO);

  while (!root_finished) {
    int observed_signal;

    if (reap_until_blocked(&root_status, &root_finished) != 0) {
      dprintf(
        STDERR_FILENO,
        "agenc-process-broker: wait failed: %s\n",
        strerror(errno)
      );
      (void)signal_owned_tree(SIGKILL);
      return AGENC_BROKER_ERROR_EXIT;
    }
    if (root_finished) {
      break;
    }
    if (
      requested_signal != 0 &&
      signal_owned_tree((int)requested_signal) != 0
    ) {
      dprintf(
        STDERR_FILENO,
        "agenc-process-broker: child ownership enumeration failed\n"
      );
      (void)kill(-root_pid, SIGKILL);
      (void)kill(root_pid, SIGKILL);
      return AGENC_BROKER_ERROR_EXIT;
    }
    do {
      observed_signal = sigwaitinfo(&wait_mask, NULL);
    } while (observed_signal < 0 && errno == EINTR);
    if (observed_signal < 0) {
      dprintf(
        STDERR_FILENO,
        "agenc-process-broker: signal wait failed: %s\n",
        strerror(errno)
      );
      (void)signal_owned_tree(SIGKILL);
      return AGENC_BROKER_ERROR_EXIT;
    }
    if (observed_signal == SIGTERM || observed_signal == SIGINT) {
      request_graceful_stop(observed_signal);
    } else if (
      observed_signal == SIGHUP ||
      observed_signal == SIGUSR2
    ) {
      request_forced_stop(observed_signal);
    }
  }

  {
    size_t child_count = 0;
    if (scan_direct_children(0, &child_count) != 0) {
      dprintf(
        STDERR_FILENO,
        "agenc-process-broker: residual enumeration failed\n"
      );
      return AGENC_BROKER_ERROR_EXIT;
    }
    if (child_count > 0) {
      residual_observed = 1;
    }
  }

  if (force_cleanup_descendants() != 0) {
    dprintf(
      STDERR_FILENO,
      "agenc-process-broker: descendant cleanup failed: %s\n",
      strerror(errno)
    );
    return AGENC_BROKER_ERROR_EXIT;
  }
  {
    const char *status_message = residual_observed ? "RC" : "C";
    size_t status_length = residual_observed ? 2U : 1U;
    if (write_status(status_message, status_length) != 0) {
      return AGENC_BROKER_ERROR_EXIT;
    }
  }
  (void)close(AGENC_BROKER_STATUS_FD);
  exit_like_root(root_status);
}
