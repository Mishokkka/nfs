// Screen-space racing instruments. The dial/ticks/backplate are rasterized
// only on resize; live telemetry never touches DOM or allocates another canvas.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const WHITE = "#f5f5fa", MUTED = "#aeb5c5", VIOLET = "#c39aff", AMBER = "#efbb73", RED = "#ff887c";
const START = Math.PI * .75, SWEEP = Math.PI * 1.5;
const SPEED_SCALE = 240;

const raceTime = seconds => {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(total / 6000)}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
};

/** CSS-pixel regions shared with the minimap. Bottom-left reserves the help
 * button; short windows switch to digital instruments instead of clipping. */
export function raceHudLayout(width, height) {
  const narrow = width < 540, short = height < 450, margin = 12;
  const dialWidth = narrow ? 148 : width < 920 ? 194 : 224;
  const dialHeight = short ? 142 : narrow ? 212 : 238;
  const mapWidth = narrow || short ? 128 : width < 920 ? 172 : 218;
  return {
    width, height, narrow, short, margin,
    dial: { x: width - dialWidth - margin, y: height - dialHeight - margin, width: dialWidth, height: dialHeight },
    map: { x: margin, y: height - Math.round(mapWidth * .68) - 50, width: mapWidth, height: Math.round(mapWidth * .68) },
    timing: { x: margin, y: margin, width: narrow ? 172 : 246, height: short ? 79 : 104 },
    standing: { x: width - (narrow ? 116 : 150) - margin, y: margin, width: narrow ? 116 : 150, height: 88 },
    status: { x: margin, y: short ? 104 : 128, width: width - margin * 2, height: 42 }
  };
}

function cutPanel(ctx, x, y, width, height, color) {
  const cut = Math.min(10, width * .5, height * .5);
  ctx.beginPath();
  ctx.moveTo(x + cut, y); ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + height - cut); ctx.lineTo(x + width - cut, y + height);
  ctx.lineTo(x, y + height); ctx.lineTo(x, y + cut); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}

export class RaceInstruments {
  constructor() {
    this.backplate = document.createElement("canvas");
    this.context = this.backplate.getContext("2d");
    this.layout = null;
    this.scale = 1;
    this.staticBuilds = 0;
    this.statusText = null;
    this.statusLines = [];
  }

  resize(width, height, scale) {
    if (this.layout?.width === width && this.layout?.height === height && this.scale === scale) return;
    this.layout = raceHudLayout(width, height);
    this.scale = scale;
    const { dial, narrow, short } = this.layout;
    this.radius = narrow ? 50 : dial.width < 224 ? 66 : 74;
    this.centerX = dial.width / 2;
    this.centerY = narrow ? 78 : 95;
    this.meterY = short ? 64 : narrow ? 140 : 166;
    this.backplate.width = Math.ceil(dial.width * scale);
    this.backplate.height = Math.ceil(dial.height * scale);
    const ctx = this.context;
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    cutPanel(ctx, 0, 0, dial.width, dial.height, "rgba(10, 14, 23, .86)");
    ctx.fillStyle = VIOLET;
    ctx.fillRect(dial.width - 40, 0, 40, 2);
    ctx.strokeStyle = "#566075"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(0, dial.height - 1);
    ctx.lineTo(dial.width - 12, dial.height - 1); ctx.stroke();
    if (!short) {
      const { radius: r, centerX: cx, centerY: cy } = this;
      ctx.strokeStyle = "#424a5f"; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, r, START, START + SWEEP); ctx.stroke();
      for (let value = 0; value <= SPEED_SCALE; value += 8) {
        const a = START + value / SPEED_SCALE * SWEEP, major = value % 40 === 0;
        ctx.strokeStyle = value >= 200 ? AMBER : "#c0c7d6";
        ctx.lineWidth = major ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
        ctx.lineTo(cx + Math.cos(a) * (r - (major ? 13 : 9)), cy + Math.sin(a) * (r - (major ? 13 : 9)));
        ctx.stroke();
        if (!major) continue;
        ctx.font = `600 ${narrow ? 9 : 11}px Arial, sans-serif`;
        ctx.fillStyle = value >= 200 ? AMBER : MUTED;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(value), cx + Math.cos(a) * (r + 13), cy + Math.sin(a) * (r + 13));
      }
    }
    for (const y of [this.meterY + 13, this.meterY + 36, this.meterY + 59]) {
      cutPanel(ctx, 14, y, dial.width - 28, 6, "#343a4c");
    }
    this.statusText = null;
    this.staticBuilds++;
  }

  draw(ctx, car, snapshot, status, spectating = false) {
    if (!this.layout) return;
    const l = this.layout, d = l.dial;
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.#timing(ctx, car, snapshot, spectating);
    this.#standing(ctx, car, snapshot);
    ctx.drawImage(this.backplate, d.x, d.y, d.width, d.height);
    ctx.save(); ctx.translate(d.x, d.y);
    const speed = Math.max(0, Math.round(Math.hypot(finite(car.vx), finite(car.vy)) * (.62 / 3)));
    const reverse = finite(car.vx) * Math.cos(finite(car.angle)) + finite(car.vy) * Math.sin(finite(car.angle)) < -6 && speed > 0;
    const charge = clamp(finite(car.charge) / Math.max(1, finite(car.maxCharge)), 0, 1);
    const health = clamp(finite(car.health) / Math.max(1, finite(car.maxHealth)), 0, 1);
    const heat = clamp(finite(car.heat) / 100, 0, 1);
    const hot = Boolean(car.overheated) || finite(car.heat) >= (car.heatWarning ? 68 : 78);
    const active = Boolean(car.boost) && charge > 0 && !car.overheated;
    const accent = active ? VIOLET : WHITE;
    if (!l.short) {
      const a = START + clamp(speed / SPEED_SCALE, 0, 1) * SWEEP;
      ctx.strokeStyle = accent; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(this.centerX, this.centerY, this.radius, START, a); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath();
      ctx.arc(this.centerX + Math.cos(a) * this.radius, this.centerY + Math.sin(a) * this.radius, 3, 0, Math.PI * 2); ctx.fill();
    }
    const baseline = l.short ? 36 : this.centerY + 11;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = `italic 800 ${l.narrow ? 38 : 48}px Arial, sans-serif`;
    ctx.fillStyle = accent; ctx.fillText(String(speed).padStart(3, "0"), this.centerX, baseline, d.width - 24);
    ctx.font = "700 10px Arial, sans-serif"; ctx.fillStyle = MUTED;
    ctx.fillText(l.short && reverse ? "КМ/Ч · НАЗАД" : l.short && active ? "КМ/Ч · ФОРСАЖ" : "КМ/Ч", this.centerX, baseline + 16);
    if (!l.short) {
      ctx.fillStyle = reverse ? AMBER : active ? VIOLET : MUTED;
      ctx.font = "700 9px Arial, sans-serif";
      ctx.fillText(reverse ? "НАЗАД" : active ? "ФОРСАЖ" : "СКОРОСТЬ", this.centerX, baseline - (l.narrow ? 35 : 44));
    }
    this.#meter(ctx, this.meterY, "КРИСТАЛЛ", charge, charge === 0 ? RED : VIOLET);
    this.#meter(ctx, this.meterY + 23, "ПРОЧНОСТЬ", health, health < .25 ? RED : WHITE);
    this.#meter(ctx, this.meterY + 46, car.overheated ? "ПЕРЕГРЕВ" : "НАГРЕВ", heat, hot ? RED : AMBER);
    ctx.restore();
    if (status) this.#status(ctx, status);
    ctx.restore();
  }

  #timing(ctx, car, snapshot, spectating) {
    const { timing: r, narrow, short } = this.layout;
    cutPanel(ctx, r.x, r.y, r.width, r.height, "rgba(10, 14, 23, .82)");
    ctx.fillStyle = VIOLET; ctx.fillRect(r.x, r.y + 10, 3, 28);
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = spectating ? VIOLET : MUTED; ctx.font = "700 9px Arial, sans-serif";
    ctx.fillText(spectating ? "НАБЛЮДЕНИЕ · ВРЕМЯ" : "ВРЕМЯ ЗАЕЗДА", r.x + 12, r.y + 8);
    ctx.fillStyle = WHITE; ctx.font = `italic 700 ${narrow ? 22 : 28}px Arial, sans-serif`;
    ctx.fillText(raceTime(Number(snapshot.time)), r.x + 11, r.y + 22, r.width - 20);
    ctx.font = "600 10px Arial, sans-serif";
    ctx.fillStyle = MUTED; ctx.fillText("КРУГ", r.x + 12, r.y + (short ? 52 : 57));
    ctx.fillStyle = WHITE; ctx.textAlign = "right";
    ctx.fillText(raceTime(Number(car.currentLapTime)), r.x + r.width - 12, r.y + (short ? 52 : 57));
    if (!short) {
      ctx.textAlign = "left"; ctx.fillStyle = MUTED;
      ctx.fillText("ЛУЧШИЙ", r.x + 12, r.y + 72);
      ctx.textAlign = "right"; ctx.fillStyle = VIOLET;
      ctx.fillText(raceTime(car.bestLapTime), r.x + r.width - 12, r.y + 72);
      ctx.textAlign = "left"; ctx.fillStyle = MUTED;
      ctx.fillText("ПОСЛЕДНИЙ", r.x + 12, r.y + 87);
      ctx.textAlign = "right"; ctx.fillStyle = WHITE;
      ctx.fillText(raceTime(car.lastLapTime), r.x + r.width - 12, r.y + 87);
    }
  }

  #standing(ctx, car, snapshot) {
    const { standing: r, narrow } = this.layout;
    cutPanel(ctx, r.x, r.y, r.width, r.height, "rgba(10, 14, 23, .82)");
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.font = "700 9px Arial, sans-serif"; ctx.fillStyle = MUTED;
    ctx.fillText("ПОЗИЦИЯ", r.x + 12, r.y + 7);
    ctx.font = `italic 800 ${narrow ? 36 : 44}px Arial, sans-serif`; ctx.fillStyle = WHITE;
    ctx.fillText(String(Math.max(1, finite(car.place))).padStart(2, "0"), r.x + 10, r.y + 16);
    ctx.font = "700 13px Arial, sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = MUTED;
    ctx.fillText(`/ ${snapshot.cars.length}`, r.x + r.width - 12, r.y + 34);
    const laps = Math.max(1, finite(snapshot.laps));
    ctx.font = "700 11px Arial, sans-serif"; ctx.fillStyle = WHITE; ctx.textAlign = "left";
    ctx.fillText(`КРУГ ${Math.min(Math.max(1, finite(car.lap) + 1), laps)} / ${laps}`, r.x + 12, r.y + 61);
    const required = Math.max(0, finite(car.pitStopsRequired ?? snapshot.requiredPitStops));
    const done = Math.max(0, finite(car.pitStopsCompleted));
    ctx.fillStyle = done < required ? AMBER : MUTED; ctx.font = "600 10px Arial, sans-serif";
    ctx.fillText(`ПИТ ${done} / ${required}`, r.x + 12, r.y + 76);
  }

  #meter(ctx, y, label, ratio, color) {
    const width = this.layout.dial.width - 28;
    ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.font = "700 9px Arial, sans-serif";
    ctx.fillStyle = color; ctx.fillText(label, 14, y);
    ctx.textAlign = "right"; ctx.fillText(`${Math.round(ratio * 100)}%`, 14 + width, y);
    if (ratio > 0) cutPanel(ctx, 14, y + 13, width * ratio, 6, color);
  }

  #status(ctx, text) {
    const r = this.layout.status;
    ctx.font = "700 11px Arial, sans-serif";
    // Reflow only when a discrete warning changes or the canvas is resized.
    if (text !== this.statusText) {
      this.statusText = text;
      const words = String(text).split(/\s+/);
      this.statusLines = [""];
      for (const word of words) {
        const index = this.statusLines.length - 1, next = `${this.statusLines[index]} ${word}`.trim();
        if (this.statusLines[index] && ctx.measureText(next).width > r.width - 34) this.statusLines.push(word);
        else this.statusLines[index] = next;
      }
    }
    const rows = Math.min(2, this.statusLines.length), height = rows * 14 + 14;
    cutPanel(ctx, r.x, r.y, r.width, height, "rgba(24, 19, 25, .94)");
    ctx.fillStyle = AMBER; ctx.fillRect(r.x, r.y + 6, 3, height - 12);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i < rows; i++) ctx.fillText(this.statusLines[i], this.layout.width / 2, r.y + 7 + i * 14, r.width - 28);
  }

  destroy() {
    this.backplate.width = this.backplate.height = 1;
    this.layout = null;
    this.statusLines.length = 0;
  }
}
