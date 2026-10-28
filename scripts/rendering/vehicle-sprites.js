const SCALE = 2;
const WIDTH = 88, HEIGHT = 64;
const MAX_SPRITES = 36;
// Shared with the hot-core overlay: forward is +X, the exposed rear is -X.
export const REAR_CORE_X = -23;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const FRAMES = Object.freeze({
  arrow: { body: [[27, -5.5], [23, -7], [-9, -8], [-24, -4], [-24, 4], [-9, 8], [23, 7], [27, 5.5]], hood: 7, cockpit: 5.5, seats: 1, fenders: false },
  spider: { body: [[26, -7], [20, -8], [-12, -10], [-23, -7], [-23, 7], [-12, 10], [20, 8], [26, 7]], hood: 8, cockpit: 8, seats: 2, fenders: false },
  keel: { body: [[27, -5], [22, -6.5], [-8, -7], [-26, -2], [-28, 0], [-26, 2], [-8, 7], [22, 6.5], [27, 5]], hood: 6.5, cockpit: 5, seats: 1, fenders: false },
  bull: { body: [[27, -9], [19, -10], [-16, -10], [-24, -7], [-24, 7], [-16, 10], [19, 10], [27, 9]], hood: 9.5, cockpit: 8, seats: 2, fenders: false },
  turtle: { body: [[26, -7], [20, -9.5], [-15, -10.5], [-24, -6], [-26, 0], [-24, 6], [-15, 10.5], [20, 9.5], [26, 7]], hood: 9, cockpit: 8.5, seats: 2, fenders: true },
  allantry: { body: [[27, -6], [20, -8], [-14, -9], [-24, -5], [-24, 5], [-14, 9], [20, 8], [27, 6]], hood: 8, cockpit: 7, seats: 1, fenders: true }
});

/** Make one small transparent backing store; dimensions are in world units. */
function surface(width = WIDTH, height = HEIGHT) {
  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Canvas 2D недоступен для оформления болида");
  ctx.scale(SCALE, SCALE);
  ctx.translate(width * 0.5, height * 0.5);
  return { canvas, ctx };
}

/** Trace an immutable chassis silhouette into a sprite's local coordinate space. */
function polygon(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
}

/** Bounded per-race livery cache. Motion, heat and rank never rebuild body art. */
export class VehicleSprites {
  constructor() {
    this.bodies = new Map();
    this.hits = 0;
    this.generated = 0;
    this.halo = this.#halo();
    this.flame = this.#flame();
    this.hotCore = this.#core();
    this.frontWheel = this.#frontWheel();
  }

  #frontWheel() {
    const { canvas, ctx } = surface(18, 10);
    ctx.fillStyle = "#111716";
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#55594f"; ctx.fillRect(-5.5, -0.6, 11, 1.2);
    ctx.fillStyle = "#c7a76a"; ctx.fillRect(-1.5, -2.2, 3, 1.2);
    ctx.strokeStyle = "#92988a60"; ctx.lineWidth = 0.55; ctx.beginPath();
    for (const x of [-4, 0, 4]) { ctx.moveTo(x, -1.8); ctx.lineTo(x, 1.8); }
    ctx.stroke();
    return canvas;
  }

  /** Two shared rasters rotate with the actual steering rack, under the fenders.
   * Steering never enters the body cache key or creates a canvas in the frame. */
  drawSteeringWheels(ctx, car) {
    const sx = clamp(Number(car.appearance?.halfLength) || 26, 18, 36) / 28;
    const sy = clamp(Number(car.appearance?.halfWidth) || 14, 9, 22) / 16;
    const steer = clamp(Number(car.steeringPosition) || 0, -1, 1) * 0.5;
    for (let side = -1; side <= 1; side += 2) {
      ctx.save(); ctx.translate(17 * sx, side * 13.5 * sy);
      ctx.rotate(steer); ctx.scale(sx, side * sy);
      ctx.drawImage(this.frontWheel, -9, -5, 18, 10); ctx.restore();
    }
  }

  /** Rasterize the local-driver marker once, without a per-frame shadow filter. */
  #halo() {
    const { canvas, ctx } = surface(76, 56);
    const glow = ctx.createRadialGradient(0, 0, 12, 0, 0, 36);
    glow.addColorStop(0, "#f6d99a38"); glow.addColorStop(1, "#f6d99a00");
    ctx.fillStyle = glow; ctx.fillRect(-38, -28, 76, 56);
    ctx.strokeStyle = "#f6d99a65"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, 34, 23, 0, 0, Math.PI * 2); ctx.stroke();
    return canvas;
  }

  /** Bake an exhaust plume; the render loop only changes its destination length. */
  #flame() {
    const { canvas, ctx } = surface(64, 26);
    const plume = ctx.createLinearGradient(-32, 0, 32, 0);
    plume.addColorStop(0, "#6334c900"); plume.addColorStop(0.6, "#ad78f0a0"); plume.addColorStop(1, "#f2e4ffee");
    ctx.fillStyle = plume;
    polygon(ctx, [[32, -10], [-32, 0], [32, 10]]); ctx.fill();
    ctx.fillStyle = "#f4eaffe0";
    polygon(ctx, [[32, -4], [-10, 0], [32, 4]]); ctx.fill();
    return canvas;
  }

  /** A shared hot-core overlay keeps continuous heat out of the livery cache key. */
  #core() {
    const { canvas, ctx } = surface(18, 18);
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 9);
    glow.addColorStop(0, "#f5d9ffcc"); glow.addColorStop(0.5, "#c878f4a0"); glow.addColorStop(1, "#9645e800");
    ctx.fillStyle = glow; ctx.fillRect(-9, -9, 18, 18);
    ctx.strokeStyle = "#e3b0ffb0"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 4.8, 0, Math.PI * 2); ctx.stroke();
    return canvas;
  }

  /** Reuse paint for stable appearance and one of three damage states. */
  get(car) {
    const appearance = car.appearance ?? {};
    const frame = Object.hasOwn(FRAMES, appearance.frame) ? appearance.frame : "allantry";
    const color = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(car.color ?? "") ? car.color : "#8ea0ac";
    const length = clamp(Number(appearance.halfLength) || 26, 18, 36);
    const width = clamp(Number(appearance.halfWidth) || 14, 9, 22);
    const number = clamp(Math.floor(Number(appearance.number) || 1), 1, 12);
    const damage = car.disabled ? 2 : car.health < car.maxHealth * 0.25 ? 1 : 0;
    const key = `${frame}:${color}:${length}:${width}:${number}:${damage}`;
    const cached = this.bodies.get(key);
    if (cached) {
      this.hits++;
      this.bodies.delete(key); this.bodies.set(key, cached);
      return cached;
    }
    const sprite = this.#paint(frame, color, length, width, number, damage);
    this.bodies.set(key, sprite); this.generated++;
    if (this.bodies.size > MAX_SPRITES) {
      const first = this.bodies.keys().next().value;
      const old = this.bodies.get(first);
      old.width = 1; old.height = 1; this.bodies.delete(first);
    }
    return sprite;
  }

  /** Bake a period chassis: exposed narrow wheels, long bonnet, open leather
   * cockpit, brass radiator and a round violet crystal behind the rear seat.
   */
  #paint(frame, color, length, width, number, damage) {
    const { canvas, ctx } = surface();
    const shape = FRAMES[frame];
    const brass = damage === 2 ? "#7b7767" : "#c7a76a";
    ctx.scale(length / 28, width / 16);
    ctx.fillStyle = "#080f1590";
    ctx.beginPath(); ctx.ellipse(0, 3, 30, 17, 0, 0, Math.PI * 2); ctx.fill();
    // Exposed axles and thin, tall tyres read as early open-wheel racers.
    ctx.strokeStyle = "#393d39"; ctx.lineWidth = 1.5; ctx.beginPath();
    for (const x of [-16, 17]) { ctx.moveTo(x, -14); ctx.lineTo(x, 14); }
    ctx.stroke();
    for (const x of [-16]) for (const side of [-1, 1]) {
      const y = side * 13.5;
      ctx.fillStyle = "#111716";
      ctx.beginPath(); ctx.ellipse(x, y, 7, 2.7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#55594f"; ctx.fillRect(x - 5.5, y - 0.6, 11, 1.2);
      ctx.fillStyle = brass; ctx.fillRect(x - 1.5, y - side * 1.6 - 0.6, 3, 1.2);
      ctx.strokeStyle = "#92988a60"; ctx.lineWidth = 0.55; ctx.beginPath();
      for (const offset of [-4, 0, 4]) { ctx.moveTo(x + offset, y - 1.8); ctx.lineTo(x + offset, y + 1.8); }
      ctx.stroke();
    }
    if (shape.fenders) {
      for (const side of [-1, 1]) {
        ctx.strokeStyle = "#202b25"; ctx.lineWidth = 3.8; ctx.beginPath();
        ctx.moveTo(-16, side * 11); ctx.lineTo(17, side * 11); ctx.stroke();
        for (const x of [-16, 17]) {
          ctx.fillStyle = "#26342c";
          ctx.beginPath(); ctx.ellipse(x, side * 12, 8.3, 3.2, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = brass; ctx.lineWidth = 0.65; ctx.beginPath();
          ctx.moveTo(x - 6, side * 10.3); ctx.quadraticCurveTo(x, side * 8.8, x + 6, side * 10.3); ctx.stroke();
        }
      }
    }
    const metal = ctx.createLinearGradient(0, -11, 0, 11);
    metal.addColorStop(0, damage === 2 ? "#77756b" : "#e9ddbd");
    metal.addColorStop(0.16, damage === 2 ? "#444a4a" : color);
    metal.addColorStop(0.65, damage === 2 ? "#303832" : color);
    metal.addColorStop(1, "#282a20");
    polygon(ctx, shape.body);
    ctx.fillStyle = metal; ctx.fill(); ctx.strokeStyle = "#171e19"; ctx.lineWidth = 1.5; ctx.stroke();
    // Enamel cowl, bonnet hinge and two leather straps with small brass buckles.
    ctx.save(); ctx.clip();
    ctx.fillStyle = "#f5e8bd55"; ctx.fillRect(-2, -shape.hood + 1.3, 28, 0.7);
    ctx.fillStyle = "#33281e55"; ctx.fillRect(-2, 2.5, 30, shape.hood);
    ctx.strokeStyle = "#e5d7ae80"; ctx.lineWidth = 0.7; ctx.beginPath();
    ctx.moveTo(-1, 0); ctx.lineTo(24, 0); ctx.stroke();
    for (const x of [3, 18]) {
      ctx.fillStyle = "#483629c0"; ctx.fillRect(x, -shape.hood, 1.3, shape.hood * 2);
      ctx.strokeStyle = brass; ctx.lineWidth = 0.55; ctx.strokeRect(x - 0.4, -shape.hood + 0.7, 2, 1.7);
    }
    ctx.strokeStyle = "#27302980"; ctx.lineWidth = 0.75; ctx.beginPath();
    for (let x = 5; x < 17; x += 2.5) for (const side of [-1, 1]) {
      ctx.moveTo(x, side * shape.hood * 0.53); ctx.lineTo(x + 0.7, side * (shape.hood - 1.2));
    }
    ctx.stroke();
    ctx.restore();
    // Tall brass radiator, filler cap and two separate round headlamps.
    ctx.fillStyle = brass; ctx.fillRect(23, -shape.hood, 4, shape.hood * 2);
    ctx.fillStyle = "#2e352c"; ctx.fillRect(24.1, -shape.hood + 1, 1.6, shape.hood * 2 - 2);
    ctx.strokeStyle = "#e0c58e"; ctx.lineWidth = 0.45; ctx.beginPath();
    for (let y = -shape.hood + 2; y < shape.hood; y += 2) { ctx.moveTo(24, y); ctx.lineTo(26, y); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(21.3, 0, 1.3, 0, Math.PI * 2); ctx.fillStyle = brass; ctx.fill();
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.arc(21, side * (shape.hood + 1.3), 2.1, 0, Math.PI * 2);
      ctx.fillStyle = brass; ctx.fill();
      ctx.beginPath(); ctx.arc(21.6, side * (shape.hood + 1.3), 1.2, 0, Math.PI * 2);
      ctx.fillStyle = damage === 2 ? "#85816b" : "#f1e7bd"; ctx.fill();
    }
    // An external copper exhaust and an ivory racing roundel on the long hood.
    ctx.strokeStyle = damage === 2 ? "#686458" : "#ac8962"; ctx.lineWidth = 1.6; ctx.beginPath();
    ctx.moveTo(13, -shape.hood - 0.8); ctx.lineTo(8, -11); ctx.lineTo(-18, -11); ctx.stroke();
    ctx.beginPath(); ctx.arc(10.5, 0, 4.7, 0, Math.PI * 2); ctx.fillStyle = "#e8dfbf"; ctx.fill();
    ctx.font = "bold 6.8px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#2c3228"; ctx.fillText(String(number).padStart(2, "0"), 10.5, 0.4);
    // Open cockpit: leather seats, visible helmet/goggles and thin steering wheel.
    ctx.beginPath(); ctx.ellipse(-7.8, 0, 8.2, shape.cockpit, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#22271f"; ctx.fill(); ctx.strokeStyle = brass; ctx.lineWidth = 0.9; ctx.stroke();
    for (const y of shape.seats === 2 ? [-3.5, 3.5] : [0]) {
      ctx.beginPath(); ctx.ellipse(-10, y, 4.6, 2.7, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#7b4f32"; ctx.fill();
      ctx.strokeStyle = "#c29c66"; ctx.lineWidth = 0.5; ctx.beginPath();
      ctx.moveTo(-12, y - 1.7); ctx.lineTo(-12, y + 1.7); ctx.stroke();
      ctx.beginPath(); ctx.arc(-2.9, y, 2.2, 0, Math.PI * 2);
      ctx.strokeStyle = "#93876c"; ctx.lineWidth = 0.65; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-7.5, y, 3.5, 2.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#504332"; ctx.fill();
      ctx.beginPath(); ctx.arc(-6.8, y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = damage === 2 ? "#9e9987" : "#e6d8b2"; ctx.fill();
      ctx.strokeStyle = "#423e30"; ctx.lineWidth = 0.7; ctx.beginPath();
      ctx.moveTo(-5.8, y - 1.35); ctx.lineTo(-5.8, y + 1.35); ctx.stroke();
    }
    ctx.strokeStyle = "#bed3bda0"; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(-0.7, -shape.cockpit); ctx.quadraticCurveTo(1.6, 0, -0.7, shape.cockpit); ctx.stroke();
    this.#rearCrystal(ctx, brass, damage, (length / 28) / (width / 16));
    if (damage) {
      ctx.strokeStyle = "#30281fb0"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(4, -6); ctx.lineTo(7, -3); ctx.lineTo(5, -1); ctx.stroke();
      ctx.fillStyle = "#44332670"; ctx.fillRect(16, 4, 6, 2);
    }
    return canvas;
  }

  /** Paint a round violet crystal protruding from a brass cradle at the rear.
   * Its circular rim stays readable; even the disabled state retains violet.
   */
  #rearCrystal(ctx, brass, damage, axisRatio) {
    ctx.fillStyle = "#272a22"; ctx.fillRect(REAR_CORE_X - 2, -6, 10, 12);
    ctx.strokeStyle = brass; ctx.lineWidth = 1.3; ctx.beginPath();
    ctx.moveTo(REAR_CORE_X - 2, -6); ctx.lineTo(-15, -6);
    ctx.moveTo(REAR_CORE_X - 2, 6); ctx.lineTo(-15, 6); ctx.stroke();
    // Chassis proportions may stretch independently; the orb must stay round.
    ctx.save(); ctx.translate(REAR_CORE_X, 0); ctx.scale(1, axisRatio);
    ctx.beginPath(); ctx.arc(0, 0, 6.1, 0, Math.PI * 2);
    ctx.fillStyle = brass; ctx.fill();
    const crystal = ctx.createRadialGradient(-2, -2, 0.5, 0, 0, 5.4);
    crystal.addColorStop(0, damage === 2 ? "#bda2cd" : "#f3dcff");
    crystal.addColorStop(0.35, damage === 2 ? "#815a99" : "#bc80ee");
    crystal.addColorStop(0.78, damage === 2 ? "#563762" : "#8040bf");
    crystal.addColorStop(1, "#40224f");
    ctx.beginPath(); ctx.arc(0, 0, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = crystal; ctx.fill();
    ctx.strokeStyle = "#edc6ff65"; ctx.lineWidth = 0.6; ctx.beginPath();
    ctx.arc(0, 0, 3.8, Math.PI * 1.08, Math.PI * 1.62); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-1.7, -2, 1.7, 0.85, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = "#f9edffb0"; ctx.fill();
    ctx.restore();
  }

  /** Release every GPU backing store when its race ends. */
  destroy() {
    for (const canvas of [...this.bodies.values(), this.halo, this.flame, this.hotCore, this.frontWheel]) {
      canvas.width = 1; canvas.height = 1;
    }
    this.bodies.clear();
  }
}
