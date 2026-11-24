// TILT LAN server: serves index.html and relays game messages (no internet needed).
// Run:  node Server.js   then open the printed address on any device on your WiFi.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const PORT = process.env.PORT || 3000;
const HOST_GRACE = 60000;      // ms a room survives while its host reconnects
const HEARTBEAT = 8000;        // both ends use this to notice a dead connection
const MAX_BODY = 64 * 1024, MAX_ROOMS = 200, MAX_GUESTS = 12;
const rooms = new Map();       // code -> {key, host, guests: Map(id -> res), timer}
const streams = new Set();
const isCode = s => /^[A-Z0-9]{5}$/.test(s || ''), isId = s => /^[\w-]{1,64}$/.test(s || '');

const lan = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);

const push = (res, o) => { if (res && !res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
const tell = (r, o) => r.guests.forEach(g => push(g, o));
const shut = (r, why) => r.guests.forEach(g => { push(g, { t: 'closed', why }); g.end(); });

function openStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(':ok\n\n');
  streams.add(res);
  res.on('close', () => streams.delete(res));
}
setInterval(() => streams.forEach(r => push(r, { t: 'hb' })), HEARTBEAT);

function hostStream(res, code, key) {
  let r = rooms.get(code);
  if (!isCode(code) || !isId(key) || (!r && rooms.size >= MAX_ROOMS)) { push(res, { t: 'busy' }); return res.end(); }
  if (r && r.key !== key) { push(res, { t: 'taken' }); return res.end(); }
  if (r) clearTimeout(r.timer);
  else rooms.set(code, r = { key, host: null, guests: new Map(), timer: null });
  const old = r.host;
  r.host = res;
  if (old) old.end();
  push(res, { t: 'ready', hb: 1, ids: [...r.guests.keys()] });   // who is here now, so the host can catch up
  tell(r, { t: 'back' });
  res.on('close', () => {
    if (r.host !== res) return;                 // a newer connection already took over
    r.host = null;
    if (rooms.get(code) !== r) return;          // already closed by /bye
    tell(r, { t: 'away' });
    r.timer = setTimeout(() => {
      shut(r);
      if (rooms.get(code) === r) rooms.delete(code);
    }, HOST_GRACE);
  });
}

function guestStream(res, code, id) {
  const r = rooms.get(code);
  if (!r || !isId(id)) { push(res, { t: 'noroom' }); return res.end(); }
  const old = r.guests.get(id);
  if (!old && r.guests.size >= MAX_GUESTS) { push(res, { t: 'msg', m: { t: 'full' } }); return res.end(); }
  r.guests.set(id, res);
  if (old) old.end();
  push(r.host, { t: 'join', id });
  push(res, { t: 'ready', hb: 1, away: !r.host });
  res.on('close', () => {
    if (r.guests.get(id) !== res) return;       // same player already reconnected
    r.guests.delete(id);
    push(r.host, { t: 'left', id });
  });
}

function relay(req, res, q) {
  let body = '', dead = false;
  const end = (code, text) => { res.writeHead(code); res.end(text); };
  req.setEncoding('utf8');
  req.on('data', d => {
    if (dead) return;
    body += d;
    if (body.length > MAX_BODY) { dead = true; res.writeHead(413, { Connection: 'close' }); res.end('too big', () => req.destroy()); }
  });
  req.on('end', () => {
    if (dead) return;
    const r = rooms.get(q.get('room')), from = q.get('from'), to = q.get('to');
    if (!r) return end(404, 'no room');
    let m;
    try { m = JSON.parse(body); } catch (e) { return end(400, 'bad'); }
    if (to === 'host') {
      if (!r.guests.has(from)) return end(409, 'not joined');
      if (!r.host) return end(503, 'host away');          // the sender tries again
      push(r.host, { t: 'msg', id: from, m });
    } else if (from === r.key) push(r.guests.get(to), { t: 'msg', m });
    else return end(403, 'no');
    end(200, 'ok');
  });
}

http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const q = u.searchParams;
  if (u.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ app: 'tilt-relay', lan: lan() }));
  }
  if (u.pathname === '/ev') {
    openStream(res);
    return q.get('role') === 'host' ? hostStream(res, q.get('room'), q.get('key')) : guestStream(res, q.get('room'), q.get('id'));
  }
  if (u.pathname === '/bye' && req.method === 'POST') {   // host closed the tab: end the room now
    const r = rooms.get(q.get('room'));
    if (r && r.key === q.get('key')) {
      clearTimeout(r.timer);
      rooms.delete(q.get('room'));
      shut(r, 'bye');
      r.host = null;
    }
    return res.end();
  }
  if (u.pathname === '/send' && req.method === 'POST') return relay(req, res, q);
  if (u.pathname !== '/' && u.pathname !== '/index.html') { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { res.writeHead(500); return res.end('index.html not found next to Server.js'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}).on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `\nPort ${PORT} is already in use. TILT may already be running at http://localhost:${PORT}\nTo use another port, set PORT first (for example PORT=3001).\n` : e.message);
  process.exit(1);
}).listen(PORT, '0.0.0.0', () => {
  console.log('\nTILT is running. Open on any device on the same WiFi:\n');
  lan().forEach(a => console.log('   ' + a));
  console.log('\n   (this computer: http://localhost:' + PORT + ')\n');
});
