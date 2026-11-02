/** Preserve editing position across a lobby broadcast / ApplicationV2 render.
 * Store only plain values; never retain elements from a replaced template. */
export class ViewState {
  capture(root) {
    const view = root?.querySelector?.("[data-nfs-screen]");
    const screen = view?.dataset.nfsScreen;
    if (!screen) { this.saved = null; return; }
    const active = globalThis.document?.activeElement;
    const focus = root.contains?.(active) && active?.matches?.("input, select, textarea") && active.name
      ? { name: active.name, form: active.closest("form")?.dataset.form,
        choice: ["checkbox", "radio"].includes(active.type) ? active.value : null,
        checked: ["checkbox", "radio"].includes(active.type) ? active.checked : null,
        value: active.value,
        invalid: active.getAttribute?.("aria-invalid") ?? null,
        error: active.validity?.customError ? active.validationMessage : "",
        start: active.selectionStart, end: active.selectionEnd } : null;
    this.saved = { screen, scope: view.dataset.nfsScope, focus, scroll: root.querySelector(".nfs-view")?.scrollTop ?? 0,
      details: Object.fromEntries([...root.querySelectorAll("[data-nfs-disclosure]")]
        .map(element => [element.dataset.nfsDisclosure, element.open])) };
  }

  restore(root) {
    const saved = this.saved;
    const view = root.querySelector("[data-nfs-screen]");
    if (!saved || view?.dataset.nfsScreen !== saved.screen || view.dataset.nfsScope !== saved.scope) return;
    for (const element of root.querySelectorAll("[data-nfs-disclosure]")) {
      if (element.dataset.nfsDisclosure in saved.details) element.open = saved.details[element.dataset.nfsDisclosure];
    }
    if (saved.focus) {
      const { name, form, choice, checked, value, invalid, error, start, end } = saved.focus;
      const field = [...root.querySelectorAll("input, select, textarea")].find(element =>
        element.name === name && element.closest("form")?.dataset.form === form
        && (choice === null || element.value === choice));
      if (field && !field.disabled) {
        field.value = value;
        if (checked !== null) field.checked = checked;
        if (invalid !== null) field.setAttribute("aria-invalid", invalid);
        field.setCustomValidity?.(error);
        field.focus({ preventScroll: true });
        if (Number.isInteger(start) && Number.isInteger(end)) field.setSelectionRange?.(start, end);
      }
    }
    const scrollView = root.querySelector(".nfs-view");
    if (scrollView) scrollView.scrollTop = saved.scroll;
  }
}
