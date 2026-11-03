import * as THREE from 'three/webgpu';

// Portfolio interaction points: a glowing marker at each project's place in the city, a prompt when Spider-Man is near, and a project panel opened with F.
// This module owns ONLY the portfolio UI and markers; it knows nothing about movement. The projects come from the one portfolio source (js/portfolio-content.js, content/profile.json):
// the same objects that feed the billboards and the map pins. setProjects() receives them with the places the billboards allocation found.
// `loadContent` (the old content/portfolio.json reader) is kept for old callers only and is DEPRECATED.

const LEGACY_URL = new URL('../content/portfolio.json', import.meta.url).href;

/** @deprecated content/portfolio.json is read by portfolio-content.js (compatibility layer); use that. */
async function loadContent() {
  try {
    const r = await fetch(LEGACY_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.points)) throw new Error('no points');
    return data;
  } catch (e) {
    console.warn('[portfolio] legacy content unavailable:', e.message);
    return { points: [] };
  }
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

class PortfolioInteraction {
  /** @param spawn {x, z}: where legacy placement offsets are measured from; ground(x, z) -> y. Projects are given later with setProjects(). */
  constructor({ scene, content = null, spawn = { x: 0, z: 0 }, ground, onOpen, onClose }) {
    this.scene = scene;
    this.ground = ground;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.isOpen = false;
    this.nearId = null;
    this.points = [];
    if (content && Array.isArray(content.points)) { // old callers: { points: [{ ..., placement: { dx, dz } }] }
      this.setProjects(content.points.map((p) => ({ project: p, x: spawn.x + ((p.placement || {}).dx || 0), z: spawn.z + ((p.placement || {}).dz || 0) })));
    }
    this._buildUI();
  }

  /** The projects of the single portfolio source, each with its place in the city: [{ project, x, z }]. Replaces the markers. */
  setProjects(list) {
    for (const pt of this.points) { if (pt.group) this.scene.remove(pt.group); }
    this.nearId = null;
    this.points = (list || []).map(({ project, x, z }) => ({ data: project, x, z, y: this.ground ? this.ground(x, z) : 0, group: null }));
    for (const pt of this.points) pt.group = this._makeMarker(pt);
    if (this.ui) this.ui.prompt.hidden = true;
  }

  _makeMarker(pt) {
    const g = new THREE.Group();
    g.name = `PortfolioMarker_${pt.data.id}`;
    const gold = 0xffc21a;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.9, 42, 16, 1, true),
      new THREE.MeshBasicNodeMaterial({ color: gold, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
    );
    beam.position.y = 21;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.09, 8, 48), new THREE.MeshBasicNodeMaterial({ color: gold }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.15;
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.05, 8, 64), new THREE.MeshBasicNodeMaterial({ color: gold, transparent: true, opacity: 0.55 }));
    ring2.rotation.x = Math.PI / 2; ring2.position.y = 0.12;
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshBasicNodeMaterial({ color: 0xfff1b0 }));
    gem.position.y = 3.2;
    for (const m of [beam, ring, ring2, gem]) { m.frustumCulled = false; g.add(m); }
    g.position.set(pt.x, pt.y, pt.z);
    g.userData = { beam, ring, ring2, gem };
    this.scene.add(g);
    g.updateMatrixWorld(true);
    return g;
  }

  _buildUI() {
    const prompt = el('div', 'pf-prompt'); prompt.hidden = true; prompt.setAttribute('role', 'status'); prompt.setAttribute('aria-live', 'polite');
    const key = el('kbd', '', 'F'); const label = el('span', 'pf-prompt-text', 'View project');
    prompt.append(key, label);
    const overlay = el('div', 'pf-overlay'); overlay.hidden = true;
    const panel = el('section', 'pf-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'pf-title');
    const close = el('button', 'pf-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close project panel');
    const media = el('div', 'pf-media'); const mediaLabel = el('span', '', 'Project screenshot'); media.append(mediaLabel);
    const body = el('div', 'pf-body');
    const kicker = el('p', 'pf-kicker', ''); const title = el('h2', 'pf-title', ''); title.id = 'pf-title';
    const tagline = el('p', 'pf-tagline', ''); const desc = el('p', 'pf-desc', '');
    const tags = el('ul', 'pf-tags'); const links = el('div', 'pf-links');
    const hint = el('p', 'pf-hint', 'Press F or Esc to close');
    body.append(kicker, title, tagline, desc, tags, links, hint);
    panel.append(close, media, body);
    overlay.append(panel);
    document.body.append(prompt, overlay);
    Object.assign(this, { ui: { prompt, label, overlay, panel, close, media, mediaLabel, kicker, title, tagline, desc, tags, links } });
    close.addEventListener('click', () => this.closePanel());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.closePanel(); });
    window.addEventListener('keydown', (e) => { if (this.isOpen && e.code === 'Escape') { e.preventDefault(); this.closePanel(); } });
  }

  /** The detail panel for one project: title, image (when it has one), the short introduction, the full description, all tags, the website and the other links. */
  _fill(d) {
    const u = this.ui, image = d.imageUrl || d.image || null;
    u.kicker.textContent = [d.category, d.featured ? 'Featured' : ''].filter(Boolean).join(' · ');
    u.kicker.hidden = !u.kicker.textContent;
    u.title.textContent = d.title || '';
    u.tagline.textContent = d.tagline || ''; u.tagline.hidden = !d.tagline;
    u.desc.textContent = d.description || ''; u.desc.hidden = !d.description;
    u.mediaLabel.textContent = d.imageAlt || '';
    u.media.setAttribute('role', 'img'); u.media.setAttribute('aria-label', d.imageAlt || d.title || 'Project image');
    u.media.style.backgroundImage = image ? `url("${String(image).replace(/"/g, '%22')}")` : '';
    u.media.classList.toggle('has-image', !!image);
    u.panel.classList.toggle('no-media', !image); // a project without an image gets a single column
    u.tags.replaceChildren(...(d.tags || []).map((t) => el('li', '', t)));
    u.tags.hidden = !(d.tags && d.tags.length);
    const links = [...(d.url ? [{ label: 'Website', url: d.url }] : []), ...(d.links || [])];
    u.links.replaceChildren(...links.map((l) => {
      const a = el('a', 'pf-link', l.label); a.href = l.url || '#';
      if (/^https?:/i.test(a.href) && a.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      return a;
    }));
    u.links.hidden = !links.length;
  }

  openPanel(point) {
    this._fill(point.data);
    this.ui.overlay.hidden = false;
    this.isOpen = true;
    this.ui.prompt.hidden = true;
    this.onOpen?.();
    this.ui.close.focus({ preventScroll: true });
  }

  closePanel() {
    if (!this.isOpen) return;
    this.ui.overlay.hidden = true;
    this.isOpen = false;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.onClose?.();
  }

  /** F pressed: closes the panel if open, opens the nearby project otherwise. */
  interact() {
    if (this.isOpen) { this.closePanel(); return true; }
    const pt = this.points.find((p) => p.data.id === this.nearId);
    if (pt) { this.openPanel(pt); return true; }
    return false;
  }

  /** Per frame. `player` {x, y, z}; `active` false hides the prompt (another mode is selected). */
  update(dt, elapsed, player, active) {
    let near = null;
    if (active && !this.isOpen) {
      for (const p of this.points) {
        if (Math.hypot(player.x - p.x, player.z - p.z) < 6 && Math.abs(player.y - p.y) < 10) { near = p; break; }
      }
    }
    const id = near ? near.data.id : null;
    if (id !== this.nearId) {
      this.nearId = id;
      this.ui.prompt.hidden = !near;
      if (near) this.ui.label.textContent = near.data.prompt || `View project: ${near.data.title}`;
    }
    for (const p of this.points) {
      const u = p.group.userData;
      const pulse = 1 + 0.06 * Math.sin(elapsed * 3);
      u.ring.scale.setScalar(pulse); u.ring2.scale.setScalar(1 + 0.1 * Math.sin(elapsed * 2 + 1));
      u.gem.rotation.y = elapsed * 1.6; u.gem.position.y = 3.2 + 0.25 * Math.sin(elapsed * 2.2);
      p.group.updateMatrixWorld(true);
    }
  }
}

export { PortfolioInteraction, loadContent };
