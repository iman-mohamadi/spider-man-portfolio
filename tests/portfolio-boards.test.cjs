const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// ------------------------------------------------------------------ fakes
const calls = { drawImage: 0, canvases: 0, images: [] };
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s) => ({ width: String(s).length * 20 }) : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'drawImage' ? () => { calls.drawImage++; } : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const document = { createElement: () => { calls.canvases++; return { width: 0, height: 0, getContext: () => ctx }; } };
class FakeImage { set src(u) { calls.images.push(u); setTimeout(() => (/missing/.test(u) ? this.onerror() : this.onload()), 0); this.width = 800; this.height = 600; } }
class Obj { updateMatrixWorld() {} constructor() { this.children = []; this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; this.rotation = { y: 0 }; this.userData = {}; } add(...c) { this.children.push(...c); } }
const THREE = { Group: Obj, Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }, PlaneGeometry: class {}, BoxGeometry: class {}, MeshBasicMaterial: class {}, CanvasTexture: class { constructor(c) { this.image = c; } }, SRGBColorSpace: 'srgb' };
const B = loadModule(read('js/portfolio-billboards.js'), { imports: {}, globals: { document, Image: FakeImage, setTimeout } });
const S = loadModule(read('js/portfolio-sites.js'), { imports: {}, globals: {} });
const rules = { decorMax: 3, minSpacing: 70, hqSpacing: 40, gap: 2 };

// a street with flat walls at x = 20 (front facing -x), 40 m wide every 100 m; `n` walls from z = 0
const city = (n) => ({
  rayFirstHit(ox, oy, oz, dx, dy, dz, maxT) {
    if (dx !== 1 || oy > 60) return null; // only east-looking rays hit these walls
    for (let k = 0; k < n; k++) if (Math.abs(oz - k * 100) <= 20) { const t = 20 - ox; return t > 0 && t <= maxT ? { t, nx: -1, ny: 0, nz: 0 } : null; }
    return null;
  }
});
const sitesFor = (n) => { const pts = Array.from({ length: n }, (_, k) => ({ id: 's' + k, x: 0, z: k * 100, prefer: [1, 0] })); return { hq: pts.slice(0, 1), project: pts.slice(1), skills: pts.slice(1), contact: pts.slice(1), decor: [], pool: pts }; };
const profile = (np, extra = {}) => ({ name: 'N', role: '', tagline: '', website: null, photo: null, tech: ['a'], links: [{ label: 'Mail', url: 'https://x.dev' }], projects: Array.from({ length: np }, (_, i) => ({ id: 'p' + i, title: 'Project ' + i, tagline: 't', description: 'd', image: null, imageUrl: null, tags: ['x'], url: 'https://p' + i + '.dev', links: [], featured: false, category: '' })), ...extra });

test('allocation: 6 projects plus Skills and Contact all get a board, on different walls, none overlapping', () => {
  const requests = [{ key: 'hq', category: 'hq', size: [16, 8], label: 'HQ' }, ...Array.from({ length: 6 }, (_, i) => ({ key: 'p' + i, category: 'project', size: [14, 7], label: 'P' + i })), { key: 'skills', category: 'skills', size: [14, 7], label: 'Skills' }, { key: 'contact', category: 'contact', size: [14, 7], label: 'Contact' }];
  const { placements, warnings } = B.allocateBoards({ world: city(12), requests, sites: sitesFor(12), rules });
  assert.equal(placements.size, 9); assert.equal(warnings.length, 0, warnings.join('\n'));
  const zs = [...placements.values()].map((p) => Math.round(p.pz)); assert.equal(new Set(zs).size, 9, 'one board per wall segment');
  const list = [...placements.values()].map((p) => ({ x: p.px, y: p.y, z: p.pz, w: p.w, h: p.h }));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.equal(B.overlaps({ px: list[i].x, pz: list[i].z, y: list[i].y }, list[i].w, list[i].h, [list[j]], 2), false);
});

test('allocation never stacks two boards on one wall, and a section that cannot be placed is reported, not skipped silently', () => {
  const requests = Array.from({ length: 4 }, (_, i) => ({ key: 'p' + i, category: 'project', size: [14, 7], label: `Project "P${i}"` }));
  const { placements, warnings } = B.allocateBoards({ world: city(2), requests, sites: sitesFor(2), rules });
  assert.equal(placements.size, 2); assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => /^Project "P\d": no board placed \(\d+ candidate sites tried/.test(w)), warnings.join('\n'));
  // two candidate sites on the SAME wall: the second board must not land on the first
  const one = { hq: [], project: [{ id: 'a', x: 0, z: 0, prefer: [1, 0] }, { id: 'b', x: 0, z: 5, prefer: [1, 0] }], pool: [] };
  const r = B.allocateBoards({ world: city(1), requests: requests.slice(0, 2), sites: one, rules: { ...rules, minSpacing: 0 } });
  assert.equal(r.placements.size, 1); assert.equal(r.warnings.length, 1);
});

test('profileBoards: pins for HQ, every project, Skills and Contact; spots for the F-key panel; images load, a missing one is reported and dropped', async () => {
  const logs = [], p = profile(3);
  p.photo = 'profile/photo.jpg'; p.photoUrl = 'http://h/content/profile/photo.jpg';
  p.projects[0].image = 'projects/ok.jpg'; p.projects[0].imageUrl = 'http://h/content/projects/ok.jpg';
  p.projects[1].image = 'projects/missing.jpg'; p.projects[1].imageUrl = 'http://h/content/projects/missing.jpg';
  p.projects[2].featured = true;
  calls.drawImage = 0;
  const scene = { added: [], add(o) { this.added.push(o); } };
  const res = await B.profileBoards({ THREE, scene, world: city(14), profile: p, sites: sitesFor(14), rules, log: (m) => logs.push(m) });
  assert.equal(res.pins.map((x) => x.kind).sort().join(), 'contact,hq,project,project,project,skills');
  assert.equal(res.pins.find((x) => x.kind === 'hq').id, 'portfolio-hq');
  assert.equal(res.spots.size, 4, '3 projects + the Contact marker'); assert.ok(res.spots.has('portfolio-contact')); assert.ok([...res.spots.values()].every((s) => s.placed));
  assert.ok(logs.some((l) => /project "Project 1": image "projects\/missing\.jpg" not found/.test(l)), logs.join('\n'));
  assert.equal(p.projects[1].imageUrl, null, 'a missing image is dropped from the project, so the F-key panel does not show a broken one either');
  assert.equal(calls.drawImage, 2 + 0, 'the photo (identity board, drawn once and shared) and the one image that loaded; the missing one is drawn without a picture');
  // featured projects are given walls first
  const order = res.pins.filter((x) => x.kind === 'project').map((x) => x.projectId);
  assert.equal(order[0], 'p0'); // pins follow the project order; the featured one was allocated first
  assert.ok(res.boards.length >= 6 && scene.added.length === 1);
});

test('profileBoards: a project without a wall gets NO pin and no spot (never a stand-in near the HQ), and a warning; nothing is skipped silently', async () => {
  const logs = [];
  const res = await B.profileBoards({ THREE, scene: { add() {} }, world: city(3), profile: profile(5), sites: sitesFor(3), rules, log: (m) => logs.push(m) });
  const projectPins = res.pins.filter((p) => p.kind === 'project');
  assert.ok(projectPins.length < 5); assert.equal([...res.spots.keys()].filter((k) => k !== 'portfolio-contact').length, projectPins.length); assert.ok([...res.spots.values()].every((s) => s.placed));
  assert.ok(logs.filter((l) => /no board placed/.test(l)).length >= 3);
  assert.equal(res.pins.some((p) => /^project-/.test(p.id) && !res.boards.length), false);
});

test('profileBoards with no projects, tech or links builds just the identity board; without a name nothing at all', async () => {
  const lone = await B.profileBoards({ THREE, scene: { add() {} }, world: city(6), profile: profile(0, { tech: [], links: [] }), sites: sitesFor(6), rules });
  assert.equal(lone.pins.map((p) => p.kind).join(), 'hq'); assert.equal(lone.spots.size, 0);
  const none = await B.profileBoards({ THREE, scene: { add() {} }, world: city(6), profile: null, sites: sitesFor(6), rules });
  assert.equal(none.pins.length, 0);
});

test('project boards are compact: title, tagline, image, 3 tags and the website; the description is never drawn', () => {
  const src = read('js/portfolio-billboards.js'), fn = src.slice(src.indexOf('function drawProject'), src.indexOf('/** A list board'));
  assert.match(fn, /p\.title/); assert.match(fn, /p\.tagline/); assert.match(fn, /p\.tags\.slice\(0, 3\)/); assert.match(fn, /websitePill\(ctx, p\.url/); assert.doesNotMatch(fn, /description/);
  assert.match(fn, /img \? framedImage\(ctx, img, pad\) : pad \+ 10/, 'a project without an image uses the whole width');
});

// ------------------------------------------------------------------ F-key panel
function fakeDom() {
  const mk = () => { const n = { children: [], style: {}, dataset: {}, attrs: {}, listeners: {}, hidden: false, className: '', textContent: '', classes: new Set(),
    classList: { toggle: (c, on) => { on ? n.classes.add(c) : n.classes.delete(c); }, contains: (c) => n.classes.has(c) },
    append(...c) { n.children.push(...c); }, replaceChildren(...c) { n.children = c; }, setAttribute(k, v) { n.attrs[k] = v; }, addEventListener(t, f) { n.listeners[t] = f; }, focus() {}, blur() {} }; return n; };
  return { createElement: mk, body: { append() {} }, activeElement: null };
}
test('F-key panel: the project detail shows title, image, intro, description, all tags, website and links; no image means a single column; setProjects replaces the markers', () => {
  const dom = fakeDom(), win = { addEventListener() {} };
  const T = new Proxy({}, { get: (t, k) => (k === 'DoubleSide' ? 2 : class extends Obj { constructor() { super(); this.scale = { setScalar() {} }; } }) });
  const { PortfolioInteraction } = loadModule(read('js/portfolio-interaction.js').replace('import.meta.url', "'http://h/js/portfolio-interaction.js'"), { imports: { 'three/webgpu': T }, globals: { document: dom, window: win, URL, location: { origin: 'http://h' }, console } });
  const scene = { removed: [], add() {}, remove(o) { this.removed.push(o); } };
  const pi = new PortfolioInteraction({ scene, ground: () => 0 });
  const project = { id: 'a', title: 'Alpha', tagline: 'Short intro', description: 'The full description.', imageUrl: 'http://h/content/projects/a.jpg', imageAlt: 'Alpha screenshot', tags: ['x', 'y', 'z', 'w'], url: 'https://alpha.dev', links: [{ label: 'Code', url: 'https://git.dev/a' }], category: 'Web', featured: true };
  pi.setProjects([{ project, x: 1, z: 2 }]);
  pi._fill(project);
  const u = pi.ui;
  assert.equal(u.title.textContent, 'Alpha'); assert.equal(u.tagline.textContent, 'Short intro'); assert.equal(u.desc.textContent, 'The full description.'); assert.equal(u.kicker.textContent, 'Web · Featured');
  assert.match(u.media.style.backgroundImage, /a\.jpg/); assert.equal(u.media.attrs['aria-label'], 'Alpha screenshot'); assert.equal(u.panel.classList.contains('no-media'), false);
  assert.equal(u.tags.children.length, 4, 'all tags, not just three');
  assert.equal(u.links.children.length, 2); assert.equal(u.links.children[0].textContent, 'Website'); assert.equal(u.links.children[0].href, 'https://alpha.dev');
  pi._fill({ id: 'b', title: 'Beta' }); // a project with nothing but a title
  assert.equal(u.panel.classList.contains('no-media'), true); assert.equal(u.desc.hidden, true); assert.equal(u.links.hidden, true); assert.equal(u.tags.hidden, true); assert.equal(u.media.style.backgroundImage, '');
  pi.setProjects([]); assert.equal(scene.removed.length, 1); assert.equal(pi.points.length, 0);
});

test('one source of truth: nothing else reads portfolio.json except the compatibility layer', () => {
  for (const f of ['js/main.js', 'js/spider-install.js', 'js/portfolio-billboards.js', 'js/nyc-map.js']) assert.doesNotMatch(read(f), /portfolio\.json/, f);
  assert.match(read('js/portfolio-content.js'), /portfolio\.json/);
  assert.doesNotMatch(read('js/spider-install.js'), /loadContent/);
  assert.match(read('js/main.js'), /spider\.portfolio\.setProjects\(/);
});

test('markers and pins stand on a sidewalk in sight of the board, facing it; without a sidewalk position the street point is used and reported', async () => {
  const sidewalk = { onSidewalk: (x) => x < -8 && x > -16, blocked: () => false, landmarks: [] }; // a strip of sidewalk on the far side of the street
  const logs = [];
  const res = await B.profileBoards({ THREE, scene: { add() {} }, world: city(6), profile: profile(2), sites: sitesFor(6), rules, ground: sidewalk, log: (m) => logs.push(m) });
  assert.equal(logs.length, 0, logs.join('; '));
  for (const pin of res.pins) { assert.ok(pin.x < -8 && pin.x > -16, `${pin.id} is on the sidewalk strip (x=${pin.x})`); assert.ok(Math.abs(pin.heading - Math.PI / 2) < 0.2, `${pin.id} faces the wall (east): ${pin.heading}`); assert.equal(pin.sidewalk, true); }
  for (const s of res.spots.values()) assert.ok(s.x < -8 && s.x > -16, 'the F markers use the same sidewalk positions');
  // obstacles and walls in the way: nothing is standable, so the street point is used and the warning says so
  const logs2 = [];
  const blocked = await B.profileBoards({ THREE, scene: { add() {} }, world: city(6), profile: profile(1), sites: sitesFor(6), rules, ground: { ...sidewalk, blocked: () => true }, log: (m) => logs2.push(m) });
  assert.ok(logs2.some((l) => /no sidewalk position with a clear view/.test(l)), logs2.join('; ')); assert.ok(blocked.pins.every((p) => p.sidewalk === false && p.x === 0));
  assert.equal(B.findStandSpot(city(1), { onSidewalk: () => false, blocked: () => false }, { px: 19.9, pz: 0, y: 15, dir: [1, 0] }), null);
});

// ------------------------------------------------------------------ Times Square: the boards take the city's screens
const slot = (x, z, y, w, h, rotY = Math.PI / 2) => ({ x, y, z, w, h, rotY, variant: 0 });
const TSTHREE = { ...THREE, BufferGeometry: class { setAttribute(k, v) { this[k] = v; } setIndex(i) { this.index = i; } }, Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } } };

test('Times Square: every request gets a screen, the identity board the one nearest the middle, the markers at least 16 m apart; a request without a screen is reported', () => {
  const slots = [slot(0, -200, 20, 20, 9), slot(0, -100, 14, 18, 9), slot(0, 0, 30, 16, 8), slot(0, -300, 18, 14, 8), slot(0, -40, 10, 3, 3), slot(0, 60, 80, 20, 9)]; // the last two: too small / too high
  const reqs = [{ key: 'hq', category: 'hq', label: 'HQ' }, { key: 'a', category: 'project', label: 'A' }, { key: 'b', category: 'project', label: 'B' }, { key: 'c', category: 'project', label: 'C' }, { key: 'd', category: 'project', label: 'D' }];
  const r = B.allocateSlots({ world: null, requests: reqs, slots, centre: { x: 0, z: -105 } });
  assert.equal(r.placements.size, 4); assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /^D: no Times Square screen free/);
  assert.equal(r.placements.get('hq').index, 1, 'the identity board is on the screen nearest the middle of the square');
  assert.ok(![...r.placements.values()].some((p) => p.index === 4 || p.index === 5), 'a screen too small or too high for the text is never used');
  const stands = [...r.placements.values()].map((p) => p.stand);
  for (let i = 0; i < stands.length; i++) for (let j = i + 1; j < stands.length; j++) assert.ok(Math.hypot(stands[i].x - stands[j].x, stands[i].z - stands[j].z) >= 16);
  for (const p of r.placements.values()) assert.ok(Math.abs(p.nx - Math.sin(p.slot.rotY)) < 1e-9 && Math.abs(p.nz - Math.cos(p.slot.rotY)) < 1e-9, 'the board faces the way the screen did');
  assert.equal(r.used.size, 4);
});

test('Times Square: with city ground data the marker is a sidewalk spot in sight of the screen, and none is reused', () => {
  const slots = [slot(0, -100, 14, 18, 9), slot(0, -102, 30, 18, 9)]; // two screens above each other: their spots would coincide
  const ground = { onSidewalk: (x) => x > 20 && x < 60, blocked: () => false, landmarks: [] };
  const world = { rayFirstHit: () => null };
  const r = B.allocateSlots({ world, requests: [{ key: 'a', category: 'project', label: 'A' }, { key: 'b', category: 'project', label: 'B' }], slots, ground });
  assert.equal(r.placements.size, 2);
  const [a, b] = [...r.placements.values()].map((p) => p.stand);
  assert.ok(a.x > 20 && a.x < 60 && b.x > 20 && b.x < 60);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 16, 'a second board never lands on the first one\'s marker');
});

test('Times Square: a texture is cropped to the shape of a screen, never stretched', () => {
  assert.deepEqual(Array.from(B.coverWindow(2, 2)), [0, 0, 1, 1]);
  const wide = B.coverWindow(2, 4); assert.deepEqual([wide[0], wide[2]].map(Number), [0, 1]); assert.ok(Math.abs((wide[3] - wide[1]) - 0.5) < 1e-9 && Math.abs((wide[1] + wide[3]) / 2 - 0.5) < 1e-9);
  const tall = B.coverWindow(2, 1); assert.deepEqual([tall[1], tall[3]].map(Number), [0, 1]); assert.ok(Math.abs((tall[2] - tall[0]) - 0.5) < 1e-9);
  const g = B.screenGeometry(TSTHREE, [{ x: 10, y: 5, z: 0, w: 4, h: 2, rotY: Math.PI / 2, uv: [0, 0, 1, 1] }]);
  const pos = g.position.array; // rotY = 90 degrees: the screen's front looks along +x and it spreads along z
  assert.ok(Math.abs(g.normal.array[0] - 1) < 1e-6 && Math.abs(g.normal.array[2]) < 1e-6);
  const zs = [pos[2], pos[5], pos[8], pos[11]]; assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - 4) < 1e-6, 'as wide as the slot'); assert.ok(pos.every((v, i) => i % 3 !== 0 || Math.abs(v - 10) < 1e-6));
  assert.equal(g.index.length, 6);
});

test('profileBoards in Times Square: boards and decor screens replace the original posters, the pins are at the markers, and what finds no screen falls back to the city sites', async () => {
  const poster = { isMesh: true, name: 'TimesSquareBillboards_3', geometry: { disposed: 0, dispose() { this.disposed++; } }, parent: { removed: 0, remove() { this.removed++; } } };
  const other = { isMesh: true, name: 'SomethingElse', geometry: { dispose() { throw new Error('not a poster'); } }, parent: { remove() { throw new Error('not a poster'); } } };
  const scene = { added: [], add(o) { this.added.push(o); }, traverse(fn) { fn(poster); fn(other); } };
  const slots = [slot(0, -200, 20, 20, 9), slot(0, -100, 14, 18, 9), slot(0, 0, 30, 16, 8), slot(0, -300, 18, 14, 8), slot(0, -400, 22, 4, 12), slot(0, -500, 40, 10, 14), slot(0, -600, 12, 20, 5)];
  const ledFor = []; const led = (tex) => { ledFor.push(tex); return { led: true }; };
  const p = profile(2); // HQ + 2 projects + Skills + Contact: 5 requests, 4 screens fit (the others are too small / narrow), so one falls back to the city
  const logs = [];
  const res = await B.profileBoards({ THREE: TSTHREE, scene, world: city(14), profile: p, sites: sitesFor(14), rules, timesSquare: { slots, centre: { x: 0, z: -150 }, led }, log: (m) => logs.push(m) });
  assert.ok(res.timesSquare && res.timesSquare.boards >= 3, JSON.stringify(res.timesSquare));
  assert.equal(res.timesSquare.boards + res.timesSquare.decor, slots.length, 'every screen of the square shows the profile');
  assert.equal(poster.geometry.disposed, 1); assert.equal(poster.parent.removed, 1, 'the original poster is gone');
  assert.equal(res.pins.length, 5, 'every board has its pin (' + logs.join(' | ') + ')');
  assert.ok(res.group.children.some((c) => c.material && c.material.led), 'the screens use the LED material');
  const hq = res.pins.find((x) => x.kind === 'hq'); assert.ok(Math.abs(hq.z - -105) < 100, 'the identity board is in the square');
});

test('profileBoards without Times Square screens is unchanged: no posters are touched', async () => {
  const scene = { add() {}, traverse() { throw new Error('the scene is not searched'); } };
  const res = await B.profileBoards({ THREE, scene, world: city(14), profile: profile(2), sites: sitesFor(14), rules, timesSquare: { slots: [] }, log: () => {} });
  assert.equal(res.timesSquare, null); assert.equal(res.pins.length, 5);
});
