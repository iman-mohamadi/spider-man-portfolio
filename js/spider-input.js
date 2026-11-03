import { isTypingInField } from './city-config.js';

// Extra Spider-Man inputs. Movement and jump keys stay with the existing controller (controllerManager.keys: W A S D / Space); this
// tracks what that table does not have:
//   Shift       sprint on the ground
//   F           interact (portfolio)
//   Left mouse  web: press to shoot at the selected target, hold to swing, release to let go (momentum is kept)
//   Mouse move  look, through pointer lock (a click on the game captures the mouse, Esc frees it). If the browser refuses pointer lock,
//               clicks still shoot the web and a right-button drag looks.
//
// Web input state (read by SpiderController): `webHeld` follows the button; `consumeWebPress()` is true once per press. A press that
// only captures the mouse (first click) is not a web press, and clicks that land on UI (not on the canvas) never count.

const LOOK_SENS = { yaw: 0.0022, pitch: 0.002 };

class SpiderInput {
  /** @param {{ canvas: HTMLElement, isActive?: () => boolean }} opts isActive: true while Spider-Man owns the mouse (his mode + chase camera) */
  constructor({ canvas, isActive = () => true } = {}) {
    this.canvas = canvas;
    this.isActive = isActive;
    this.shift = false;
    this.webHeld = false;
    this.lockFailed = typeof canvas?.requestPointerLock !== 'function';
    this._noLockApi = this.lockFailed; // a browser without pointer lock stays in the fallback for good; a refused request does not (see requestLock)
    this._lockErrors = 0; this._lastTry = -1e9;
    this.paused = false;
    this._interact = false;
    this._webPress = false;
    this._lookX = 0;
    this._lookY = 0;
    const reset = () => { this.shift = false; this.webHeld = false; this._interact = false; this._webPress = false; };
    this.reset = reset;

    window.addEventListener('keydown', (e) => {
      if (isTypingInField(e)) return;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.shift = true;
      else if (e.code === 'KeyF' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) this._interact = true;
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.shift = false; });
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

    if (!canvas) return;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.isActive() || this.paused) return;
      if (!this.locked && !this.lockFailed) { this.requestLock(); return; } // the first click only captures the mouse
      if (!this.locked && !this._noLockApi && Date.now() - this._lastTry > 3000) this.requestLock(); // in the fallback: try the lock again now and then, it may work now
      this.webHeld = true; this._webPress = true;
    });
    // releases are caught anywhere (the pointer may have left the canvas while the button was held)
    const up = (e) => { if (e.button === 0) this.webHeld = false; };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', () => { this.webHeld = false; });
    canvas.addEventListener('contextmenu', (e) => { if (this.isActive()) e.preventDefault(); });
    document.addEventListener('pointerlockchange', () => { if (!this.locked) this.webHeld = false; else { this._lockErrors = 0; this.lockFailed = this._noLockApi; } }); // Esc / alt-tab: a held web is let go; a lock that worked clears the failure
    // a refused request (the browser wants a moment after Esc, or refused the raw-input option) is not permanent: only three in a row switch to the fallback
    document.addEventListener('pointerlockerror', () => { if (++this._lockErrors >= 3) this.lockFailed = true; });
    document.addEventListener('mousemove', (e) => {
      if (!this.isActive() || this.paused) return;
      if (this.locked || (e.buttons & 2)) { // locked: any movement looks; unlocked fallback: right-button drag
        this._lookX += e.movementX || 0; this._lookY += e.movementY || 0;
      }
    });
  }

  get locked() { return !!this.canvas && document.pointerLockElement === this.canvas; }

  /** Forgets earlier refusals: called when Spider-Man becomes the active character, so a bad moment in a previous session of the mode does not cost the mouse look for good. */
  rearm() { this._lockErrors = 0; this.lockFailed = this._noLockApi; }

  requestLock() {
    this._lastTry = Date.now();
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') p.catch(() => { try { this.canvas.requestPointerLock(); } catch { this.lockFailed = true; } });
    } catch { try { this.canvas.requestPointerLock(); } catch { this.lockFailed = true; } }
  }

  releaseLock() {
    this.webHeld = false;
    if (this.locked) document.exitPointerLock();
  }

  /** True once per F press. */
  consumeInteract() {
    const v = this._interact;
    this._interact = false;
    return v;
  }

  /** True once per left-button press that should shoot the web. */
  consumeWebPress() {
    const v = this._webPress;
    this._webPress = false;
    return v && !this.paused;
  }

  /** Accumulated mouse look since the last call, in radians: { yaw, pitch } (positive pitch looks down). */
  consumeLook(out = { yaw: 0, pitch: 0 }) {
    out.yaw = this._lookX ? -this._lookX * LOOK_SENS.yaw : 0;
    out.pitch = this._lookY ? this._lookY * LOOK_SENS.pitch : 0;
    this._lookX = this._lookY = 0;
    return out;
  }
}

export { SpiderInput, LOOK_SENS };
