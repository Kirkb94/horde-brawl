'use strict';
// Horde Duel online relay server.
// One process serves the game page and a WebSocket relay. A room is up to 16 players;
// the room creator's browser runs the simulation (host) and the server only forwards messages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;
const MAX_ROOMS = +(process.env.MAX_ROOMS || 60);
const MAX_ROOMS_PER_IP = +(process.env.MAX_ROOMS_PER_IP || 3);
const roomsOfIp = ip => { let n = 0; for (const r of rooms.values()) if (r.ip === ip && r.players.size) n++; return n; };
const HOST_RELAY_MAX = 240 * 1024;   // host snapshots can be big
const CLIENT_RELAY_MAX = 32 * 1024;  // client inputs are small
const CLIENT_RELAY_RATE = 120;       // max relay 'r' messages per second from a non-host client
const LIMITS = { create: [3, 10000], join: [8, 10000], quick: [4, 10000], upd: [6, 5000], start: [4, 5000], lobby: [4, 5000] };   // [max, window ms]
const IP_JOIN_MAX = +(process.env.IP_JOIN_MAX || 30);   // join+quick attempts per IP per window (all sockets share it)
const IP_JOIN_WINDOW = 10000;
const ipJoin = new Map();   // ip -> { n, t }
function allowIp(ws) {
  const ip = ws.ip; if (!ip) return true;
  const now = Date.now();
  if (ipJoin.size > 5000) { for (const [k, v] of ipJoin) if (now - v.t > IP_JOIN_WINDOW) ipJoin.delete(k); }
  let b = ipJoin.get(ip);
  if (!b || now - b.t > IP_JOIN_WINDOW) { b = { n: 0, t: now }; ipJoin.set(ip, b); }
  return ++b.n <= IP_JOIN_MAX;
}
function allow(ws, type) {
  const L = LIMITS[type]; if (!L) return true;
  const now = Date.now(); const b = ws.lim[type] || (ws.lim[type] = { n: 0, t: now });
  if (now - b.t > L[1]) { b.n = 0; b.t = now; }
  if (++b.n > L[0]) return false;
  if ((type === 'join' || type === 'quick') && !allowIp(ws)) return false;
  return true;
}
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const WEAPONS = ['pistol', 'revolver', 'smg', 'rifle', 'shotgun', 'rocket', 'sword', 'sniper'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const LONG_CACHE = new Set(['.mp3', '.ogg', '.wav', '.jpg', '.jpeg', '.webp', '.png', '.ico', '.woff', '.woff2', '.ttf', '.otf']);

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const gzCache = new Map();   // full path -> { etag, buf }
const STATS_LIMIT = 20, STATS_WINDOW = 60000;   // /stats requests per IP per minute
const statsHits = new Map();   // ip -> { n, t }
setInterval(() => { const now = Date.now(); for (const [k, v] of statsHits) if (now - v.t > STATS_WINDOW) statsHits.delete(k); }, STATS_WINDOW).unref();
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain', 'Allow': 'GET, HEAD' }); return res.end('Method not allowed'); }
  const isHead = req.method === 'HEAD';
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/stats') {
    const sip = clientIp(req), snow = Date.now();
    let sb = statsHits.get(sip);
    if (!sb || snow - sb.t > STATS_WINDOW) { sb = { n: 0, t: snow }; statsHits.set(sip, sb); }
    if (++sb.n > STATS_LIMIT) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.max(1, Math.ceil((sb.t + STATS_WINDOW - snow) / 1000))) });
      return res.end(JSON.stringify({ error: 'Slow down' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    let liveRooms = 0, livePlayers = 0;
    for (const r of rooms.values()) {
      let n = 0;
      for (const q of r.players.values()) if (q.ws && q.ws.readyState === 1) n++;
      if (n) { liveRooms++; livePlayers += n; }
    }
    return res.end(JSON.stringify({ rooms: liveRooms, players: livePlayers }));
  }
  let file = url === '/' ? '/index.html' : url;
  try { file = decodeURIComponent(file); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Bad request'); }
  if (file.indexOf('\0') !== -1) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Bad request'); }
  file = file.replace(/\\/g, '/');
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const root = path.resolve(PUBLIC);
  const full = path.resolve(root, '.' + path.sep + file);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(seg => seg.charAt(0) === '.')) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden'); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    const ctype = MIME[ext] || 'application/octet-stream';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const baseHeaders = { 'Content-Type': ctype, 'Cache-Control': LONG_CACHE.has(ext) ? 'public, max-age=604800' : 'no-cache', 'ETag': etag, 'Vary': 'Accept-Encoding' };
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && (inm.trim() === '*' || inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')))) { res.writeHead(304, baseHeaders); return res.end(); }
    const wantGz = COMPRESSIBLE.has(ext) && st.size > 512 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (wantGz) {
      const hit = gzCache.get(full);
      const send200 = buf => {
        res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Encoding': 'gzip', 'Content-Length': buf.length }));
        res.end(isHead ? undefined : buf);
      };
      if (hit && hit.etag === etag) return send200(hit.buf);
      return fs.readFile(full, (e2, data) => {
        if (e2) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end(); }
        zlib.gzip(data, { level: 9 }, (e3, buf) => {
          if (e3) { res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': data.length })); return res.end(isHead ? undefined : data); }
          gzCache.set(full, { etag, buf });
          send200(buf);
        });
      });
    }
    const hdrs = Object.assign({}, baseHeaders, { 'Accept-Ranges': 'bytes' });
    let status = 200, rStart = 0, rEnd = st.size - 1;
    const rm = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    const ifr = req.headers['if-range'];
    if (rm && (rm[1] !== '' || rm[2] !== '') && (!ifr || ifr === etag)) {
      if (rm[1] === '') { rStart = Math.max(0, st.size - (+rm[2])); }
      else { rStart = +rm[1]; if (rm[2] !== '') rEnd = Math.min(+rm[2], st.size - 1); }
      if (!(rStart <= rEnd) || rStart >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size, 'Content-Type': 'text/plain' });
        return res.end();
      }
      status = 206;
      hdrs['Content-Range'] = 'bytes ' + rStart + '-' + rEnd + '/' + st.size;
    }
    hdrs['Content-Length'] = st.size === 0 ? 0 : rEnd - rStart + 1;
    res.writeHead(status, hdrs);
    if (isHead || st.size === 0) return res.end();
    const stream = fs.createReadStream(full, { start: rStart, end: rEnd });
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
});

// Cross-site WebSocket hijacking guard: allowed = no Origin (non-browser), same host as the request, localhost, or an ALLOWED_ORIGINS entry.
const normOrigin = s => String(s || '').trim().toLowerCase().replace(/\/+$/, '');
const originHost = o => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } };
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').concat(process.env.RENDER_EXTERNAL_URL || '').map(normOrigin).filter(Boolean);
const ORIGIN_ANY = ALLOWED_ORIGINS.includes('*');   // ALLOWED_ORIGINS=* turns the check off
const ALLOW_LOCALHOST = process.env.ALLOW_LOCALHOST !== '0';
const isLocalOrigin = o => { try { const u = new URL(o); return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch (e) { return false; } };
function originAllowed(origin, host) {
  if (origin == null || origin === '') return true;
  const o = normOrigin(origin);
  if (o === 'null') return false;
  const oh = originHost(o);
  if (!oh) return false;
  if (ORIGIN_ANY) return true;
  if (host && oh === String(host).toLowerCase()) return true;
  if (ALLOW_LOCALHOST && isLocalOrigin(o)) return true;
  return ALLOWED_ORIGINS.some(a => a === o || a === oh || originHost(a) === oh && /^https?:\/\//.test(a) && a.split('://')[0] === o.split('://')[0]);
}
function verifyOrigin(info, cb) {
  const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
  if (originAllowed(origin, info.req && info.req.headers && info.req.headers.host)) return cb(true);
  console.warn('ws: rejected origin', String(origin).slice(0, 100));
  cb(false, 403, 'Forbidden origin: ' + String(origin).slice(0, 100) + ' is not allowed to connect to this server. The server owner can add it to the ALLOWED_ORIGINS environment variable (comma separated), or open the game from the server\'s own address.');
}
const MAX_WS_PAYLOAD = Math.min(1024 * 1024, Math.max(HOST_RELAY_MAX + 4096, parseInt(process.env.MAX_WS_PAYLOAD, 10) || 256 * 1024));   // frames above this close the socket (ws code 1009)
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyOrigin, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: process.env.DEFLATE === '0' ? false : { threshold: 600, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 } });

const rooms = new Map();   // code -> room
let nextPid = 1;

const clean = (s, n) => Array.from(String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_ \-.!?]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, n).join('').trim();
const send = (ws, o) => { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } } catch (e) { try { ws.terminate(); } catch (e2) {} } return false; };
const BUF_LIMIT = 200000;
// Relay send: never throws, skips closed sockets, optionally skips congested ones.
function safeSend(ws, str, skipSlow) {
  try {
    if (!ws || ws.readyState !== 1) return false;
    if (skipSlow && ws.bufferedAmount > BUF_LIMIT) return false;
    ws.send(str); return true;
  } catch (e) { return false; }
}
function newCode() {
  // No I, O or Q: they get confused with 1 and 0 when read aloud or typed.
  const A = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const rnd = require('crypto').randomInt;
  for (let k = 0; k < 200; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += A[rnd(A.length)];
    if (!rooms.has(c)) return c;   // retry on collision with any live room
  }
  return null;
}
function uniqueName(room, name) {
  let base = clean(name, 16) || 'Player', n = base, i = 2;
  const used = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  while (used.has(n.toLowerCase())) { n = Array.from(base).slice(0, 16 - String(i).length).join('') + i; i++; }
  return n;
}
const list = room => [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon }));
// Checks for opening a new room. Done BEFORE leaving the current room, so a refusal never strands the player.
// A room the player is alone in will be deleted when they leave, so it doesn't count against the caps.
function roomOpenError(ws) {
  const cur = ws.room && ws.p && ws.room.players.has(ws.p.pid) ? ws.room : null;
  const freed = cur && cur.players.size <= 1 && rooms.get(cur.code) === cur ? cur : null;
  if (rooms.size - (freed ? 1 : 0) >= MAX_ROOMS) return 'Server is busy, try again in a minute.';
  const mine = roomsOfIp(ws.ip) - (freed && freed.ip === ws.ip ? 1 : 0);
  if (mine >= MAX_ROOMS_PER_IP) return 'You already have ' + MAX_ROOMS_PER_IP + ' open rooms. Close one or join an existing room.';
  if (rooms.size - (freed ? 1 : 0) >= 36 ** 4) return 'No room codes free.';
  return null;
}
function bcastPlayers(room) {
  const msg = { t: 'players', host: room.host, players: list(room), started: room.started };
  for (const p of room.players.values()) send(p.ws, msg);
}
function joinRoom(ws, room, name, weapon) {
  // Re-joining the room we're already in: don't release it (that could delete it or move the host); just resync.
  if (ws.room === room && ws.p && room.players.get(ws.p.pid) === ws.p) {
    return send(ws, { t: 'players', host: room.host, players: list(room), started: room.started });
  }
  // A failed join leaves the player where they were; resend that room's state so the client stays consistent.
  const fail = (msg) => {
    send(ws, { t: 'err', msg });
    const cur = ws.room;
    if (cur && ws.p && cur.players.has(ws.p.pid)) send(ws, { t: 'players', host: cur.host, players: list(cur), started: cur.started });
  };
  if (rooms.get(room.code) !== room) return fail('That room no longer exists.');
  if (room.players.size >= MAX_PLAYERS) return fail('Room is full (16 players).');
  if (room.started) return fail('That match already started.');
  // All checks passed: only now release the old room (the target is a different room, so it is unaffected).
  leaveRoom(ws);
  const p = { ws, pid: nextPid++, name: uniqueName(room, name), weapon: WEAPONS.includes(weapon) ? weapon : 'rifle' };
  ws.p = p; ws.room = room;
  room.players.set(p.pid, p);
  if (!room.host) room.host = p.pid;
  send(ws, { t: 'joined', code: room.code, pid: p.pid, host: room.host, players: list(room), started: room.started });
  bcastPlayers(room);
}
function leaveRoom(ws) {
  const room = ws.room, p = ws.p;
  if (!room || !p) return;
  room.players.delete(p.pid);
  ws.room = null; ws.p = null;
  if (p.pid === room.host) {
    for (const [pid, q] of [...room.players]) {
      if (!q.ws || q.ws.readyState !== 1) {
        room.players.delete(pid);
        if (q.ws && q.ws.room === room) { q.ws.room = null; q.ws.p = null; }
      }
    }
    if (!room.players.size) { rooms.delete(room.code); return; }
    // Hand the host role to the longest-present remaining player. A running match can't be resumed
    // (the simulation lives only in the old host's browser), so the room returns to the lobby.
    const next = [...room.players.values()].filter(q => q.ws && q.ws.readyState === 1).sort((a, b) => a.pid - b.pid)[0];
    if (!next) {
      // everyone left is on a closing socket: no valid host, close the room
      for (const q of room.players.values()) { if (q.ws) { q.ws.room = null; q.ws.p = null; } }
      room.players.clear();
      if (rooms.get(room.code) === room) rooms.delete(room.code);
      return;
    }
    const aborted = room.started;
    room.host = next.pid; room.started = false;
    for (const q of room.players.values()) send(q.ws, { t: 'hostleft', host: next.pid, name: next.name, aborted });
    bcastPlayers(room);
    return;
  }
  const h = room.players.get(room.host);
  if (h) send(h.ws, { t: 'left', pid: p.pid });
  const live = [...room.players.values()].some(q => q.ws && q.ws.readyState === 1);
  if (!room.players.size || !live) {
    for (const q of room.players.values()) { if (q.ws) { q.ws.room = null; q.ws.p = null; } }
    room.players.clear();
    if (rooms.get(room.code) === room) rooms.delete(room.code);
  } else bcastPlayers(room);
}

const MAX_CONN_PER_IP = Math.max(1, parseInt(process.env.MAX_CONN_PER_IP, 10) || 8);
const ipConns = new Map();
const XFF_FROM_RIGHT = Math.max(0, parseInt(process.env.XFF_FROM_RIGHT, 10) || 0);   // 0 = first entry; 1 = last entry (set if the proxy appends the real IP)
const clientIp = (req) => {
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pick = parts.length ? (XFF_FROM_RIGHT ? parts[Math.max(0, parts.length - XFF_FROM_RIGHT)] : parts[0]) : '';
  return String(pick || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
};

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const isLoopback = !(req.headers && req.headers['x-forwarded-for']) && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip);
  if (!isLoopback && (ipConns.get(ip) || 0) >= MAX_CONN_PER_IP) {
    ws.on('error', () => {});
    send(ws, { t: 'err', msg: 'Too many connections from your network. Close other Horde Brawl tabs and try again.' });
    try { ws.close(1008, 'Too many connections'); } catch (e) {}
    return;
  }
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
  let ipFreed = false;
  const freeIp = () => {
    if (ipFreed) return; ipFreed = true;
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
  };
  ws.on('error', freeIp);
  ws.isAlive = true; ws.msgs = 0; ws.room = null; ws.p = null; ws.lim = {};
  ws.ip = ip;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.rel = 0; ws.relHot = false; ws.relSecs = 0;
  ws.strikes = 0; ws.struck = false; ws.clean = 0;
  ws.bad = 0; ws.badClean = 0;
  ws.on('error', (e) => { if (e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') console.log('oversized frame from ' + ws.ip); });
  const rate = setInterval(() => {
    if (!ws.struck) { if (ws.strikes > 0 && ++ws.clean >= 10) { ws.strikes = 0; ws.clean = 0; } }
    else ws.clean = 0;
    if (ws.relHot) { if (++ws.relSecs >= 10) { try { ws.terminate(); } catch (e) {} return; } } else ws.relSecs = 0;   // sustained relay flood: drop the socket
    ws.relHot = false;
    ws.struck = false; ws.msgs = 0; ws.rel = 0;
    if (ws.bad > 0 && ++ws.badClean >= 30) { ws.bad = 0; ws.badClean = 0; }
  }, 1000);
  const badFrame = (why) => {
    ws.bad++; ws.badClean = 0;
    if (ws.bad >= 5) {
      console.log('closing bad-frame client ' + ws.ip + ' (' + why + ')');
      send(ws, { t: 'err', msg: 'Disconnected: invalid data sent to the server.' });
      try { ws.close(1003, 'Invalid data'); } catch (e) {}
    } else send(ws, { t: 'err', msg: 'Invalid message ignored.' });
  };
  ws.on('message', (raw, isBinary) => { try { onMessage(raw); } catch (e) { console.error('[message handler]', e && e.stack || e); } });
  const onMessage = (raw) => {
    if (++ws.msgs > 700) {                            // flood guard: counted strikes, then terminate
      if (ws.msgs > 5000) {                           // extreme burst: no more strikes, cut it off now
        console.log('flood burst terminate from ' + ws.ip);
        try { ws.terminate(); } catch (e) {}
        return;
      }
      if (!ws.struck) {
        ws.struck = true; ws.strikes++;
        console.log('flood strike ' + ws.strikes + '/3 from ' + ws.ip);
        if (ws.strikes >= 3) {
          try { send(ws, { t: 'err', msg: 'Disconnected: flooding the server.' }); } catch (e) {}
          try { ws.terminate(); } catch (e) {}
        } else {
          try { send(ws, { t: 'err', msg: 'Slow down - sending too fast.' }); } catch (e) {}
        }
      }
      return;
    }
    if (isBinary === true) return badFrame('binary');
    let m; try { m = JSON.parse(raw); } catch (e) { return badFrame('not json'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return badFrame('bad shape');
    const room = ws.room, p = ws.p;
    if (room && m.t !== 'ping') room.active = Date.now();   // last-activity time for the sweep
    if (!allow(ws, m.t)) {
      if (m.t === 'create') send(ws, { t: 'err', msg: 'Slow down - too many rooms created.' });
      else if (m.t === 'join' || m.t === 'quick') send(ws, { t: 'err', msg: 'Slow down - too many join attempts.' });
      else if (m.t === 'start') send(ws, { t: 'err', msg: 'Slow down - wait a moment before starting.' });
      return;
    }
    switch (m.t) {
      case 'ping': return send(ws, { t: 'pong', ts: (typeof m.ts === 'number' && isFinite(m.ts)) ? m.ts : 0 });
      case 'create': {
        const cerr = roomOpenError(ws);                 // refuse BEFORE leaving the current room
        if (cerr) return send(ws, { t: 'err', msg: cerr });
        const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'No room codes free.' });
        const r = { code, players: new Map(), host: 0, started: false, created: Date.now(), ip: ws.ip, private: true };
        rooms.set(code, r); joinRoom(ws, r, m.name, m.weapon);
        if (!r.players.size) rooms.delete(code);        // never leave an empty room holding a slot
        return;
      }
      case 'join': {
        const r = rooms.get(clean(m.code, 4).toUpperCase());
        if (!r) return send(ws, { t: 'err', msg: 'No room with that code.' });
        return joinRoom(ws, r, m.name, m.weapon);
      }
      case 'quick': {
        let best = null;
        for (const r of rooms.values()) {
          if (r.private || r.started || r.players.size >= MAX_PLAYERS) continue;   // private rooms are code-only
          const h = r.players.get(r.host);                 // host must exist with a live socket
          if (!h || !h.ws || h.ws.readyState !== 1) continue;
          if (!best || r.players.size > best.players.size) best = r;
        }
        if (!best) {
          const qerr = roomOpenError(ws);                // refuse BEFORE leaving the current room
          if (qerr) return send(ws, { t: 'err', msg: qerr });
          const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'No room codes free.' });
          best = { code, players: new Map(), host: 0, started: false, created: Date.now(), ip: ws.ip, private: false }; rooms.set(code, best);
        }
        joinRoom(ws, best, m.name, m.weapon);
        if (!best.players.size) rooms.delete(best.code);
        return;
      }
      case 'upd': {
        if (!room || !p) return noRoom(ws);
        if (room.started) return bcastPlayers(room);   // names/heroes are locked mid-match so fighters can't desync
        const nm = typeof m.name === 'string' ? clean(m.name, 16) : '';
        if (nm) p.name = uniqueName({ players: new Map([...room.players].filter(([k]) => k !== p.pid)) }, nm);   // empty/invalid names are ignored
        if (typeof m.weapon === 'string' && WEAPONS.includes(m.weapon)) p.weapon = m.weapon;
        return bcastPlayers(room);
      }
      case 'start': if (!room || !p) return noRoom(ws);
        if (p.pid === room.host && !room.started && room.players.size < 2) {
          send(ws, { t: 'err', msg: 'Need another player to start a match.' });
          send(ws, { t: 'players', host: room.host, players: list(room), started: room.started });
        }
        else if (p.pid === room.host && !room.started) { room.started = true; bcastPlayers(room); }
        else {
          if (p.pid !== room.host) send(ws, { t: 'err', msg: 'Only the host can start the match.' });
          send(ws, { t: 'players', host: room.host, players: list(room), started: room.started });   // duplicate or non-host start: resync sender only
        }
        return;
      case 'lobby': if (!room || !p) return noRoom(ws);
        if (p.pid === room.host) { room.started = false; bcastPlayers(room); }   // host lobby always clears a stale started flag and tells everyone
        else send(ws, { t: 'players', host: room.host, players: list(room), started: room.started });   // no-op lobby: resync sender only
        return;
      case 'leave': return leaveRoom(ws);
      case 'r': {                                      // relay: client -> host, host -> peer or everyone
        if (!room || !p) return noRoom(ws);
        if (raw.length > (p.pid === room.host ? HOST_RELAY_MAX : CLIENT_RELAY_MAX)) return;   // oversize relay payload
        if (p.pid !== room.host && ++ws.rel > CLIENT_RELAY_RATE) { ws.relHot = true; return; }   // relay flood: drop extras, remember the offence
        if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;                   // 'd' must be an object
        if (p.pid === room.host && m.to !== '*' && (m.to === p.pid || !room.players.has(m.to))) return;   // host target must exist
        if (p.pid === room.host) {
          if (m.to === '*') { const out = JSON.stringify({ t: 'r', from: p.pid, d: m.d }); const snap = m.d.k === 's'; for (const q of room.players.values()) if (q !== p) safeSend(q.ws, out, snap); }   // only stale snapshots are dropped for slow links
          else { const q = room.players.get(m.to); if (q) {
            safeSend(q.ws, JSON.stringify({ t: 'r', from: p.pid, d: m.d }), m.d.k === 's'); } }   // drop stale snapshots for slow links
        } else {
          if (!room.started) return;                   // no client->host relay while still in the lobby
          const h = room.players.get(room.host); if (h) safeSend(h.ws, JSON.stringify({ t: 'r', from: p.pid, d: m.d }), false);
        }
        return;
      }
    }
  };
  ws.on('close', () => { clearInterval(rate); freeIp(); try { leaveRoom(ws); } catch (e) { console.error('[leaveRoom on close]', e && e.stack || e); } });
  ws.on('error', () => {});
});

function noRoom(ws) {                                  // tell a roomless socket why its message was ignored (max 1/s)
  const now = Date.now();
  if (ws.lastNoRoom && now - ws.lastNoRoom < 1000) return;
  ws.lastNoRoom = now;
  send(ws, { t: 'err', msg: 'Join a room first.' });
}

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();                              // sweep empty / abandoned lobbies
  for (const [c, r] of rooms) {
    if (!r.players.size) { rooms.delete(c); continue; }
    if (now - (r.active || r.created) > 6 * 3600e3) {   // idle for 6 hours: notify, then close
      const hp = r.players.get(r.host);
      if (r.started && hp && hp.ws && hp.ws.readyState === 1) continue;   // running match with a live host: keep it
      rooms.delete(c);
      for (const q of r.players.values()) {
        const w = q && q.ws;
        if (!w) continue;
        w.room = null; w.p = null;
        if (w.readyState === 1) {
          send(w, { t: 'closed', reason: 'Room closed after 6 hours of inactivity.' });
          try { w.close(1000, 'room closed'); } catch (e) {}
        }
      }
    }
  }
}, 10000);

// ---- process safety + graceful shutdown ----
let shuttingDown = false;
function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down: ' + reason);
  try { wss.close(); } catch (e) {}
  for (const ws of wss.clients) {
    try { send(ws, { t: 'closed', reason: 'Server is restarting - please create or join a room again in a moment.' }); } catch (e) {}
    try { ws.close(1001, 'server restarting'); } catch (e) {}
  }
  rooms.clear();
  let exited = false;
  const done = () => { if (exited) return; exited = true; setTimeout(() => process.exit(code || 0), 300); };   // short delay so close frames flush
  try { server.close(done); } catch (e) { done(); }
  try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch (e) {}
  setTimeout(() => { for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} } done(); }, 4000).unref();
}
let errTimes = [];
function noteError(kind, err) {
  console.error('[' + kind + ']', err && err.stack || err);
  const now = Date.now();
  errTimes = errTimes.filter(t => now - t < 60000); errTimes.push(now);
  if (errTimes.length > 10) shutdown('too many unhandled errors', 1);   // let Render restart a clean process
}
process.on('uncaughtException', err => noteError('uncaughtException', err));
process.on('unhandledRejection', err => noteError('unhandledRejection', err));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

server.listen(PORT, () => console.log('Horde Duel server listening on :' + PORT));
