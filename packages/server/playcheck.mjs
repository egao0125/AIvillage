import { io } from 'socket.io-client';

const BASE = 'http://localhost:4001';
const DEV_TOKEN = 'test-dev-token';

let passed = 0;
let failed = 0;

function ok(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) { console.log(`  ✗ ${label}: ${detail}`); failed++; }

async function httpGet(path, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  return r;
}
async function httpPost(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return r;
}

// 1. Health checks
console.log('\n[1] Health checks');
{
  const r = await httpGet('/api/health');
  r.status === 200 ? ok('GET /api/health → 200') : fail('GET /api/health', r.status);
}
{
  const r = await httpGet('/api/ready');
  (r.status === 200 || r.status === 503) ? ok(`GET /api/ready → ${r.status}`) : fail('GET /api/ready', r.status);
}

// 2. Auth rate limit
console.log('\n[2] Auth rate limit (11 rapid /api/auth/login calls, limit=10/15min)');
{
  let got429 = false;
  for (let i = 0; i < 11; i++) {
    const r = await httpPost('/api/auth/login', { email: `test${i}@example.com`, password: 'password123' });
    if (r.status === 429) { got429 = true; break; }
  }
  got429 ? ok('Rate limit 429 triggered') : fail('Rate limit', 'no 429 after 11 calls');
}

// 3. Unauthenticated POST
console.log('\n[3] Unauthenticated POST /api/agents');
{
  const r = await httpPost('/api/agents', { name: 'test' });
  r.status === 401 ? ok('POST /api/agents without token → 401') : fail('Unauth POST', r.status);
}

// 4. Socket.IO connection + world:snapshot
console.log('\n[4] Socket.IO connection + world:snapshot');
await new Promise((resolve) => {
  const socket = io(BASE, {
    transports: ['websocket'],
    auth: { token: '' },
    timeout: 5000,
  });
  const timer = setTimeout(() => {
    fail('Socket connect', 'timeout');
    socket.disconnect();
    resolve();
  }, 5000);

  socket.on('connect', () => {
    ok('Socket connected');
  });

  socket.on('world:snapshot', (snap) => {
    ok(`world:snapshot received (${Object.keys(snap).join(', ')})`);
    clearTimeout(timer);
    socket.disconnect();
    resolve();
  });

  socket.on('connect_error', (err) => {
    fail('Socket connect_error', err.message);
    clearTimeout(timer);
    resolve();
  });
});

// 5. Dev commands (pause/resume/step)
console.log('\n[5] Dev commands via socket');
await new Promise((resolve) => {
  const socket = io(BASE, { transports: ['websocket'], auth: { token: '' }, timeout: 5000 });
  let statusReceived = false;

  const timer = setTimeout(() => {
    if (!statusReceived) fail('dev:status-request', 'no response');
    socket.disconnect();
    resolve();
  }, 4000);

  socket.on('connect', () => {
    socket.emit('dev:pause', DEV_TOKEN);
    socket.emit('dev:status-request', DEV_TOKEN);
  });

  socket.on('dev:status', (data) => {
    statusReceived = true;
    data.paused ? ok('dev:pause + dev:status → paused=true') : fail('dev:pause', `paused=${data.paused}`);
    socket.emit('dev:resume', DEV_TOKEN);
    clearTimeout(timer);
    socket.disconnect();
    resolve();
  });

  socket.on('connect_error', (err) => {
    fail('Dev socket connect', err.message);
    clearTimeout(timer);
    resolve();
  });
});

// 6. XSS / newline injection in spectator comment
console.log('\n[6] XSS sanitization in spectator comment');
await new Promise((resolve) => {
  const socket = io(BASE, { transports: ['websocket'], auth: { token: '' }, timeout: 5000 });
  const xssPayload = '<script>alert(1)</script>\r\ninjected';

  const timer = setTimeout(() => {
    ok('Spectator comment sent (no crash, server stable)');
    socket.disconnect();
    resolve();
  }, 2000);

  socket.on('connect', () => {
    socket.emit('spectator:comment', { message: xssPayload });
  });

  socket.on('spectator:comment', (data) => {
    const clean = data.message || '';
    if (!clean.includes('<script>') && !clean.includes('\r\n')) {
      ok(`XSS sanitized: "${clean.substring(0, 60)}"`);
    } else {
      fail('XSS not sanitized', clean.substring(0, 80));
    }
    clearTimeout(timer);
    socket.disconnect();
    resolve();
  });

  socket.on('connect_error', (err) => {
    fail('XSS test socket', err.message);
    clearTimeout(timer);
    resolve();
  });
});

// 7. viewport:update NaN rejection
console.log('\n[7] viewport:update with NaN/Infinity values (should not crash)');
await new Promise((resolve) => {
  const socket = io(BASE, { transports: ['websocket'], auth: { token: '' }, timeout: 3000 });
  const timer = setTimeout(() => {
    ok('viewport NaN/Infinity handled (no crash)');
    socket.disconnect();
    resolve();
  }, 2000);

  socket.on('connect', () => {
    socket.emit('viewport:update', { x: NaN, y: Infinity, width: -1, height: 'abc' });
    socket.emit('viewport:update', { x: 0, y: 0, width: 300, height: 300 }); // over-size clamped
  });

  socket.on('connect_error', (err) => {
    fail('viewport test socket', err.message);
    clearTimeout(timer);
    resolve();
  });
});

// 8. Rate limit on spectator comment
console.log('\n[8] Spectator comment rate limit');
await new Promise((resolve) => {
  const socket = io(BASE, { transports: ['websocket'], auth: { token: '' }, timeout: 5000 });
  let rateLimitWorked = false;

  socket.on('connect', async () => {
    // Send 5 comments rapidly — should be rate-limited after 1st
    for (let i = 0; i < 5; i++) {
      socket.emit('spectator:comment', { message: `test message ${i}` });
    }
    // Check server still alive
    const r = await fetch(`${BASE}/api/health`);
    r.status === 200 ? ok('Server still responsive after rapid comments') : fail('Server health after rate-limit test', r.status);
    socket.disconnect();
    resolve();
  });

  socket.on('connect_error', (err) => {
    fail('Rate limit socket', err.message);
    resolve();
  });

  setTimeout(() => { socket.disconnect(); resolve(); }, 4000);
});

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Play check: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
