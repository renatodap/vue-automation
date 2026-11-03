import { spawn } from 'node:child_process';

/** The web process owns container health; the collector has its own retry loop. */
export function superviseHistory({
  spawnChild = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  exit = (code) => process.exit(code),
  log = (message) => console.log(message),
} = {}) {
  const children = new Set();
  let stopping = false;
  let exited = false;
  let exitCode = 0;
  let retryTimer;
  let shutdownTimer;
  let failures = 0;

  function finish() {
    if (exited) return;
    exited = true;
    clearTimer(shutdownTimer);
    exit(exitCode);
  }

  function watch(child, ended) {
    children.add(child);
    let settled = false;
    const done = (code) => {
      if (settled) return; // A failed spawn may emit both error and exit.
      settled = true;
      children.delete(child);
      if (stopping) {
        if (!children.size) finish();
      } else ended(code);
    };
    child.once('error', () => done(1));
    child.once('exit', done);
  }

  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    clearTimer(retryTimer);
    shutdownTimer = setTimer(() => {
      for (const child of children) child.kill('SIGKILL');
      finish();
    }, 10_000);
    for (const child of children) child.kill('SIGTERM');
    if (!children.size) finish();
  }

  function retryWorker(startedAt) {
    if (stopping) return;
    // A collector that ran for a minute recovered; subsequent failures begin
    // with the short delay again. Repeated startup failures cap at one minute.
    if (now() - startedAt >= 60_000) failures = 0;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6));
    log(JSON.stringify({ event: 'history_worker_restart_scheduled', delay_ms: delay }));
    retryTimer = setTimer(startWorker, delay);
  }

  function startWorker() {
    if (stopping) return;
    const startedAt = now();
    try {
      const child = spawnChild(process.execPath, [
        '--conditions=react-server', '--import', 'tsx', 'scripts/history-worker.ts',
      ], { stdio: 'inherit' });
      watch(child, () => retryWorker(startedAt));
    } catch {
      retryWorker(startedAt);
    }
  }

  try {
    const web = spawnChild(process.execPath, ['node_modules/next/dist/bin/next', 'start'], { stdio: 'inherit' });
    watch(web, (code) => stop(code || 1));
    startWorker();
  } catch {
    stop(1);
  }
  return { stop };
}
