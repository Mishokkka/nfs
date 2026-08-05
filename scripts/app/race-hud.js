// @ts-check

/**
 * The live race HUD is painted inside the race canvas by RaceRenderer.
 * Keeping rapidly changing time, speed and meter values out of Foundry's DOM
 * avoids a full application style/layout/composite pass every few hundred ms.
 * This controller now only manages discrete pit-overlay transitions.
 */
export class RaceHud {
  constructor({ pitUi }) {
    this.pitUi = pitUi;
    this.stage = null;
    this.pitSignature = "";
    this.updateCount = 0;
  }

  mount(root) {
    this.stage = root?.querySelector?.(".nfs-race-stage") ?? null;
    this.stage?.classList?.add?.("nfs-canvas-hud");
    this.pitSignature = "";
    this.updateCount = 0;
  }

  destroy() {
    this.stage?.classList?.remove?.("nfs-canvas-hud");
    this.stage = null;
    this.pitSignature = "";
    this.updateCount = 0;
  }

  update(car, snapshot) {
    if (!car || !snapshot) return;
    this.updateCount += 1;
    const pitSignature = `${car.pitState ?? "track"}:${car.pitAttemptId ?? ""}:${car.pitStopsCompleted ?? 0}:${car.pitWord ?? ""}`;
    if (pitSignature === this.pitSignature) return;
    this.pitSignature = pitSignature;
    this.pitUi.update(car);
  }

  getDiagnosticStats() {
    return {
      mode: "canvas",
      updateIntervalMs: 0,
      pending: false,
      updateCount: this.updateCount,
      domWrites: 0
    };
  }
}
