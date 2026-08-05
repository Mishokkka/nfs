// @ts-check

const TOOLTIP_SELECTOR = "[data-nfs-tooltip]";
const TOOLTIP_ID = "fbl-nfs-floating-tooltip";

/**
 * A single tooltip portal for the whole application.
 *
 * Foundry treats `data-tooltip` as its own tooltip trigger. The garage used the
 * same attribute for a CSS pseudo-element, so both tooltips appeared and the
 * pseudo-element remained trapped below neighbouring ApplicationV2 layers.
 * This controller uses a module-specific attribute and renders one fixed layer
 * directly under document.body, outside every window stacking context.
 */
export class TooltipController {
  constructor() {
    this.root = null;
    this.element = null;
    this.currentTarget = null;
    this.abortController = null;
    this.positionFrame = null;
  }

  mount(root) {
    this.destroy();
    if (!(root instanceof HTMLElement)) return;
    this.root = root;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.#ensureElement();

    root.addEventListener("pointerover", this.#onEnter, { signal });
    root.addEventListener("pointerout", this.#onLeave, { signal });
    root.addEventListener("focusin", this.#onEnter, { signal });
    root.addEventListener("focusout", this.#onLeave, { signal });
    root.addEventListener("keydown", this.#onKeyDown, { signal });
    window.addEventListener("resize", this.#schedulePosition, { signal });
    window.addEventListener("scroll", this.#schedulePosition, { capture: true, passive: true, signal });
  }

  destroy({ removeElement = false } = {}) {
    this.abortController?.abort();
    this.abortController = null;
    if (this.positionFrame != null) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = null;
    this.#hide();
    this.root = null;
    if (removeElement && this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  #ensureElement() {
    let element = document.getElementById(TOOLTIP_ID);
    if (!(element instanceof HTMLElement)) {
      element = document.createElement("div");
      element.id = TOOLTIP_ID;
      element.className = "nfs-floating-tooltip";
      element.setAttribute("role", "tooltip");
      element.hidden = true;
      document.body.append(element);
    }
    this.element = element;
  }

  #targetFrom(node) {
    const target = node instanceof Element ? node.closest(TOOLTIP_SELECTOR) : null;
    return target instanceof HTMLElement && this.root?.contains(target) ? target : null;
  }

  #show(target) {
    const text = String(target.dataset.nfsTooltip ?? "").trim();
    if (!text || !this.element) return this.#hide();
    if (this.currentTarget && this.currentTarget !== target) this.#unlinkTarget(this.currentTarget);
    this.currentTarget = target;
    this.element.textContent = text;
    this.element.hidden = false;
    this.element.dataset.visible = "true";
    const describedBy = new Set(String(target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    describedBy.add(TOOLTIP_ID);
    target.setAttribute("aria-describedby", [...describedBy].join(" "));
    this.#schedulePosition();
  }

  #hide() {
    if (this.currentTarget) this.#unlinkTarget(this.currentTarget);
    this.currentTarget = null;
    if (!this.element) return;
    this.element.hidden = true;
    delete this.element.dataset.visible;
    this.element.style.removeProperty("left");
    this.element.style.removeProperty("top");
  }

  #unlinkTarget(target) {
    const ids = String(target.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((id) => id && id !== TOOLTIP_ID);
    if (ids.length) target.setAttribute("aria-describedby", ids.join(" "));
    else target.removeAttribute("aria-describedby");
  }

  #schedulePosition = () => {
    if (!this.currentTarget || !this.element || this.element.hidden || this.positionFrame != null) return;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      this.#position();
    });
  };

  #position() {
    const target = this.currentTarget;
    const tooltip = this.element;
    if (!target?.isConnected || !tooltip || tooltip.hidden) return this.#hide();
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const left = Math.min(
      viewportWidth - tooltipRect.width - margin,
      Math.max(margin, targetRect.left + targetRect.width * 0.5 - tooltipRect.width * 0.5)
    );
    const fitsAbove = targetRect.top >= tooltipRect.height + gap + margin;
    const top = fitsAbove
      ? targetRect.top - tooltipRect.height - gap
      : Math.min(viewportHeight - tooltipRect.height - margin, targetRect.bottom + gap);
    tooltip.style.left = `${Math.round(Math.max(margin, left))}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  #onEnter = (event) => {
    const target = this.#targetFrom(event.target);
    if (target) this.#show(target);
  };

  #onLeave = (event) => {
    if (!this.currentTarget) return;
    const related = event.relatedTarget;
    if (related instanceof Node && this.currentTarget.contains(related)) return;
    const next = this.#targetFrom(related);
    if (next) this.#show(next);
    else this.#hide();
  };

  #onKeyDown = (event) => {
    if (event.key === "Escape") this.#hide();
  };
}
