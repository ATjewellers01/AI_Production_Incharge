/**
 * Next.js runs `register()` here automatically on server startup, before
 * any route handler — the earliest hook available without hand-editing the
 * auto-generated .next/standalone/server.js (which would be overwritten on
 * every build anyway).
 *
 * Diagnostic-only: this service's Render deploy logs show a clean
 * "Ready"/"live" boot every time, yet every request 502s with ZERO new log
 * output — meaning if the process is crashing, it's dying too fast/silently
 * for the normal try/catch blocks in the route handlers to ever run. These
 * process-level listeners are a last-resort net to force *something* out to
 * stdout before the process actually exits, so Render's Logs tab has a
 * chance of showing it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('uncaughtException', (err) => {
      console.error('[FATAL uncaughtException]', err?.stack || err);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[FATAL unhandledRejection]', reason);
    });
    process.on('exit', (code) => {
      console.error('[process exit]', code);
    });
    console.log('[instrumentation] registered, pid=', process.pid, 'port=', process.env.PORT);
  }
}
