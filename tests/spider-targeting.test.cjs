const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const physics = loadModule(read('js/spider-physics.js'));
const T = loadModule(read('js/spider-targeting.js'), { imports: { './spider-physics.js': physics } });

// camera 5 m behind the origin looking along +z (bearing 0), tilted up 0.55 rad (about 32 degrees) towards the roof lines
const view = (yaw = 0, pitchUp = 0.55, px = 0, py = 1.8, pz = -5) => ({ vHalf: 0.52, hHalf: 0.8, px, py, pz, fx: Math.sin(yaw) * Math.cos(pitchUp), fy: Math.sin(pitchUp), fz: Math.cos(yaw) * Math.cos(pitchUp) });

test('an anchor on the crosshair scores better than one off to the side, and anything outside the aiming cone is rejected', () => {
  const v = view();
  const centre = T.scoreAnchor(v, 0, 40, 40), side = T.scoreAnchor(v, 25, 40, 40);
  assert.ok(centre < side, `${centre} < ${side}`);
  assert.equal(T.scoreAnchor(v, 80, 40, 40), Infinity, 'far to the side');
  assert.equal(T.scoreAnchor(v, 0, 40, -60), Infinity, 'behind the camera');
  assert.equal(T.scoreAnchor(v, 0, 300, 20), Infinity, 'straight up is not aimable');
});

test('looking exactly at the roof edge beats looking a bit below it; looking along the street offers nothing above the screen', () => {
  const edge = Math.atan2(40 - 1.8, 45); // elevation of an anchor 45 m away at 40 m height
  const exact = view(0, edge), below = view(0, edge - 0.25);
  assert.ok(T.scoreAnchor(exact, 0, 40, 40) < T.scoreAnchor(below, 0, 40, 40));
  assert.ok(Number.isFinite(T.scoreAnchor(below, 0, 40, 40)), 'a quarter radian low is still on screen and aimable');
  assert.equal(T.scoreAnchor(view(0, 0), 0, 40, 40), Infinity, 'level view: the roof line is above the top of the screen, so no marker');
  // bearing dominates: a small sideways error costs more than the same vertical error
  assert.ok(T.scoreAnchor(exact, 8, 40, 40) > T.scoreAnchor(below, 0, 40, 40) * 0.5);
});

test('insertRanked keeps the list sorted and bounded', () => {
  const list = [];
  for (const s of [5, 1, 4, 2, 3, 0.5]) T.insertRanked(list, { score: s }, 4);
  assert.deepEqual(list.map((i) => i.score), [0.5, 1, 2, 3]);
});

test('target hysteresis: a slightly better candidate does not steal the target, a clearly better one does', () => {
  const cur = { x: 10, y: 40, z: 50, score: 0.30 }, near = { x: 20, y: 40, z: 50, score: 0.27 }, clear = { x: 30, y: 40, z: 50, score: 0.08 };
  assert.equal(T.chooseTarget([near, cur], cur, 0.30, 0, 0.03).target, cur);
  assert.equal(T.chooseTarget([clear, cur], cur, 0.30, 0, 0.03).target, clear);
  assert.equal(T.chooseTarget([], null, Infinity, 0, 0.03).target, null);
});

test('the target survives a brief loss of line of sight, then gives way', () => {
  const cur = { x: 10, y: 40, z: 50, score: 0.3 }, other = { x: 30, y: 40, z: 50, score: 0.4 };
  let r = T.chooseTarget([other], cur, Infinity, 0, 0.033);
  assert.equal(r.target, cur); assert.ok(r.stale, 'kept but flagged stale (not attachable)');
  let missing = r.missing, switched = -1;
  for (let i = 0; i < 12 && switched < 0; i++) { r = T.chooseTarget([other], cur, Infinity, missing, 0.033); missing = r.missing; if (r.target === other) switched = i; }
  assert.ok(switched > 3 && switched < 12, `gave way after ${switched} ticks (about the 0.25 s grace)`);
});

// ---- WebTargeting with a stub world
function stubWorld(anchors, blocked = () => false) {
  return {
    floorAt: () => 0,
    forEachAnchor: (px, py, pz, opts, cb) => {
      for (const a of anchors) {
        const h = Math.hypot(a.x - px, a.z - pz), dy = a.y - py;
        if (h < opts.minHoriz || h > opts.maxHoriz || dy < opts.minUp || dy > opts.maxUp || a.y < opts.minY) continue;
        cb(a.x, a.y, a.z, 0, -1, h, dy);
      }
    },
    lineClear: (ax, ay, az, bx, by, bz) => !blocked(bx, by, bz)
  };
}
const make = (anchors, blocked) => new T.WebTargeting({ world: stubWorld(anchors, blocked), document: null });
const tick = (t, v, body = { x: 0, y: 0, z: 0 }, n = 3) => { for (let i = 0; i < n; i++) t.update(1 / 20, v, body, true); };
const A1 = { x: -20, y: 45, z: 45 }, A2 = { x: 25, y: 45, z: 50 };

test('looking at a building selects its anchor; turning to another building moves the target there', () => {
  const t = make([A1, A2]);
  tick(t, view(Math.atan2(-20 - 0, 45 + 5)));
  assert.equal(t.current().x, A1.x);
  tick(t, view(Math.atan2(25, 55)), undefined, 8);
  assert.equal(t.current().x, A2.x, 'followed the view to the second building');
});

test('the marker does not flicker between two near-equal buildings while the aim jitters', () => {
  const t = make([{ x: -6, y: 45, z: 50 }, { x: 6, y: 45, z: 50 }]);
  const seen = new Set();
  for (let i = 0; i < 80; i++) { t.update(1 / 20, view(0.004 * Math.sin(i * 1.7)), { x: 0, y: 0, z: 0 }, true); if (t.current()) seen.add(t.current().x); }
  assert.equal(seen.size, 1, 'one stable target');
});

test('buildings in the way are never targeted, and with nothing valid the state is clearly "no target"', () => {
  const t = make([A1], () => true);
  tick(t, view(Math.atan2(-20, 50)));
  assert.equal(t.current(), null);
  assert.equal(t.valid, false);
});

test('anchors behind the player, too low for a clear swing, or needing a violent reel-in are not offered', () => {
  const body = { x: 0, y: 0, z: 0 };
  const behind = make([{ x: 0, y: 45, z: -40 }]);
  tick(behind, view(0, 0, 0, 1.8, -5), body); assert.equal(behind.current(), null, 'behind');
  const low = make([{ x: 0, y: 12, z: 40 }]);
  tick(low, view(), body); assert.equal(low.current(), null, 'below ground + clearance + minimum rope');
  const zip = make([{ x: 0, y: 30, z: 70 }]); // 70 m away but only 22 m of usable height: would reel ~70% in
  tick(zip, view(), body); assert.equal(zip.current(), null, 'a zip, not a swing');
  const ok = make([{ x: 0, y: 45, z: 42 }]);
  tick(ok, view(), body); assert.ok(ok.current(), 'a normal swing anchor is offered');
});

test('disabled targeting clears the selection and never offers a target', () => {
  const t = make([A1]);
  tick(t, view(Math.atan2(-20, 50)));
  assert.ok(t.current());
  t.update(0.05, view(), { x: 0, y: 0, z: 0 }, false);
  assert.equal(t.selected, null); assert.equal(t.current(), null);
});

test('screen projection puts a point straight ahead at the centre and rejects points behind the camera', () => {
  const cam = { matrixWorldInverse: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, projectionMatrix: { elements: [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } };
  const p = { x: 0, y: 0, z: -10 };
  assert.ok(T.project(cam, p, 1000, 600));
  assert.equal(Math.round(p.x), 500); assert.equal(Math.round(p.y), 300);
  assert.equal(T.project(cam, { x: 0, y: 0, z: 10 }, 1000, 600), false);
});

test('a point above the top of the screen is never offered (the marker must be visible)', () => {
  const v = view(0, 0.3); // tilted up 0.3 rad, vertical half-FOV 0.52 rad
  assert.ok(Number.isFinite(T.scoreAnchor(v, 0, 25, 40)), 'about 30 degrees up is on screen');
  assert.equal(T.scoreAnchor(v, 0, 60, 40), Infinity, 'about 55 degrees up is off the top of the screen');
});
