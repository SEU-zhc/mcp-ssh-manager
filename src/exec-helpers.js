// Helpers for safely executing commands that may background a long-running
// child (nohup/&) over a non-interactive SSH exec channel.

/**
 * Prefixes a command so any child it backgrounds (`nohup cmd &`) inherits an
 * already-closed stdin instead of the live exec-channel pipe.
 *
 * Without this, the SSH server withholds channel EOF/close until every
 * process holding fd 0 exits. `nohup cmd > log 2>&1 &` only redirects fds 1
 * and 2, so a detached long-running job keeps fd 0 open and the exec call
 * hangs — even though the remote job started fine and is still running —
 * until the local `timeout` wrapper force-kills it and the call reports a
 * false timeout/failure.
 */
export function withStdinDetached(command, { rawCommand = false } = {}) {
  if (rawCommand) return command;
  return `exec 0</dev/null; ${command}`;
}

function shQuote(str) {
  return `'${str.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Wraps a command to run fully detached from the current SSH session:
 * stdout/stderr go to logFile, stdin is /dev/null, and the backgrounded
 * process's pid is echoed so the caller can poll or kill it later.
 */
export function buildBackgroundCommand(command, logFile) {
  return `nohup sh -c ${shQuote(command)} > ${shQuote(logFile)} 2>&1 < /dev/null & echo $!`;
}

/**
 * Parses the pid echoed by buildBackgroundCommand's output. Returns null if
 * the output isn't a valid pid (e.g. the launch itself failed).
 */
export function parseBackgroundPid(stdout) {
  const pid = parseInt(String(stdout ?? '').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/** Auto-generated log file path used when the caller doesn't supply one. */
export function defaultBackgroundLogFile() {
  return `/tmp/mcp-ssh-manager-bg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`;
}
