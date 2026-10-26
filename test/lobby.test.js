'use strict';
// Lobby browser: room list, room names, optional passwords.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect } = require('./helpers');

async function setup(t) { const srv = await startServer({ MODE: 'relay' }); t.after(() => srv.stop()); return srv; }
async function list(c) { c.send({ t: 'list' }); return (await c.waitFor('rooms')).rooms; }

test('list shows rooms with name, mode, map, players and lock; default name is the host\'s', async t => {
  const srv = await setup(t);
  const a = await connect(srv); a.send({ t: 'create', name: 'Uno', room: 'Night Raid' }); const ja = await a.waitFor('joined');
  assert.deepEqual(ja.room, { name: 'Night Raid', locked: false });
  const b = await connect(srv); b.send({ t: 'create', name: 'Kai', pass: 'pw1' }); const jb = await b.waitFor('joined');
  assert.deepEqual(jb.room, { name: "Kai's room", locked: true });
  const v = await connect(srv); const L = await list(v);
  assert.equal(L.length, 2);
  const ra = L.find(r => r.code === ja.code), rb = L.find(r => r.code === jb.code);
  assert.equal(ra.name, 'Night Raid'); assert.equal(ra.locked, false); assert.equal(ra.mode, 'br'); assert.equal(ra.map, 'random');
  assert.equal(ra.n, 1); assert.equal(ra.cap, 16); assert.equal(ra.started, false);
  assert.equal(rb.locked, true);
  assert.ok(!JSON.stringify(L).includes('pw1'), 'the password never leaves the server');
});

test('a locked room needs the right password; wrong guesses are limited', async t => {
  const srv = await setup(t);
  const h = await connect(srv); h.send({ t: 'create', name: 'Host', pass: 'open sesame' }); const j = await h.waitFor('joined');
  const g = await connect(srv);
  g.send({ t: 'join', code: j.code, name: 'G' }); let e = await g.waitFor('err');
  assert.equal(e.code, 'pass'); assert.equal(e.room, j.code); assert.match(e.msg, /needs a password/);
  g.send({ t: 'join', code: j.code, name: 'G', pass: 'nope' }); e = await g.waitFor('err');
  assert.equal(e.code, 'pass'); assert.match(e.msg, /Wrong password/);
  g.send({ t: 'join', code: j.code, name: 'G', pass: 'open sesame' }); const gj = await g.waitFor('joined');
  assert.equal(gj.code, j.code);
  const x = await connect(srv);
  for (let i = 0; i < 8; i++) { x.send({ t: 'join', code: j.code, name: 'X', pass: 'guess' + i }); await x.waitFor('err'); }
  x.send({ t: 'join', code: j.code, name: 'X', pass: 'open sesame' }); e = await x.waitFor('err');
  assert.match(e.msg, /Too many wrong passwords/);
});

test('quick play never lands in a locked room', async t => {
  const srv = await setup(t);
  const h = await connect(srv); h.send({ t: 'create', name: 'Host', pass: 'x' }); const j = await h.waitFor('joined');
  const q = await connect(srv); q.send({ t: 'quick', name: 'Q' }); const qj = await q.waitFor('joined');
  assert.notEqual(qj.code, j.code);
});

test('the host can rename the room and add or remove the password', async t => {
  const srv = await setup(t);
  const h = await connect(srv); h.send({ t: 'create', name: 'Host' }); const j = await h.waitFor('joined');
  h.send({ t: 'roomset', room: 'Late Night', pass: 'abc' });
  await h.waitFor('players', 3000, m => m.room && m.room.name === 'Late Night' && m.room.locked);
  const g = await connect(srv); g.send({ t: 'join', code: j.code, name: 'G' }); assert.equal((await g.waitFor('err')).code, 'pass');
  h.send({ t: 'roomset', pass: '' }); await h.waitFor('players', 3000, m => m.room && !m.room.locked);
  g.send({ t: 'join', code: j.code, name: 'G' }); await g.waitFor('joined');
  const n = await connect(srv); n.send({ t: 'join', code: j.code, name: 'N' }); await n.waitFor('joined');
  n.send({ t: 'roomset', room: 'Hijack' }); const L = await list(n);
  assert.equal(L.find(r => r.code === j.code).name, 'Late Night', 'only the host can change room settings');
});
