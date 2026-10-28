const TEMPLATES = [
  [[-3,-2],[3,-2],[3,2],[-3,2]],
  [[-3,-2],[3,-2],[3,2],[0,2],[0,0],[-3,0]],
  [[-3,-2],[3,-2],[3,2],[1,2],[1,0],[-1,0],[-1,2],[-3,2]],
  [[-3,-2],[3,-2],[3,0],[2,0],[2,2],[-3,2],[-3,0],[-2,0],[-2,-1],[-3,-1]],
  [[-3,-2],[3,-2],[3,2],[1,2],[1,1],[2,1],[2,0],[0,0],[0,2],[-3,2],[-3,0],[-2,0],[-2,-1],[-3,-1]]
];
export const URBAN_SIDEWALK_WIDTH = 32;

function gridLoopIsSimple(points) {
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue;
    const a = points[i], b = points[(i + 1) % points.length], c = points[j], d = points[(j + 1) % points.length];
    const overlaps = (a, b, c, d) => Math.max(Math.min(a,b), Math.min(c,d)) <= Math.min(Math.max(a,b), Math.max(c,d));
    if (overlaps(a[0],b[0],c[0],d[0]) && overlaps(a[1],b[1],c[1],d[1])) return false;
  }
  return true;
}

function varyBlocks(template, rng, complexity) {
  let points = template.map(point => [...point]);
  if (complexity === 1) return points;
  for (let pass = 0; pass < Math.min(2, complexity - 1); pass++) {
    if (rng() < .2) continue;
    for (let attempt = 0; attempt < 12; attempt++) {
      const index = Math.floor(rng() * points.length), a = points[index], b = points[(index + 1) % points.length];
      const distance = Math.abs(b[0]-a[0]) + Math.abs(b[1]-a[1]);
      if (distance < 4) continue;
      const dx = Math.sign(b[0]-a[0]), dy = Math.sign(b[1]-a[1]), side = rng() < .5 ? -1 : 1;
      const begin = 1 + Math.floor(rng() * (distance - 3));
      const entry = [a[0] + dx * begin, a[1] + dy * begin];
      const exit = [entry[0] + dx * 2, entry[1] + dy * 2];
      const turnIn = [entry[0] - dy * side, entry[1] + dx * side];
      const turnOut = [exit[0] - dy * side, exit[1] + dx * side];
      if ([turnIn,turnOut].some(([x,y]) => Math.abs(x)>3 || Math.abs(y)>2)) continue;
      const candidate = [...points.slice(0,index+1),entry,turnIn,turnOut,exit,...points.slice(index+1)];
      if (!gridLoopIsSimple(candidate)) continue;
      points = candidate; break;
    }
  }
  return points;
}

/** A race follows connected streets of one city grid. Circular corner fillets
 * retain real straight blocks instead of bowing the whole road with a spline. */
export function makeUrbanCircuit(rng, complexity, width, vary = true) {
  const template = vary ? varyBlocks(TEMPLATES[complexity - 1], rng, complexity) : TEMPLATES[complexity - 1];
  const stepX = 840 + rng() * 200, stepY = 780 + rng() * 200;
  const rotation = rng() * Math.PI * 2, c = Math.cos(rotation), s = Math.sin(rotation);
  const flip = rng() < .5 ? -1 : 1;
  let vertices = template.map(([x,y]) => ({ x: x * stepX * flip, y: y * stepY }));
  if (rng() < .5) vertices = vertices.reverse();
  const radius = width * (complexity === 1 ? 1.65 : 1.32);
  const corners = vertices.map((v, index) => {
    const before = vertices[(index - 1 + vertices.length) % vertices.length], after = vertices[(index + 1) % vertices.length];
    const lengthIn = Math.hypot(v.x - before.x, v.y - before.y), lengthOut = Math.hypot(after.x - v.x, after.y - v.y);
    const ax = (v.x - before.x) / lengthIn, ay = (v.y - before.y) / lengthIn;
    const bx = (after.x - v.x) / lengthOut, by = (after.y - v.y) / lengthOut;
    const r = Math.min(radius, lengthIn * .36, lengthOut * .36);
    const entry = { x: v.x - ax * r, y: v.y - ay * r }, exit = { x: v.x + bx * r, y: v.y + by * r };
    const center = { x: entry.x + bx * r, y: entry.y + by * r };
    return { entry, exit, center, radius: r, turn: Math.sign(ax * by - ay * bx) };
  });
  const points = [];
  const world = p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i], previous = corners[(i - 1 + corners.length) % corners.length].exit;
    const steps = Math.max(1, Math.ceil(Math.hypot(corner.entry.x - previous.x, corner.entry.y - previous.y) / 52));
    for (let j = 0; j < steps; j++) points.push(world({ x: previous.x + (corner.entry.x - previous.x) * j / steps, y: previous.y + (corner.entry.y - previous.y) * j / steps }));
    const start = Math.atan2(corner.entry.y - corner.center.y, corner.entry.x - corner.center.x);
    const arcSteps = Math.ceil(corner.radius * Math.PI / 2 / 38);
    for (let j = 0; j < arcSteps; j++) {
      const angle = start + corner.turn * Math.PI / 2 * j / arcSteps;
      points.push(world({ x: corner.center.x + Math.cos(angle) * corner.radius, y: corner.center.y + Math.sin(angle) * corner.radius }));
    }
  }
  const columns = [-4,-3,-2,-1,0,1,2,3,4].map(x => x * stepX);
  const rows = [-3,-2,-1,0,1,2,3].map(y => y * stepY);
  const roads = [
    ...columns.map(x => ({ x1: x, y1: rows[0], x2: x, y2: rows.at(-1) })),
    ...rows.map(y => ({ x1: columns[0], y1: y, x2: columns.at(-1), y2: y }))
  ];
  const landmarkX = 2 + Math.floor(rng()*4), landmarkY = 1 + Math.floor(rng()*4);
  const blocks = [];
  for (let x=0;x<columns.length-1;x++) for(let y=0;y<rows.length-1;y++) {
    const type = x===landmarkX && y===landmarkY ? "civic" : rng()<.07 ? "park" : x>=6 ? "industrial" : "residential";
    blocks.push({ x, y, type });
  }
  return { samples: points, controls: vertices.map(world), city: { rotation, columns, rows, roads, blocks, roadWidth: width, sidewalk: URBAN_SIDEWALK_WIDTH } };
}

/** Buildings occupy frontage plots inside blocks. No random scatter or random
 * yaw: all façades share the streets' axes, with service courtyards between. */
export function urbanBuildingPlots(city, rng) {
  const plots = [], c = Math.cos(city.rotation), s = Math.sin(city.rotation);
  const streetMargin = city.roadWidth / 2 + city.sidewalk + 26;
  const add = (kind,px,py,width,height,front,block) => plots.push({kind,x:px*c-py*s,y:px*s+py*c,
    width,height,angle:city.rotation+front,variant:Math.floor(rng()*6),block,
    collisionShape:"box",collisionRadius:Math.hypot(width,height)/2,visualRadius:Math.hypot(width,height)/2+16,
    solid:true,drawLayer:2,scale:1});
  for (const block of city.blocks) {
    const {x,y,type}=block;
    if (type==="park") continue;
    const left = city.columns[x] + streetMargin, right = city.columns[x + 1] - streetMargin;
    const top = city.rows[y] + streetMargin, bottom = city.rows[y + 1] - streetMargin;
    const id=`${x}:${y}`;
    if(type==="civic") {add("civic",(left+right)/2,(top+bottom)/2,(right-left)*.84,(bottom-top)*.64,0,id);continue;}
    for (let row=0;row<2;row++) {
      const count=type==="industrial" || rng()<.23 ? 1 : 2;
      const plotWidth=(right-left-(count-1)*22)/count, depth=Math.min(245,(bottom-top)*.39);
      for(let column=0;column<count;column++) {
        const width=plotWidth*(.90+rng()*.08),height=depth*(.87+rng()*.12);
        const px=count===1?(left+right)/2:column?right-width/2:left+width/2;
        const py=row?bottom-height/2:top+height/2;
        add(type==="industrial"?"warehouse":count===1?"apartment":rng()<.7?"townhouse":"apartment",px,py,width,height,row?0:Math.PI,id);
      }
    }
  }
  return plots;
}
