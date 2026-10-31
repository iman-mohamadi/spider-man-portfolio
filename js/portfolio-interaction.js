import * as THREE from 'three/webgpu';

// Portfolio interaction points: a glowing marker in the city, a prompt when Spider-Man is near, and a project panel opened with F.
// This module owns ONLY the portfolio UI and markers; it knows nothing about movement. Content comes from content/portfolio.json.

const CONTENT_URL = new URL('../content/portfolio.json', import.meta.url).href;
const FALLBACK = { points: [{ id: 'project-1', title: 'Your Project Name', tagline: 'A one-line summary.', description: 'Content file could not be loaded.', image: null, imageAlt: '', tags: [], links: [], placement: { relativeTo: 'spawn', dx: 0, dz: 26 } }] };

async function loadContent() {
  try {
    const r = await fetch(CONTENT_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.points) || !data.points.length) throw new Error('no points');
    return data;
  } catch (e) {
    console.warn('[portfolio] using fallback content:', e.message);
    return FALLBACK;
  }
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

class PortfolioInteraction {
  /** @param spawn {x, z} where the placement offsets are measured from; ground(x, z) -> y */
  constructor({ scene, content, spawn, ground, onOpen, onClose }) {
    this.scene = scene;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.isOpen = false;
    this.nearId = null;
    this.points = content.points.map((p) => {
      const pl = p.placement || {};
      const x = spawn.x + (pl.dx || 0), z = spawn.z + (pl.dz || 0);
      return { data: p, x, z, y: ground(x, z), group: null };
    });
    for (const pt of this.points) pt.group = this._makeMarker(pt);
    this._buildUI();
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
    const title = el('h2', 'pf-title', ''); title.id = 'pf-title';
    const tagline = el('p', 'pf-tagline', ''); const desc = el('p', 'pf-desc', '');
    const tags = el('ul', 'pf-tags'); const links = el('div', 'pf-links');
    const hint = el('p', 'pf-hint', 'Press F or Esc to close');
    body.append(title, tagline, desc, tags, links, hint);
    panel.append(close, media, body);
    overlay.append(panel);
    document.body.append(prompt, overlay);
    Object.assign(this, { ui: { prompt, label, overlay, panel, close, media, mediaLabel, title, tagline, desc, tags, links } });
    close.addEventListener('click', () => this.closePanel());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.closePanel(); });
    window.addEventListener('keydown', (e) => { if (this.isOpen && e.code === 'Escape') { e.preventDefault(); this.closePanel(); } });
  }

  _fill(d) {
    const u = this.ui;
    u.title.textContent = d.title || '';
    u.tagline.textContent = d.tagline || '';
    u.desc.textContent = d.description || '';
    u.mediaLabel.textContent = d.imageAlt || 'Project screenshot';
    u.media.style.backgroundImage = d.image ? `url("${String(d.image).replace(/"/g, '%22')}")` : '';
    u.media.classList.toggle('has-image', !!d.image);
    u.tags.replaceChildren(...(d.tags || []).map((t) => el('li', '', t)));
    u.links.replaceChildren(...(d.links || []).map((l) => {
      const a = el('a', 'pf-link', l.label); a.href = l.url || '#';
      if (/^https?:/i.test(a.href) && a.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      return a;
    }));
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
      if (near) this.ui.label.textContent = `View project: ${near.data.title}`;
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
