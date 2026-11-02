/** Presentation-only slip warning. Hysteresis filters single contact impulses;
 * this aggregate tyre model cannot truthfully distinguish front/rear axle slip. */
export class GripFeedback {
  constructor() {
    this.carId = null;
    this.slippingSince = null;
    this.visibleUntil = 0;
    this.lastAt = 0;
  }

  update(car, now) {
    if (car.id !== this.carId || now - this.lastAt > 300) {
      this.carId = car.id;
      this.slippingSince = null;
      this.visibleUntil = 0;
    }
    this.lastAt = now;
    const angle = Number(car.angle) || 0, vx = Number(car.vx) || 0, vy = Number(car.vy) || 0;
    const forward = vx * Math.cos(angle) + vy * Math.sin(angle);
    const lateral = -vx * Math.sin(angle) + vy * Math.cos(angle);
    const slip = Math.abs(Math.atan2(lateral, Math.max(22, Math.abs(forward)))) * 180 / Math.PI;
    const speedKmh = Math.hypot(vx, vy) * (0.62 / 3);
    if (speedKmh > 70 && Number(car.driftAmount) > 0.18 && slip >= 14) {
      return slip >= 34 ? "Срыв заноса: контррулите и отпустите газ" : `Управляемый занос · ${Math.round(slip)}°`;
    }
    if (speedKmh >= 35 && forward > 0 && slip >= 12) {
      this.slippingSince ??= now;
      if (now - this.slippingSince >= 120) this.visibleUntil = now + 300;
    } else if (slip < 7 || speedKmh < 30 || forward <= 0) {
      this.slippingSince = null;
    }
    if (speedKmh < 30 || forward <= 0) this.visibleUntil = 0;
    return now < this.visibleUntil ? "Снос · плавно отпустите газ и уменьшите поворот руля" : "";
  }
}
