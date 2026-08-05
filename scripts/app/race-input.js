// @ts-check

import { INPUT_KEEPALIVE_MS } from "../constants.js";
import { neutralInput } from "../physics.js";

const HANDLED_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "KeyC", "KeyM", "Digit1", "Digit2"
]);

function sameInput(a, b) {
  return Boolean(a && b)
    && a.throttle === b.throttle
    && a.steer === b.steer
    && a.brake === b.brake
    && a.reverse === b.reverse
    && a.boost === b.boost
    && a.ram === b.ram
    && a.drift === b.drift;
}

export class RaceInput {
  constructor({ getLocalCarId, getSnapshot, isRaceActive, onInput, onCameraMode, onToggleCamera, onToggleMinimap, onVisibilityChange }) {
    this.getLocalCarId = getLocalCarId;
    this.getSnapshot = getSnapshot;
    this.isRaceActive = isRaceActive;
    this.onInput = onInput;
    this.onCameraMode = onCameraMode;
    this.onToggleCamera = onToggleCamera;
    this.onToggleMinimap = onToggleMinimap;
    this.onVisibilityChange = onVisibilityChange;
    this.keys = new Set();
    this.target = null;
    this.focusNotice = null;
    this.abortController = null;
    this.lastPayload = null;
    this.lastKeepaliveAt = 0;
    this.sequence = 0;
    this.restoreFrame = null;
    this.restoreTimer = null;
    this.restoreToken = 0;
  }

  mount(canvas, root) {
    this.destroyListeners();
    this.target = canvas;
    this.focusNotice = root?.querySelector("[data-race-focus]") ?? null;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    window.addEventListener("keydown", this.#onKeyDown, { capture: true, passive: false, signal });
    window.addEventListener("keyup", this.#onKeyUp, { capture: true, passive: false, signal });
    window.addEventListener("blur", this.#onWindowBlur, { signal });
    document.addEventListener("visibilitychange", this.#onDocumentVisibility, { signal });
    canvas.addEventListener("pointerdown", this.#focusCanvas, { signal });
    canvas.addEventListener("focus", this.#onFocus, { signal });
    canvas.addEventListener("blur", this.#onBlur, { signal });
    this.focusNotice?.addEventListener("pointerdown", this.#focusCanvas, { signal });
    this.focusNotice?.addEventListener("keydown", this.#onFocusNoticeKey, { signal });
    this.#syncFocusNotice();
  }

  destroyListeners() {
    this.abortController?.abort();
    this.#cancelPendingRestore();
    this.abortController = null;
    this.target = null;
    this.focusNotice = null;
    this.keys.clear();
  }

  reset() {
    this.destroyListeners();
    this.lastPayload = null;
    this.lastKeepaliveAt = 0;
    this.sequence = 0;
  }

  current() {
    const localCarId = this.getLocalCarId();
    if (!localCarId) return neutralInput();
    const local = this.getSnapshot()?.cars?.find((car) => car.id === localCarId);
    if (local?.pitState === "service") return neutralInput();
    const forward = this.keys.has("KeyW") || this.keys.has("ArrowUp");
    const backward = this.keys.has("KeyS") || this.keys.has("ArrowDown");
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    return {
      throttle: forward ? 1 : 0,
      steer: left ? -1 : right ? 1 : 0,
      brake: false,
      reverse: backward,
      boost: this.keys.has("Space"),
      ram: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      drift: this.keys.has("ControlLeft") || this.keys.has("ControlRight")
    };
  }

  dispatch(input = this.current(), { force = false } = {}) {
    if (!this.getLocalCarId()) return false;
    const now = performance.now();
    const changed = !sameInput(input, this.lastPayload);
    if (!force && !changed && now - this.lastKeepaliveAt < INPUT_KEEPALIVE_MS) return false;
    const payload = { ...input };
    this.sequence += 1;
    this.onInput(payload, this.sequence);
    this.lastPayload = payload;
    this.lastKeepaliveAt = now;
    return true;
  }

  neutralize() {
    this.keys.clear();
    return this.dispatch(neutralInput(), { force: true });
  }

  focus() {
    const target = this.target;
    if (!target?.isConnected) return;
    target.focus({ preventScroll: true });
    this.#syncFocusNotice();
  }

  restoreFocus() {
    this.keys.clear();
    this.#cancelPendingRestore();
    const token = this.restoreToken;
    const focus = () => {
      if (token !== this.restoreToken) return;
      if (this.isRaceActive() && this.target?.isConnected) this.focus();
    };
    focus();
    queueMicrotask(focus);
    this.restoreFrame = requestAnimationFrame(() => { this.restoreFrame = null; focus(); });
    this.restoreTimer = window.setTimeout(() => { this.restoreTimer = null; focus(); }, 80);
  }

  #cancelPendingRestore() {
    this.restoreToken += 1;
    if (this.restoreFrame != null) cancelAnimationFrame(this.restoreFrame);
    if (this.restoreTimer != null) window.clearTimeout(this.restoreTimer);
    this.restoreFrame = null;
    this.restoreTimer = null;
  }

  #consume(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  #onKeyDown = (event) => {
    if (!this.isRaceActive() || document.activeElement !== this.target || !HANDLED_KEYS.has(event.code)) return;
    this.#consume(event);
    if (event.repeat) return;
    if (event.code === "KeyC") return void this.onToggleCamera();
    if (event.code === "KeyM") return void this.onToggleMinimap();
    if (event.code === "Digit1") return void this.onCameraMode("overview");
    if (event.code === "Digit2") return void this.onCameraMode("chase");
    this.keys.add(event.code);
    this.dispatch(this.current(), { force: true });
  };

  #onKeyUp = (event) => {
    if (!this.isRaceActive() || document.activeElement !== this.target || !HANDLED_KEYS.has(event.code)) return;
    this.#consume(event);
    this.keys.delete(event.code);
    this.dispatch(this.current(), { force: true });
  };

  #focusCanvas = () => this.focus();

  #onWindowBlur = () => {
    if (!this.isRaceActive()) return;
    this.neutralize();
    this.#syncFocusNotice();
  };

  #onDocumentVisibility = () => {
    if (!this.isRaceActive()) return;
    if (document.hidden) this.neutralize();
    this.onVisibilityChange(Boolean(document.hidden));
    this.#syncFocusNotice();
  };

  #onFocusNoticeKey = (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    this.focus();
  };

  #onFocus = () => this.#syncFocusNotice();
  #onBlur = () => {
    if (this.isRaceActive()) this.neutralize();
    this.#syncFocusNotice();
  };

  #syncFocusNotice() {
    if (!this.focusNotice) return;
    const lost = this.isRaceActive() && document.activeElement !== this.target;
    this.focusNotice.classList.toggle("is-visible", lost);
    this.focusNotice.setAttribute("aria-hidden", String(!lost));
    this.focusNotice.setAttribute("tabindex", lost ? "0" : "-1");
  }
}
