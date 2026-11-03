// Portfolio content: ONE source of truth, content/profile.json. This module loads it, validates it and turns it into the normalised shape every consumer reads
// (the billboards, the map pins, the F-key project panel). It never throws for bad optional data: a bad field is dropped and reported in `warnings`.
//
// Schema (schemaVersion 2). Only `name` is required; everything else is optional and an empty value is simply not shown.
//   name        string   REQUIRED
//   role, tagline, website   string
//   photo       string   path of the profile photo, relative to content/ (e.g. "profile/photo.jpg")
//   tech        string[] technologies (profile board, skills board)
//   links       { label, url }[]   contact and social links (contact board)
//   projects    project[]
//     id          string    unique; made from the title when missing
//     title       string    REQUIRED (a project without a title is skipped, with a warning)
//     tagline     string    one line: the billboard and the first line of the panel
//     description string    the full text: the panel only (never the billboard)
//     image       string    path relative to content/, same site as the game (e.g. "projects/shop.jpg"); a missing file is reported and ignored
//     imageAlt    string
//     tags        string[]  technologies of the project (a few on the billboard, all in the panel)
//     url         string    the project's website (http/https); shown on the billboard and as the panel's main link
//     links       { label, url }[]   further links, panel only
//     featured    boolean   featured projects are given billboards first
//     category    string    e.g. "Web", "Game": a small label
//
// Legacy: content/portfolio.json ({ points: [...] }) is DEPRECATED. If profile.json has no projects, its non-placeholder points are used as projects (with a warning);
// when profile.json has projects it is ignored. A file whose note says it is placeholder content is never used.

const LIMITS = { title: 60, tagline: 140, description: 4000, tags: 12, links: 12, tech: 24, projects: 24 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function slug(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'; }

/** A well-formed absolute http(s) URL, or null. */
function cleanUrl(v) {
  const s = str(v);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' ? s : null; } catch { return null; }
}

/** An image path inside content/: relative, no scheme, no "..", no leading slash. Returns the cleaned path or null. */
function cleanImagePath(v) {
  const s = str(v).replace(/\\/g, '/');
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.split('/').includes('..')) return null;
  return s;
}

function cleanStrings(v, max, label, warn) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { warn(`${label} must be an array of strings; ignored`); return []; }
  const out = [];
  for (const x of v) { const s = str(x); if (s) out.push(s); else warn(`${label} has an empty or non-string entry; skipped`); }
  if (out.length > max) { warn(`${label} has ${out.length} entries; only the first ${max} are used`); out.length = max; }
  return out;
}

function cleanLinks(v, label, warn) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { warn(`${label} must be an array of { label, url }; ignored`); return []; }
  const out = [];
  for (const l of v) {
    if (!isObj(l)) { warn(`${label} has an entry that is not an object; skipped`); continue; }
    const url = str(l.url), href = cleanUrl(url) || (/^(mailto|tel):[^\s]+$/i.test(url) ? url : null);
    const lab = str(l.label);
    if (!lab) { warn(`${label}: a link has no label; skipped`); continue; }
    if (!href) { warn(`${label}: "${lab}" has an invalid url "${url}"; skipped`); continue; }
    out.push({ label: lab, url: href });
  }
  if (out.length > LIMITS.links) { warn(`${label} has ${out.length} links; only the first ${LIMITS.links} are used`); out.length = LIMITS.links; }
  return out;
}

function cleanProject(raw, index, warn) {
  const where = `projects[${index}]`;
  if (!isObj(raw)) { warn(`${where} is not an object; skipped`); return null; }
  const title = str(raw.title).slice(0, LIMITS.title);
  if (!title) { warn(`${where} has no title; skipped`); return null; }
  const w = (m) => warn(`${where} "${title}": ${m}`);
  let url = null;
  if (raw.url !== undefined && raw.url !== null && str(raw.url) !== '') { url = cleanUrl(raw.url); if (!url) w(`invalid url "${raw.url}"; ignored`); }
  let image = null;
  if (raw.image !== undefined && raw.image !== null && str(raw.image) !== '') { image = cleanImagePath(raw.image); if (!image) w(`image "${raw.image}" must be a path relative to content/ (no scheme, no leading slash, no ".."); ignored`); }
  const tagline = str(raw.tagline).slice(0, LIMITS.tagline), description = str(raw.description).slice(0, LIMITS.description);
  if (raw.tagline && str(raw.tagline).length > LIMITS.tagline) w(`tagline is longer than ${LIMITS.tagline} characters; cut`);
  return {
    id: str(raw.id) ? slug(raw.id) : '', title, tagline, description, image, imageAlt: str(raw.imageAlt),
    tags: cleanStrings(raw.tags, LIMITS.tags, `${where} tags`, warn), url, links: cleanLinks(raw.links, `${where} links`, warn),
    featured: raw.featured === true, category: str(raw.category).slice(0, 24)
  };
}

/** A project from a legacy portfolio.json point. */
function fromLegacyPoint(p) {
  const links = Array.isArray(p.links) ? p.links : [];
  const first = links.find((l) => l && cleanUrl(l.url));
  return { id: p.id, title: p.title, tagline: p.tagline, description: p.description, image: p.image, imageAlt: p.imageAlt, tags: p.tags, url: first ? first.url : undefined, links: links.filter((l) => l !== first) };
}

const isPlaceholderNote = (note) => /nothing here is real|placeholder/i.test(String(note || ''));

/**
 * @param raw     parsed profile.json
 * @param legacy  parsed portfolio.json (optional)
 * @returns { profile, warnings }  profile is null when `raw` is unusable (no name): nothing is built then.
 */
function normalizePortfolio(raw, legacy = null) {
  const warnings = [], warn = (m) => warnings.push(m);
  if (!isObj(raw)) { warn('profile.json is missing or is not a JSON object'); return { profile: null, warnings }; }
  const name = str(raw.name);
  if (!name) { warn('profile.json has no "name" (required): no billboards, pins or panels are built'); return { profile: null, warnings }; }
  const photo = raw.photo === undefined || raw.photo === null || str(raw.photo) === '' ? null : cleanImagePath(raw.photo);
  if (raw.photo && !photo) warn(`photo "${raw.photo}" must be a path relative to content/; ignored`);
  const website = raw.website ? cleanUrl(raw.website) : null;
  if (raw.website && !website) warn(`website "${raw.website}" is not a valid http(s) URL; ignored`);

  let projectsRaw = raw.projects;
  if (projectsRaw !== undefined && !Array.isArray(projectsRaw)) { warn('projects must be an array; ignored'); projectsRaw = []; }
  projectsRaw = projectsRaw || [];
  if (!projectsRaw.length && isObj(legacy) && Array.isArray(legacy.points) && legacy.points.length) {
    if (isPlaceholderNote(legacy.note)) warn('content/portfolio.json is placeholder content and is not used');
    else { warn('content/portfolio.json is DEPRECATED: its points are used as projects because profile.json has none. Move them into profile.json "projects".'); projectsRaw = legacy.points.map(fromLegacyPoint); }
  } else if (projectsRaw.length && isObj(legacy) && Array.isArray(legacy.points) && legacy.points.length && !isPlaceholderNote(legacy.note)) {
    warn('content/portfolio.json is DEPRECATED and ignored: profile.json "projects" is the single source of truth');
  }
  if (projectsRaw.length > LIMITS.projects) { warn(`projects has ${projectsRaw.length} entries; only the first ${LIMITS.projects} are used`); projectsRaw = projectsRaw.slice(0, LIMITS.projects); }

  const seen = new Set(), projects = [];
  projectsRaw.forEach((r, i) => {
    const p = cleanProject(r, i, warn); if (!p) return;
    let id = p.id || slug(p.title);
    if (seen.has(id)) { warn(`projects[${i}] "${p.title}": duplicate id "${id}"; skipped (ids must be unique)`); return; }
    seen.add(id); p.id = id; projects.push(p);
  });
  if (Array.isArray(raw.projects) && raw.projects.length === 0) warn('projects is empty: no project billboards or pins');

  const tech = cleanStrings(raw.tech, LIMITS.tech, 'tech', warn), links = cleanLinks(raw.links, 'links', warn);
  if (Array.isArray(raw.tech) && !raw.tech.length) warn('tech is empty: no Skills billboard or pin');
  if (Array.isArray(raw.links) && !raw.links.length) warn('links is empty: no Contact billboard or pin');
  for (const k of ['role', 'tagline']) if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'string') warn(`${k} must be a string; ignored`);

  return { profile: { name, role: str(raw.role), tagline: str(raw.tagline), website, photo, tech, links, projects }, warnings };
}

/**
 * The Contact F-key panel as a project-shaped card, made from the profile's own links (no URL is written anywhere else): the panel shows the first link as its main button and the
 * rest beside it. Null when the profile has no links (then there is no Contact board either).
 */
function contactCard(profile) {
  if (!profile || !profile.links || !profile.links.length) return null;
  return {
    id: 'portfolio-contact', title: 'Contact & Links', category: 'Get in touch', prompt: 'Contact & Links',
    tagline: [profile.name, profile.role].filter(Boolean).join(' · '), description: '', tags: [], image: null, imageUrl: null, url: null, links: profile.links.map((l) => ({ ...l })), featured: false
  };
}

/** Where a content path ends up: content/<path> next to js/. */
const contentUrl = (path, base) => new URL('../content/' + path, base).href;

/**
 * Loads and normalises the portfolio. `fetchJson(url)` returns parsed JSON or null (a missing file is not an error). Every warning is logged once with a clear prefix.
 * @returns { profile, warnings }
 */
async function loadPortfolio({ base, fetchJson, log = console.warn }) {
  const raw = await fetchJson(contentUrl('profile.json', base));
  const legacy = await fetchJson(contentUrl('portfolio.json', base));
  const res = normalizePortfolio(raw, legacy);
  if (res.profile) {
    if (res.profile.photo) res.profile.photoUrl = contentUrl(res.profile.photo, base);
    for (const p of res.profile.projects) p.imageUrl = p.image ? contentUrl(p.image, base) : null;
  }
  for (const w of res.warnings) log(`[portfolio] ${w}`);
  return res;
}

export { normalizePortfolio, loadPortfolio, contactCard, cleanUrl, cleanImagePath, slug, contentUrl, LIMITS };
