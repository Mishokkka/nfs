/** Preserve editing position across a lobby broadcast / ApplicationV2 render.
 * Store only plain values; never retain elements from a replaced template. */
export class ViewState {
  capture(root) {
    const screen = root?.querySelector?.("[data-nfs-screen]")?.dataset.nfsScreen;
    if (!screen) return;
    const active = globalThis.document?.activeElement;
    const focus = root.contains?.(active) && active?.matches?.("input, select, textarea") && active.name
      ? { name: active.name, form: active.closest("form")?.dataset.form,
        value: active.type === "checkbox" ? active.value : null,
        start: active.selectionStart, end: active.selectionEnd } : null;
    this.saved = { screen, focus, scroll: root.querySelector(".nfs-view")?.scrollTop ?? 0,
      details: Object.fromEntries([...root.querySelectorAll("[data-nfs-disclosure]")]
        .map(element => [element.dataset.nfsDisclosure, element.open])) };
  }

  restore(root) {
    const saved = this.saved;
    if (!saved || root.querySelector("[data-nfs-screen]")?.dataset.nfsScreen !== saved.screen) return;
    for (const element of root.querySelectorAll("[data-nfs-disclosure]")) {
      if (element.dataset.nfsDisclosure in saved.details) element.open = saved.details[element.dataset.nfsDisclosure];
    }
    if (saved.focus) {
      const { name, form, value, start, end } = saved.focus;
      const field = [...root.querySelectorAll("input, select, textarea")].find(element =>
        element.name === name && element.closest("form")?.dataset.form === form
        && (value === null || element.value === value));
      if (field && !field.disabled) {
        field.focus({ preventScroll: true });
        if (Number.isInteger(start) && Number.isInteger(end)) field.setSelectionRange?.(start, end);
      }
    }
    const view = root.querySelector(".nfs-view");
    if (view) view.scrollTop = saved.scroll;
  }
}
