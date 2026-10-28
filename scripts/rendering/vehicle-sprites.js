const SCALE = 2;
const WIDTH = 88, HEIGHT = 64;
const MAX_SPRITES = 36;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const FRAMES = Object.freeze({
  arrow: [[28, 0], [10, -9], [-18, -11], [-25, -6], [-25, 6], [-18, 11], [10, 9]],
  spider: [[23, -7], [13, -13], [-16, -13], [-22, -7], [-22, 7], [-16, 13], [13, 13], [23, 7]],
  keel: [[28, 0], [17, -9], [-24, -10], [-28, -5], [-28, 5], [-24, 10], [17, 9]],
  bull: [[24, -11], [17, -15], [-20, -14], [-25, -8], [-25, 8], [-20, 14], [17, 15], [24, 11]],
  turtle: [[25, -6], [18, -15], [-16, -16], [-25, -10], [-27, 0], [-25, 10], [-16, 16], [18, 15], [25, 6]],
  allantry: [[27, 0], [16, -11], [-18, -12], [-25, -7], [-25, 7], [-18, 12], [16, 11]]
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
    plume.addColorStop(0, "#338fc900"); plume.addColorStop(0.6, "#41cdeda0"); plume.addColorStop(1, "#defaffee");
    ctx.fillStyle = plume;
    polygon(ctx, [[32, -10], [-32, 0], [32, 10]]); ctx.fill();
    ctx.fillStyle = "#e9ffffe0";
    polygon(ctx, [[32, -4], [-10, 0], [32, 4]]); ctx.fill();
    return canvas;
  }

  /** A shared hot-core overlay keeps continuous heat out of the livery cache key. */
  #core() {
    const { canvas, ctx } = surface(18, 18);
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 9);
    glow.addColorStop(0, "#fff1baff"); glow.addColorStop(0.4, "#ff9c4fdd"); glow.addColorStop(1, "#f35a3000");
    ctx.fillStyle = glow; ctx.fillRect(-9, -9, 18, 18);
    polygon(ctx, [[0, -5], [4, 0], [0, 5], [-4, 0]]); ctx.fillStyle = "#fff2cb"; ctx.fill();
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

  /** Layer wheels, metal facets, cockpit and crystal inside a fixed-size sprite. */
  #paint(frame, color, length, width, number, damage) {
    const { canvas, ctx } = surface();
    ctx.scale(length / 28, width / 16);
    ctx.fillStyle = "#080f1590";
    ctx.beginPath(); ctx.ellipse(1, 4, 29, 18, 0, 0, Math.PI * 2); ctx.fill();
    // Four exposed tyres with steel hubs, kept within the physical footprint.
    for (const x of [-15, 13]) for (const y of [-14, 10]) {
      ctx.fillStyle = "#10171c"; ctx.fillRect(x - 5, y - 3, 11, 7);
      ctx.fillStyle = "#697c86"; ctx.fillRect(x - 3, y - 1, 7, 3);
      ctx.fillStyle = "#b9c7cc90"; ctx.fillRect(x - 2, y - 2, 5, 1);
    }
    const metal = ctx.createLinearGradient(0, -16, 0, 16);
    metal.addColorStop(0, damage === 2 ? "#676c6a" : "#dce8e6");
    metal.addColorStop(0.16, damage === 2 ? "#444a4a" : color);
    metal.addColorStop(0.62, damage === 2 ? "#30383c" : color);
    metal.addColorStop(1, "#16232b");
    polygon(ctx, FRAMES[frame]);
    ctx.fillStyle = metal; ctx.fill(); ctx.strokeStyle = "#0d1921"; ctx.lineWidth = 1.8; ctx.stroke();
    // Recessed lower panel and narrow ivory livery stripe retain volume at zoom.
    ctx.save(); ctx.clip();
    ctx.fillStyle = "#0b182a48"; ctx.fillRect(-28, 4, 58, 13);
    ctx.fillStyle = "#ecf5eaa8"; ctx.fillRect(-22, -9, 44, 2);
    ctx.fillStyle = "#11222d75"; ctx.fillRect(-22, 8, 40, 2);
    ctx.restore();
    if (frame === "bull" || frame === "turtle") {
      ctx.fillStyle = "#a0b1b4"; ctx.fillRect(20, -11, 3, 22);
      ctx.strokeStyle = "#dae3dc70"; ctx.lineWidth = 1;
      for (const x of [-19, 5, 15]) { ctx.beginPath(); ctx.moveTo(x, -11); ctx.lineTo(x, 11); ctx.stroke(); }
    } else {
      ctx.fillStyle = "#1b303a"; ctx.fillRect(-25, -13, 4, 26);
      ctx.fillStyle = "#d3e2ddaf"; ctx.fillRect(-26, -12, 1, 24);
    }
    // Dark glass and its reflected highlight distinguish the pilot from the core.
    polygon(ctx, [[5, -6], [-6, -7], [-10, -4], [-10, 4], [-6, 7], [5, 6]]);
    ctx.fillStyle = "#162e3b"; ctx.fill(); ctx.strokeStyle = "#aacbd3a0"; ctx.lineWidth = 1; ctx.stroke();
    polygon(ctx, [[3, -5], [-5, -5], [-8, -3], [1, -2]]); ctx.fillStyle = "#7baab8b0"; ctx.fill();
    // Crystal power unit in a brass socket, not a featureless central dot.
    ctx.fillStyle = "#27313a"; ctx.fillRect(-20, -6, 10, 12);
    ctx.strokeStyle = "#c3ae6e"; ctx.lineWidth = 1; ctx.strokeRect(-20, -6, 10, 12);
    polygon(ctx, [[-15, -5], [-11, 0], [-15, 5], [-19, 0]]);
    ctx.fillStyle = damage === 2 ? "#627777" : "#76e0ec"; ctx.fill();
    polygon(ctx, [[-15, -4], [-12, 0], [-15, 2]]); ctx.fillStyle = damage === 2 ? "#96a29c" : "#e0ffff"; ctx.fill();
    ctx.fillStyle = "#ecede0"; ctx.fillRect(9, -5, 11, 10);
    ctx.font = "bold 8px Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#1b2931"; ctx.fillText(String(number).padStart(2, "0"), 14.5, 0.5);
    ctx.fillStyle = damage === 2 ? "#66736f" : "#f3ebc5";
    ctx.fillRect(22, -7, 3, 3); ctx.fillRect(22, 4, 3, 3);
    ctx.fillStyle = damage === 2 ? "#494c4a" : "#df7860";
    ctx.fillRect(-24, -8, 2, 4); ctx.fillRect(-24, 4, 2, 4);
    if (damage) {
      ctx.strokeStyle = "#152024b0"; ctx.lineWidth = 1.5;
      polygon(ctx, [[-4, -6], [0, -2], [-3, 1], [2, 6]]); ctx.stroke();
      ctx.fillStyle = "#362c2860"; ctx.fillRect(15, 5, 7, 4);
    }
    return canvas;
  }

  /** Release every GPU backing store when its race ends. */
  destroy() {
    for (const canvas of [...this.bodies.values(), this.halo, this.flame, this.hotCore]) {
      canvas.width = 1; canvas.height = 1;
    }
    this.bodies.clear();
  }
}
