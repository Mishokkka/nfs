import { seededRng } from "../track.js";

const PALETTES = Object.freeze({
  industrial: { road: "#343e43", ground: "#19272b", light: "#30403c", grass: "#465a43", curb: "#cf9a48" },
  woodland: { road: "#3a4040", ground: "#152b26", light: "#30483a", grass: "#48684b", curb: "#ca7059" },
  estate: { road: "#3e4345", ground: "#1c302a", light: "#3a4c3d", grass: "#5c7351", curb: "#b59b6c" },
  ruins: { road: "#41433f", ground: "#252b29", light: "#41473a", grass: "#616746", curb: "#7aa7a4" },
  tournament: { road: "#343e49", ground: "#1c2631", light: "#34413f", grass: "#456450", curb: "#d47058" }
});

/** Immutable visual geometry and small repeating textures, rasterized into the
 * existing static track layer/tiles. No decoration is evaluated per race frame.
 */
export class TrackArt {
  constructor(track) {
    this.palette = PALETTES[track.environmentTheme] ?? PALETTES.tournament;
    this.canvases = [];
    this.asphalt = this.#texture(this.palette.road, `${track.seed}:asphalt`, false);
    this.ground = this.#texture(this.palette.ground, `${track.seed}:ground`, true);
    this.grid = new Path2D();
    this.arrows = new Path2D();
    this.rubber = new Path2D();
    this.#markings(track);
  }

  /** Paint deterministic aggregate once, instead of allocating particles/filters. */
  #texture(base, seed, ground) {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext("2d");
    this.canvases.push(canvas);
    if (!ctx) return null;
    const random = seededRng(seed);
    ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 320; i++) {
      ctx.fillStyle = i % 2 ? "#e3e5c91c" : "#08171e2b";
      const size = ground ? 1 + random() * 3 : 0.7 + random() * 1.2;
      ctx.fillRect(random() * 128, random() * 128, size, size);
    }
    if (!ground) {
      ctx.strokeStyle = "#11202930"; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(0, 82); ctx.lineTo(40, 80); ctx.lineTo(66, 85); ctx.lineTo(128, 83); ctx.stroke();
    }
    return ctx.createPattern(canvas, "repeat");
  }

  /** Build low-contrast rubber lines, directional paint and the actual spawn grid. */
  #markings(track) {
    const points = track.samples;
    for (const side of [-1, 1]) {
      points.forEach((p, i) => {
        const x = p.x + p.nx * side * 8, y = p.y + p.ny * side * 8;
        if (i) this.rubber.lineTo(x, y); else this.rubber.moveTo(x, y);
      });
      this.rubber.closePath();
    }
    for (let index = 18; index < points.length; index += 38) {
      const p = points[index];
      for (const offset of [-3, 3]) {
        this.arrows.moveTo(p.x + p.tx * offset - p.nx * 5, p.y + p.ty * offset - p.ny * 5);
        this.arrows.lineTo(p.x + p.tx * (offset + 5), p.y + p.ty * (offset + 5));
        this.arrows.lineTo(p.x + p.tx * offset + p.nx * 5, p.y + p.ty * offset + p.ny * 5);
      }
    }
    for (let index = 0; index < 12; index++) {
      const p = points[(points.length - 5 - Math.floor(index / 2) * 7 + points.length) % points.length];
      const lane = (index % 2 ? 1 : -1) * Math.min(42, track.width * 0.19);
      for (const [i, [x, y]] of [[20, -17], [-23, -17], [-23, 17], [20, 17]].entries()) {
        const wx = p.x + p.tx * x + p.nx * (y + lane), wy = p.y + p.ty * x + p.ny * (y + lane);
        if (i) this.grid.lineTo(wx, wy); else this.grid.moveTo(wx, wy);
      }
    }
  }

  /** Stroke a textured road with layered shoulders and alternating kerb paint. */
  paintRoad(ctx, path, width, pit = false) {
    ctx.setLineDash([]);
    ctx.strokeStyle = "#14232b"; ctx.lineWidth = width + 12; ctx.stroke(path);
    ctx.strokeStyle = "#d3d9ca"; ctx.lineWidth = width + 7; ctx.stroke(path);
    ctx.strokeStyle = pit ? "#75aaaf" : this.palette.curb;
    ctx.setLineDash(pit ? [12, 12] : [18, 18]); ctx.stroke(path); ctx.setLineDash([]);
    ctx.strokeStyle = this.asphalt ?? this.palette.road; ctx.lineWidth = width; ctx.stroke(path);
    if (pit) {
      ctx.strokeStyle = "#95d4d580"; ctx.lineWidth = 1.5; ctx.setLineDash([10, 12]); ctx.stroke(path); ctx.setLineDash([]);
    }
  }

  /** These markings are baked with the track, never added to the hot render loop. */
  paintMarkings(ctx) {
    ctx.strokeStyle = "#12222b32"; ctx.lineWidth = 7; ctx.stroke(this.rubber);
    ctx.strokeStyle = "#e0e4d743"; ctx.lineWidth = 1.5; ctx.stroke(this.grid);
    ctx.strokeStyle = "#e3e6d947"; ctx.lineWidth = 2; ctx.stroke(this.arrows);
  }

  /** Free texture sources along with the renderer's other cached layers. */
  destroy() {
    for (const canvas of this.canvases) { canvas.width = 1; canvas.height = 1; }
    this.canvases.length = 0;
    this.asphalt = null; this.ground = null;
    this.grid = null; this.arrows = null; this.rubber = null;
  }
}
