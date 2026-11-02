import { seededRng, wallBoundaryPoint, roadWidthAt, roadEdgePoint } from "../track.js";

const PALETTES = Object.freeze({
  city: { road: "#414448", ground: "#353b3c", light: "#434a47", grass: "#68705b", curb: "#b7ad95" },
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
    this.city = track.city;
    this.paving = this.city ? this.#paving(track.seed) : null;
    this.cityClosures = [];
    this.streetPaths = (this.city?.roads ?? []).map(road => {
      const path = new Path2D();
      road.points.forEach((p,i)=>i?path.lineTo(p.x,p.y):path.moveTo(p.x,p.y));
      return {path,width:road.width};
    });
    this.roadBands = this.city ? [6,3.5,0].map(margin => {
      const path=new Path2D();
      const edge=[...track.samples.map(p=>roadEdgePoint(p,track.width,1,margin)),
        ...track.samples.toReversed().map(p=>roadEdgePoint(p,track.width,-1,margin))];
      edge.forEach((p,i)=>i?path.lineTo(p.x,p.y):path.moveTo(p.x,p.y));path.closePath();return path;
    }) : null;
    if(this.city) this.#streetClosures(track);
    this.grid = new Path2D();
    this.arrows = new Path2D();
    this.rubber = new Path2D();
    this.#markings(track);
  }

  #streetClosures(track) {
    for(const junction of this.city.junctions) {
      const p=track.samples[junction.index],side=junction.side;
      const key=side>0?'wallLeft':'wallRight';
      if(Number(p[key+'Alpha']??1)<.96 || Number(p[key+'SegmentAlpha']??1)<.96)continue;
      const position=wallBoundaryPoint(p,track.width,side);
      if(track.pit.samples.some(q=>Math.hypot(position.x-q.x,position.y-q.y)<track.pit.width/2+20))continue;
      this.cityClosures.push({...position,angle:Math.atan2(p.ty,p.tx),width:junction.width*.96});
    }
  }

  /** Visible street closures sit on already-solid perimeter segments. They do
   * not introduce a second collision shape or mask a drivable pit entrance. */
  paintCityClosures(ctx,bounds=null) {
    for(const closure of this.cityClosures) {
      const radius=closure.width/2+12;
      if(bounds&&(closure.x+radius<bounds.minX||closure.x-radius>bounds.maxX||closure.y+radius<bounds.minY||closure.y-radius>bounds.maxY))continue;
      ctx.save();ctx.translate(closure.x,closure.y);ctx.rotate(closure.angle);
      ctx.fillStyle="#252e30";ctx.fillRect(-closure.width/2,-4,closure.width,8);
      ctx.fillStyle="#c6a35d";
      for(let x=-closure.width/2+5;x<closure.width/2-10;x+=23) {
        ctx.beginPath();ctx.moveTo(x,-4);ctx.lineTo(x+12,-4);ctx.lineTo(x+5,4);ctx.lineTo(x-7,4);ctx.closePath();ctx.fill();
      }
      ctx.fillStyle="#ada48b";ctx.fillRect(-closure.width/2,-8,5,16);ctx.fillRect(closure.width/2-5,-8,5,16);
      ctx.restore();
    }
  }

  #paving(seed) {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64; this.canvases.push(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const random = seededRng(`${seed}:city-stone`);
    ctx.fillStyle = "#686b64"; ctx.fillRect(0, 0, 64, 64);
    for (let row = 0; row < 8; row++) for (let column = -1; column < 8; column++) {
      ctx.fillStyle = ["#8b8a7c", "#969281", "#817f73", "#a19b86"][Math.floor(random() * 4)];
      ctx.fillRect(column * 10 + (row % 2) * 5, row * 8, 9, 7);
    }
    return ctx.createPattern(canvas, "repeat");
  }

  /** Bake the surrounding street network and stone sidewalks beneath the
   * closed race route. The route barriers still close every side intersection. */
  paintCity(ctx) {
    if (!this.city) return;
    ctx.save();ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([]);
    for(const {path,width} of this.streetPaths) {
      ctx.strokeStyle=this.paving??'#888576';ctx.lineWidth=width+this.city.sidewalk*2;ctx.stroke(path);
      ctx.strokeStyle='#bab29a';ctx.lineWidth=width+5;ctx.stroke(path);
      ctx.strokeStyle=this.asphalt??this.palette.road;ctx.lineWidth=width;ctx.stroke(path);
    }
    for(const park of this.city.parks) {
      ctx.save();ctx.translate(park.x,park.y);ctx.rotate(park.angle);
      ctx.fillStyle='#52684f';ctx.fillRect(-park.width/2,-park.height/2,park.width,park.height);
      ctx.fillStyle=this.paving??'#918b75';ctx.fillRect(-9,-park.height/2,18,park.height);
      ctx.fillRect(-park.width/2,-9,park.width,18);
      ctx.fillStyle='#536b72';ctx.beginPath();ctx.arc(0,0,23,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#b5b19a';ctx.lineWidth=4;ctx.stroke();ctx.restore();
    }
    ctx.restore();
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
      const lane = (index % 2 ? 1 : -1) * Math.min(42, roadWidthAt(p,track.width) * 0.19);
      for (const [i, [x, y]] of [[20, -17], [-23, -17], [-23, 17], [20, 17]].entries()) {
        const wx = p.x + p.tx * x + p.nx * (y + lane), wy = p.y + p.ty * x + p.ny * (y + lane);
        if (i) this.grid.lineTo(wx, wy); else this.grid.moveTo(wx, wy);
      }
    }
  }

  /** Stroke a textured road with layered shoulders and alternating kerb paint. */
  paintRoad(ctx, path, width, pit = false) {
    ctx.setLineDash([]);
    if(!pit && this.roadBands) {
      for(let i=0;i<this.roadBands.length;i++) {
        ctx.fillStyle=i===0?'#14232b':i===1?'#bbb49c':this.asphalt??this.palette.road;
        ctx.fill(this.roadBands[i]);
      }
      return;
    }
    ctx.strokeStyle = "#14232b"; ctx.lineWidth = width + 12; ctx.stroke(path);
    ctx.strokeStyle = this.city ? "#bbb49c" : "#d3d9ca"; ctx.lineWidth = width + 7; ctx.stroke(path);
    ctx.strokeStyle = pit ? "#75aaaf" : this.palette.curb;
    ctx.setLineDash(pit ? [12, 12] : this.city ? [] : [18, 18]); ctx.stroke(path); ctx.setLineDash([]);
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
    this.city = null; this.paving = null;
    this.cityClosures.length = 0;
    this.streetPaths.length = 0; this.roadBands = null;
  }
}
