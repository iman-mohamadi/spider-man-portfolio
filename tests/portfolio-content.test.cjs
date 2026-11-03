const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const sandbox = { URL, console };
const C = loadModule(read('js/portfolio-content.js'), { imports: {}, globals: sandbox });
const S = loadModule(read('js/portfolio-sites.js'), { imports: {}, globals: sandbox });
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));
const norm = (raw, legacy) => C.normalizePortfolio(clone(raw), clone(legacy));

const full = {
  name: 'Test Person', role: 'Role', tagline: 'Tag', website: 'https://example.com', photo: 'profile/photo.jpg', tech: ['A', 'B'], links: [{ label: 'Mail', url: 'mailto:a@b.co' }, { label: 'Site', url: 'https://x.dev' }],
  projects: [
    { id: 'one', title: 'One', tagline: 'First', description: 'Long text', image: 'projects/one.jpg', imageAlt: 'Shot', tags: ['x', 'y'], url: 'https://one.dev', links: [{ label: 'Code', url: 'https://git.dev/one' }], featured: true, category: 'Web' },
    { title: 'Two Without Image' }
  ]
};

test('the unified schema: every project field is read, optional ones default, ids are made from titles', () => {
  const { profile, warnings } = norm(full);
  assert.equal(profile.name, 'Test Person'); assert.equal(profile.projects.length, 2);
  const [a, b] = profile.projects;
  assert.equal(a.id, 'one'); assert.equal(a.featured, true); assert.equal(a.category, 'Web'); assert.equal(a.image, 'projects/one.jpg'); assert.equal(a.links[0].url, 'https://git.dev/one');
  assert.equal(b.id, 'two-without-image'); assert.equal(b.image, null); assert.equal(b.featured, false); assert.equal(b.tags.length, 0); assert.equal(b.description, '');
  assert.equal(warnings.length, 0, warnings.join('\n'));
});

test('validation: required fields, duplicate ids, missing titles, invalid urls and images, malformed content never throw', () => {
  assert.equal(norm(null).profile, null); assert.equal(norm({ role: 'x' }).profile, null); assert.equal(norm([]).profile, null);
  const { profile, warnings } = norm({
    name: 'N', website: 'not a url', photo: '../secret.jpg', tech: 'oops', links: [{ label: 'x', url: 'javascript:alert(1)' }, { url: 'https://a.b' }, 5],
    projects: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Dup' }, { tagline: 'no title' }, 'string', { title: 'Bad', url: 'ftp://x', image: 'https://evil/x.png', tags: [1, '', 'ok'] }, { title: 'Abs', image: '/etc/x.png' }]
  });
  assert.equal(profile.projects.map((p) => p.id).join(), 'a,bad,abs');
  assert.equal(profile.website, null); assert.equal(profile.photo, null); assert.equal(profile.tech.length, 0); assert.equal(profile.links.length, 0);
  const bad = profile.projects[1]; assert.equal(bad.url, null); assert.equal(bad.image, null); assert.equal(Array.from(bad.tags).join(), 'ok');
  assert.equal(profile.projects[2].image, null, 'absolute paths are refused');
  for (const needle of ['duplicate id "a"', 'has no title', 'is not an object', 'invalid url "ftp://x"', 'must be a path relative to content/', 'website', 'photo', 'tech must be an array', 'invalid url']) {
    assert.ok(warnings.some((w) => w.includes(needle)), `a warning mentions: ${needle}\n${warnings.join('\n')}`);
  }
});

test('empty arrays are valid and reported, and a profile with no projects is fine', () => {
  const { profile, warnings } = norm({ name: 'N', tech: [], links: [], projects: [] });
  assert.equal(profile.projects.length, 0);
  for (const needle of ['projects is empty', 'tech is empty', 'links is empty']) assert.ok(warnings.some((w) => w.includes(needle)), needle);
});

test('limits: long text is cut, too many projects or tags are capped, with warnings', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ title: 'P' + i }));
  const { profile, warnings } = norm({ name: 'N', projects: many });
  assert.equal(profile.projects.length, C.LIMITS.projects); assert.ok(warnings.some((w) => /only the first/.test(w)));
  const long = norm({ name: 'N', projects: [{ title: 'T', tagline: 'x'.repeat(300), tags: Array.from({ length: 20 }, (_, i) => 't' + i) }] });
  assert.equal(long.profile.projects[0].tagline.length, C.LIMITS.tagline); assert.equal(long.profile.projects[0].tags.length, C.LIMITS.tags);
});

test('legacy portfolio.json: placeholder content is never used, real points become projects with a deprecation warning, profile projects win', () => {
  const placeholder = { note: 'Placeholder content; nothing here is real.', points: [{ id: 'project-1', title: 'Your Project Name' }] };
  let r = norm({ name: 'N' }, placeholder); assert.equal(r.profile.projects.length, 0); assert.ok(r.warnings.some((w) => /placeholder/.test(w)));
  const real = { points: [{ id: 'old', title: 'Old Project', tagline: 't', description: 'd', image: 'old.png', tags: ['a'], links: [{ label: 'Live', url: 'https://old.dev' }, { label: 'Code', url: 'https://git.dev/old' }] }] };
  r = norm({ name: 'N' }, real);
  assert.equal(r.profile.projects.length, 1); const p = r.profile.projects[0];
  assert.equal(p.title, 'Old Project'); assert.equal(p.url, 'https://old.dev'); assert.equal(p.links.length, 1); assert.equal(p.description, 'd'); assert.ok(r.warnings.some((w) => /DEPRECATED/.test(w)));
  r = norm({ name: 'N', projects: [{ title: 'New' }] }, real);
  assert.equal(r.profile.projects.map((x) => x.title).join(), 'New'); assert.ok(r.warnings.some((w) => /ignored/.test(w)));
});

test('loadPortfolio resolves image and photo paths against content/ and logs every warning once', async () => {
  const logs = [];
  const files = { 'profile.json': { name: 'N', photo: 'profile/p.jpg', projects: [{ title: 'A', image: 'projects/a.png' }, { title: 'B', url: 'bad' }] }, 'portfolio.json': null };
  const res = await C.loadPortfolio({ base: 'http://localhost:8130/js/main.js', fetchJson: async (u) => files[u.split('/content/')[1]] ?? null, log: (m) => logs.push(m) });
  assert.equal(res.profile.photoUrl, 'http://localhost:8130/content/profile/p.jpg'); assert.equal(res.profile.projects[0].imageUrl, 'http://localhost:8130/content/projects/a.png'); assert.equal(res.profile.projects[1].imageUrl, null);
  assert.equal(logs.length, res.warnings.length); assert.ok(logs.every((l) => l.startsWith('[portfolio] ')));
});

test('the site configuration offers many candidates per category, from one place', () => {
  const ids = { 5: 0, 6: -310, 7: -585, madison: 155, park: 311, lex: 467, 3: 622, 2: 838, 8: -860 };
  const keys = ['empire', 'timessq', 'chrysler', 'grandcentral', 'bryant', 'flatiron', 'centralpark'];
  const cc = { avenueX: (a) => ids[a], streetZ: (n) => (n - 42) * 80, TELEPORT_LOCATIONS: Object.fromEntries(keys.map((k, i) => [k, { x: i, z: i, heading: 0 }])) };
  const sites = S.buildSites(cc);
  assert.equal(sites.hq.length, 1); assert.ok(sites.project.length >= 12); assert.ok(sites.skills.length >= 3 && sites.contact.length >= 3 && sites.pool.length >= 8);
  for (const list of Object.values(sites)) for (const s of list) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z), s.id);
  assert.equal(S.SITE_RULES.decorMax, 3);
});

test('the real content/profile.json: valid without warnings, all 8 projects, every referenced image exists, urls are the verified ones', () => {
  const { existsSync } = require('node:fs');
  const raw = JSON.parse(read('content/profile.json'));
  const { profile, warnings } = norm(raw);
  assert.equal(warnings.length, 0, warnings.join('\n'));
  assert.equal(profile.name, 'Iman Mohammadi');
  assert.equal(profile.projects.map((p) => p.id).join(), 'raya-ui,woodcoder,hotelyar,tricup,tinyhub,rizo-tools,rizo-weather,car-portfolio');
  const urls = ['https://raya-ui.com/', 'https://woodcoder.com/', 'https://hotelyar.com/', 'https://tricup.ir/', 'https://tinyhub.ir/', 'https://tools.rizo.top/', 'https://weather.rizo.top/', 'https://car.iman-mhmdi.ir/'];
  assert.equal(profile.projects.map((p) => p.url).join(), urls.join());
  for (const p of profile.projects) { assert.ok(p.tagline && p.description && p.category && p.tags.length, p.id); if (p.image) assert.ok(existsSync(join(root, 'content', p.image)), `${p.id}: ${p.image} exists`); }
  assert.ok(existsSync(join(root, 'content', profile.photo)));
  assert.ok(profile.links.some((l) => l.url === 'https://www.linkedin.com/in/iman-mohammadiii/'));
  assert.equal(profile.tech.join(), 'Vue.js,Nuxt.js,React,Next.js,TypeScript,Three.js,Node.js,Tailwind CSS');
});

test('the Contact panel card is made from the profile links only, in the project-card shape the F panel reads', () => {
  const { profile } = norm(full);
  const c = C.contactCard(profile);
  assert.equal(c.id, 'portfolio-contact'); assert.equal(c.title, 'Contact & Links'); assert.equal(c.prompt, 'Contact & Links');
  assert.equal(c.links.map((l) => l.url).join(), profile.links.map((l) => l.url).join()); assert.equal(c.url, null); assert.equal(c.imageUrl, null);
  assert.equal(C.contactCard({ name: 'N', links: [] }), null); assert.equal(C.contactCard(null), null);
  const real = norm(JSON.parse(read('content/profile.json'))).profile, rc = C.contactCard(real);
  assert.equal(rc.links.map((l) => l.label).join(), 'LinkedIn,Website');
  assert.equal(rc.links.map((l) => l.url).join(), 'https://www.linkedin.com/in/iman-mohammadiii/,https://iman-mhmdi.ir');
});
