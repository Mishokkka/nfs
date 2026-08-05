// @ts-check

const PIT_CONFIRMATION_TIMEOUT_MS = 2500;

export class PitUi {
  constructor({ onComplete, onRestoreFocus }) {
    this.onComplete = onComplete;
    this.onRestoreFocus = onRestoreFocus;
    this.elements = null;
    this.attemptSeen = null;
    this.typingErrors = 0;
    this.abortController = null;
    this.errorTimer = null;
    this.confirmationTimer = null;
  }

  mount(root) {
    this.destroy();
    this.elements = {
      overlay: root?.querySelector("[data-pit-overlay]"),
      word: root?.querySelector("[data-pit-word]"),
      input: root?.querySelector("[data-pit-input]"),
      errors: root?.querySelector("[data-pit-errors]"),
      count: root?.querySelector("[data-pit-count]")
    };
    this.abortController = new AbortController();
    this.elements.input?.addEventListener("input", this.#onInput, { signal: this.abortController.signal });
  }

  destroy() {
    this.abortController?.abort();
    if (this.errorTimer != null) window.clearTimeout(this.errorTimer);
    if (this.confirmationTimer != null) window.clearTimeout(this.confirmationTimer);
    this.errorTimer = null;
    this.confirmationTimer = null;
    this.abortController = null;
    this.elements = null;
    this.attemptSeen = null;
    this.typingErrors = 0;
  }

  update(car) {
    const pit = this.elements;
    if (!pit?.overlay) return;
    const active = car.pitState === "service" && Boolean(car.pitWord);
    pit.overlay.hidden = !active;
    if (!active) {
      const hadAttempt = this.attemptSeen != null;
      this.#clearConfirmationTimer();
      if (this.errorTimer != null) window.clearTimeout(this.errorTimer);
      this.errorTimer = null;
      this.attemptSeen = null;
      this.typingErrors = 0;
      pit.overlay.classList.remove("is-error", "is-complete");
      pit.overlay.setAttribute("aria-busy", "false");
      if (pit.input) {
        pit.input.value = "";
        pit.input.disabled = false;
      }
      if (pit.errors) pit.errors.textContent = "Введите слово без единой ошибки.";
      if (hadAttempt) this.onRestoreFocus();
      return;
    }

    if (this.attemptSeen !== car.pitAttemptId) {
      this.#clearConfirmationTimer();
      if (this.errorTimer != null) window.clearTimeout(this.errorTimer);
      this.errorTimer = null;
      this.attemptSeen = car.pitAttemptId;
      this.typingErrors = 0;
      if (pit.word) pit.word.textContent = car.pitWord;
      if (pit.input) {
        pit.input.value = "";
        pit.input.disabled = false;
        queueMicrotask(() => pit.input?.focus({ preventScroll: true }));
      }
      pit.overlay.classList.remove("is-error", "is-complete");
      pit.overlay.setAttribute("aria-busy", "false");
    }
    if (pit.count) pit.count.textContent = `${car.pitStopsCompleted} / ${car.pitStopsRequired}`;
    if (pit.errors && !pit.input?.disabled) {
      pit.errors.textContent = this.typingErrors ? `Ошибок: ${this.typingErrors}. Слово начато заново.` : "Введите слово без единой ошибки.";
    }
  }

  #onInput = (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const word = this.elements?.word?.textContent ?? "";
    const value = input.value.normalize("NFC");
    const target = word.normalize("NFC");
    if (!target.startsWith(value)) {
      this.typingErrors += 1;
      input.value = "";
      this.elements?.overlay?.classList.add("is-error");
      if (this.errorTimer != null) window.clearTimeout(this.errorTimer);
      this.errorTimer = window.setTimeout(() => {
        this.errorTimer = null;
        this.elements?.overlay?.classList.remove("is-error");
      }, 180);
      if (this.elements?.errors) this.elements.errors.textContent = `Ошибок: ${this.typingErrors}. Слово начато заново.`;
      return;
    }
    if (value !== target) return;
    const attemptId = this.attemptSeen;
    if (this.errorTimer != null) window.clearTimeout(this.errorTimer);
    this.errorTimer = null;
    input.disabled = true;
    this.elements?.overlay?.classList.remove("is-error");
    this.elements?.overlay?.classList.add("is-complete");
    this.elements?.overlay?.setAttribute("aria-busy", "true");
    if (this.elements?.errors) this.elements.errors.textContent = "Подтверждение обслуживания…";
    this.#clearConfirmationTimer();
    this.confirmationTimer = window.setTimeout(() => {
      this.confirmationTimer = null;
      const pit = this.elements;
      if (!pit?.overlay || pit.overlay.hidden || this.attemptSeen !== attemptId || !pit.input?.disabled) return;
      pit.input.disabled = false;
      pit.input.value = "";
      pit.overlay.classList.remove("is-complete");
      pit.overlay.setAttribute("aria-busy", "false");
      if (pit.errors) pit.errors.textContent = "Подтверждение не получено. Повторите ввод.";
      pit.input.focus({ preventScroll: true });
    }, PIT_CONFIRMATION_TIMEOUT_MS);
    this.onComplete(target, attemptId);
  };

  #clearConfirmationTimer() {
    if (this.confirmationTimer != null) window.clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }
}
