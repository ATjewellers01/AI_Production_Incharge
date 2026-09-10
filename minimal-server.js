// Absolute minimal diagnostic server — no Next.js, no Prisma, no framework
// of any kind. Pure Node.js `http` module. Purpose: eliminate Next.js/the
// standalone build output entirely as a possible cause of the persistent,
// log-free 502 this service has shown on every route (including
// zero-dependency Next.js routes /api/ping and /hello). If even THIS
// 502s with no log line, Next.js is conclusively not the cause either —
// nothing short of Render's own platform/routing layer would remain.
const http = require('http');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  console.log(`[minimal-server] request: ${req.method} ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`hello from minimal server, pid=${process.pid}, time=${new Date().toISOString()}\n`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[minimal-server] listening on 0.0.0.0:${PORT}, pid=${process.pid}`);
});

process.on('uncaughtException', (err) => console.error('[minimal-server FATAL]', err));
process.on('exit', (code) => console.error('[minimal-server exit]', code));
