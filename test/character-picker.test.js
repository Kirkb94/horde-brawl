const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['public/index.html', 'src/net.js', 'dev/net.js']) {
  test(`${file}: lobby refresh preserves each player's character picker`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = source.indexOf('function netLobby(){');
    const fn = source.slice(start, source.indexOf('\nfunction ', start + 1));
    function client(pid) {
      let picker = null;
      const panel = { scrollTop: 0, querySelector: () => picker };
      const ctx = {
        panel, G: { mode: 'menu', pick: 'pistol' },
        NET: { view: 'online', role: 'client', pid, hostPid: 1, code: 'TEST', cfg: { mode: 'br', size: 4 }, players: [{pid: 1, name: 'A', weapon: 'pistol'}, {pid: 2, name: 'B', weapon: 'pistol'}] },
        showHUD() {}, netCap: () => 4, MODES: {br: 'Brawl'}, CHARS: {pistol: {name: 'Pistol'}, rifle: {name: 'Rifle'}},
        modLine: () => '', esc: x => x, wepGrid: () => '<button>Hero</button>',
        show(html) {
          ctx.html = html;
          panel.scrollTop = 0;
          picker = { open: false, selected: ctx.G.pick, replaceWith(old) { picker = old; } };
        }
      };
      vm.createContext(ctx); vm.runInContext(fn, ctx);
      ctx.netLobby();
      return {ctx, panel, get picker() { return picker; }};
    }
    const a = client(1), b = client(2);
    a.picker.open = b.picker.open = true;
    a.panel.scrollTop = 170; b.panel.scrollTop = 320;
    const originalA = a.picker, originalB = b.picker;
    // Local selection updates its picker, then the server echoes the roster to both clients.
    a.ctx.G.pick = 'rifle'; a.picker.selected = 'rifle';
    for (const c of [a,b]) { c.ctx.NET.players[0].weapon = 'rifle'; c.ctx.netLobby(); }
    assert.equal(a.picker, originalA); assert.equal(b.picker, originalB);
    assert.equal(a.picker.open, true); assert.equal(b.picker.open, true);
    assert.equal(a.picker.selected, 'rifle'); assert.equal(b.picker.selected, 'pistol');
    assert.equal(a.panel.scrollTop, 170); assert.equal(b.panel.scrollTop, 320);
    assert.match(b.ctx.html, /Rifle/); // The shared roster still refreshes.
    b.picker.open = false; b.ctx.netLobby(); assert.equal(b.picker.open, false);
    b.ctx.NET.view = 'online'; b.ctx.netLobby(); assert.notEqual(b.picker, originalB);
  });
}
