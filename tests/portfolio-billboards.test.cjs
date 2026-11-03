const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const { mountOnWall, findWall, profileBoards } = loadModule(read('js/portfolio-billboards.js'), { imports: {} });

// a flat wall at x = 20 (normal pointing to -x), 60 m tall, wide enough along z
const wallWorld = (x = 20, { tall = 60 } = {}) => ({
  rayFirstHit(ox, oy, oz, dx, dy, dz, maxT) {
    if (dx <= 0 || oy > tall || Math.abs(oz) > 50) return null;
    const t = (x - ox) / dx; return t > 0 && t <= maxT ? { t, nx: -1, ny: 0, nz: 0 } : null;
  }
});

test('a board is mounted flat on a wall that is one face and continues above it', () => {
  const m = mountOnWall(wallWorld(), 0, 0, [1, 0], 16, 8, 15);
  assert.ok(m); assert.ok(Math.abs(m.px - 19.9) < 1e-6 && m.nx === -1 && m.nz === 0 && m.y === 15);
  assert.equal(mountOnWall(wallWorld(20, { tall: 18 }), 0, 0, [1, 0], 16, 8, 15), null, 'a wall that ends under the board takes none');
  const bumpy = { rayFirstHit: (ox, oy, oz) => ({ t: 20 + (oz > 5 ? 3 : 0), nx: -1, ny: 0, nz: 0 }) };
  assert.equal(mountOnWall(bumpy, 0, 0, [1, 0], 16, 8, 15), null, 'a wall that is not one flat face takes none');
});

test('findWall tries the preferred direction first and then smaller boards', () => {
  const m = findWall(wallWorld(), 0, 0, [16, 8], [1, 0]);
  assert.ok(m && m.dir[0] === 1 && m.w === 16);
  assert.equal(findWall({ rayFirstHit: () => null }, 0, 0, [16, 8]), null);
});

test('without a profile name nothing is built and nothing is invented', async () => {
  const r = await profileBoards({ THREE: { Group: class {} }, scene: {}, world: wallWorld(), profile: { name: null }, sites: {} });
  assert.equal(r.pins.length, 0);
});

test('the real profile data and photo exist, and only real fields feed the boards', () => {
  const profile = JSON.parse(read('content/profile.json'));
  assert.ok(profile.name && typeof profile.name === 'string');
  const photo = join(root, 'content', profile.photo);
  assert.ok(existsSync(photo) && statSync(photo).size > 10000, 'the profile photo is in content/profile/');
  const jpeg = readFileSync(photo); assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
  const src = read('js/portfolio-billboards.js');
  assert.match(src, /drawCover/, 'the photo is cropped to fit, never stretched');
  assert.match(src, /if \(p\.role\)/); assert.match(src, /if \(p\.website\)/); // an empty field is not drawn
});

test('the map pins are the existing landmark system extended: legend, pin hit test and click-to-arrive', () => {
  const map = read('js/nyc-map.js'), main = read('js/main.js');
  assert.match(map, /setPortfolioPins\(pins\)/); assert.match(map, /portfolioPinAt\(mx, my, width, height\)/);
  assert.match(map, /this\.onTeleport\(wPos\.x, wPos\.z, pin\.heading\)/);
  assert.match(read('index.html'), /portfolio-swatch/);
  assert.match(main, /mapSystem\.setPortfolioPins\(portfolioPins\)/);
});

test('camera ownership: Spider-Man turns the generic drag-to-orbit off while he owns the mouse and hands it back clean', () => {
  const cams = read('js/cameras.js'), sc = read('js/spider-camera.js'), inp = read('js/spider-input.js');
  assert.match(cams, /this\.dragEnabled = true/); assert.match(cams, /!this\.dragEnabled \|\| document\.pointerLockElement === canvas/);
  assert.match(cams, /document\.addEventListener\('pointerlockchange', clearPointers\)/);
  assert.match(sc, /_enter\(\) \{[\s\S]*dragEnabled = false/); assert.match(sc, /_exit\(\) \{[\s\S]*dragEnabled = true[\s\S]*_clearPointers/);
  assert.match(inp, /rearm\(\)/);
});
