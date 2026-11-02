import { sceneryRoadClearance } from "./scenery-geometry.js";

const TEMPLATES = [
  [[-3,-2],[3,-2],[3,2],[-3,2]],
  [[-3,-2],[3,-2],[3,2],[0,2],[0,0],[-3,0]],
  [[-3,-2],[3,-2],[3,2],[1,2],[1,0],[-1,0],[-1,2],[-3,2]],
  [[-3,-2],[3,-2],[3,0],[2,0],[2,2],[-3,2],[-3,0],[-2,0],[-2,-1],[-3,-1]],
  [[-3,-2],[3,-2],[3,2],[1,2],[1,1],[2,1],[2,0],[0,0],[0,2],[-3,2],[-3,0],[-2,0],[-2,-1],[-3,-1]]
];
export const URBAN_SIDEWALK_WIDTH = 32;
const smooth = t => t * t * t * (t * (t * 6 - 15) + 10);

/** Design the race first. Independently displaced intersections and bent
 * streets form an old-town circuit, with one long avenue for the start/pits.
 * General circular fillets support arbitrary junction angles, not just 90°. */
export function makeUrbanCircuit(rng, complexity, width, vary = true) {
  const scaleX = 900 + rng() * 160, scaleY = 850 + rng() * 170;
  const rotation = rng() * Math.PI * 2, c = Math.cos(rotation), s = Math.sin(rotation);
  const flip = rng() < .5 ? -1 : 1;
  const anchors = TEMPLATES[complexity - 1].map(([x,y],i) => ({
    x: (x + (vary && i > 1 ? (rng() - .5) * .64 : 0)) * scaleX * flip,
    y: (y + (vary && i > 1 ? (rng() - .5) * .56 : 0)) * scaleY
  }));
  const vertices = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i], b = anchors[(i + 1) % anchors.length];
    vertices.push(a);
    const length = Math.hypot(b.x-a.x,b.y-a.y);
    // The avenue is genuinely straight; other long streets develop bends and
    // oblique junctions instead of being another edge of a rectangular grid.
    if (i === 0 || length < 1450) continue;
    const count = length > 3400 ? 2 : 1;
    for (let j=1;j<=count;j++) {
      const t=j/(count+1), offset=(vary ? rng()-.5 : .2) * Math.min(680,length*.25);
      vertices.push({x:a.x+(b.x-a.x)*t-(b.y-a.y)/length*offset,
        y:a.y+(b.y-a.y)*t+(b.x-a.x)/length*offset});
    }
  }
  if (rng() < .5) vertices.reverse();
  const radius = width * [0,2.15,1.65,1.32,1.14,1.30][complexity];
  const corners = vertices.map((v,i) => {
    const a=vertices[(i-1+vertices.length)%vertices.length], b=vertices[(i+1)%vertices.length];
    const li=Math.hypot(v.x-a.x,v.y-a.y),lo=Math.hypot(b.x-v.x,b.y-v.y);
    const ax=(v.x-a.x)/li,ay=(v.y-a.y)/li,bx=(b.x-v.x)/lo,by=(b.y-v.y)/lo;
    const turn=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);
    const tangent=Math.tan(Math.abs(turn)/2);
    if(tangent<.002) return {entry:v,exit:v,radius:0,turn:0};
    const setback=Math.min(radius*tangent,li*.36,lo*.36),r=setback/tangent;
    const entry={x:v.x-ax*setback,y:v.y-ay*setback},exit={x:v.x+bx*setback,y:v.y+by*setback};
    const sign=Math.sign(turn),center={x:entry.x-ay*sign*r,y:entry.y+ax*sign*r};
    return {entry,exit,center,radius:r,turn};
  });
  const samples=[],world=p=>({x:p.x*c-p.y*s,y:p.x*s+p.y*c});
  for(let i=0;i<corners.length;i++) {
    const corner=corners[i],previous=corners[(i-1+corners.length)%corners.length].exit;
    const steps=Math.max(1,Math.ceil(Math.hypot(corner.entry.x-previous.x,corner.entry.y-previous.y)/44));
    for(let j=0;j<steps;j++) samples.push(world({x:previous.x+(corner.entry.x-previous.x)*j/steps,y:previous.y+(corner.entry.y-previous.y)*j/steps}));
    if(!corner.radius) continue;
    const start=Math.atan2(corner.entry.y-corner.center.y,corner.entry.x-corner.center.x);
    const stepsArc=Math.max(1,Math.ceil(Math.abs(corner.turn)*corner.radius/32));
    for(let j=0;j<stepsArc;j++) {
      const angle=start+corner.turn*j/stepsArc;
      samples.push(world({x:corner.center.x+Math.cos(angle)*corner.radius,y:corner.center.y+Math.sin(angle)*corner.radius}));
    }
  }
  return {samples,controls:vertices.map(world),city:{kind:"route-grown"}};
}

/** Smooth, long street-scale tapers. No noise at individual vertices: a
 * boulevard becomes a local street over tens of metres, including the seam. */
export function assignUrbanWidths(samples, totalLength, width, seed) {
  let hash=2166136261;
  for(const char of String(seed)) hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
  const factors=[.68,1.44,.92,1.22,.72,1.55,.86,1.12];
  const phase=(hash%997)/997;
  for(const point of samples) {
    const position=((point.cumulative/totalLength+phase)%1)*factors.length;
    const index=Math.floor(position),t=smooth(position-index);
    point.roadWidth=width*(factors[index]+(factors[(index+1)%factors.length]-factors[index])*t);
  }
}

function atDistance(samples,distance) {
  let index=0;
  while(index<samples.length-1&&samples[index+1].cumulative<=distance) index++;
  return {point:samples[index],index};
}

/** The city grows from the final validated race: frontage follows each street,
 * secondary streets branch at oblique angles and districts leave pocket parks.
 * There is no global lattice and no rigid rectangular city boundary. */
export function buildUrbanDistrict(samples,totalLength,pit,rng,width) {
  const roads=[],junctions=[],parks=[];
  for(let distance=420;distance<totalLength;distance+=780+rng()*460) {
    const {point:p,index}=atDistance(samples,distance),side=rng()<.5?-1:1;
    if(pit.samples.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<620))continue;
    const skew=(rng()-.5)*.9,depth=650+rng()*580;
    const nx=p.nx*side*Math.cos(skew)+p.tx*Math.sin(skew);
    const ny=p.ny*side*Math.cos(skew)+p.ty*Math.sin(skew);
    const bend=(rng()-.5)*320;
    const points=[{x:p.x,y:p.y},{x:p.x+nx*depth*.4,y:p.y+ny*depth*.4},
      {x:p.x+nx*depth-p.tx*bend,y:p.y+ny*depth-p.ty*bend}];
    if(samples.some(q=>Math.hypot(q.x-points[2].x,q.y-points[2].y)<260))continue;
    const roadWidth=98+rng()*68;
    roads.push({points,width:roadWidth,side});junctions.push({index,side,width:roadWidth});
  }
  // Back streets join neighbouring branches into irregular blocks. Every
  // connecting corridor is checked against the racing ribbon and pit, so a
  // background street cannot quietly cross another part of the closed course.
  for(const side of [-1,1]) {
    const branches=roads.filter(road=>road.side===side);
    for(let i=0;i<branches.length;i++) {
      if(roads.length>=48)break;
      const a=branches[i].points.at(-1),b=branches[(i+1)%branches.length].points.at(-1);
      const length=Math.hypot(b.x-a.x,b.y-a.y);
      if(length<320||length>2600)continue;
      const bend=(rng()-.5)*180;
      const mid={x:(a.x+b.x)/2-(b.y-a.y)/length*bend,y:(a.y+b.y)/2+(b.x-a.x)/length*bend};
      const points=[a,mid,b],roadWidth=94+rng()*28;
      const clear=points.slice(0,-1).every((p,j)=>{
        const q=points[j+1],corridorLength=Math.hypot(q.x-p.x,q.y-p.y),height=roadWidth+URBAN_SIDEWALK_WIDTH*2;
        const box={x:(p.x+q.x)/2,y:(p.y+q.y)/2,angle:Math.atan2(q.y-p.y,q.x-p.x),width:corridorLength,height,
          collisionShape:'box',collisionRadius:Math.hypot(corridorLength,height)/2};
        return sceneryRoadClearance(box,samples,width)>=URBAN_SIDEWALK_WIDTH+18
          && sceneryRoadClearance(box,pit.samples,pit.width,false)>=30;
      });
      if(clear)roads.push({points,width:roadWidth,side});
    }
  }
  const frontage=[];
  for(let distance=80,ordinal=0;distance<totalLength;distance+=230+rng()*100,ordinal++) {
    const {point:p,index}=atDistance(samples,distance);
    for(const side of [-1,1]) {
      const park=(ordinal+(side>0?3:0))%17===6;
      const district=ordinal%11>=8?"industrial":ordinal%7===2?"civic":"residential";
      frontage.push({point:p,index,side,district,park});
      if(park) {
        const offset=p.roadWidth/2+URBAN_SIDEWALK_WIDTH+180;
        parks.push({x:p.x+p.nx*side*offset,y:p.y+p.ny*side*offset,angle:Math.atan2(p.ty,p.tx),width:230,height:210});
      }
    }
  }
  return {kind:"route-grown",roads,junctions,parks,frontage,roadWidth:width,sidewalk:URBAN_SIDEWALK_WIDTH};
}


export function urbanBuildingPlots(city,rng) {
  const plots=[];
  const add=(p,side,width,height,offset,kind,block)=>{
    plots.push({kind,x:p.x+p.nx*side*offset,y:p.y+p.ny*side*offset,width,height,
      angle:Math.atan2(p.ty,p.tx)+(side>0?Math.PI:0),variant:Math.floor(rng()*6),block,
      collisionShape:"box",collisionRadius:Math.hypot(width,height)/2,visualRadius:Math.hypot(width,height)/2+16,
      solid:true,drawLayer:2,scale:1});
  };
  for(const {point:p,index,side,district,park} of city.frontage) {
    if(park) continue;
    const wide=district==="industrial",w=wide?280+rng()*130:172+rng()*100,h=145+rng()*75;
    const kind=wide?"warehouse":district==="civic"?"civic":rng()<.55?"townhouse":"apartment";
    for(let row=0;row<2;row++) {
      const offset=p.roadWidth/2+city.sidewalk+30+h/2+row*(h+105);
      add(p,side,w*(row?.92:1),h,offset,row&&kind==="civic"?"apartment":kind,`${index}:${side}:${row}`);
    }
  }
  for(let i=0;i<city.roads.length;i++) {
    const road=city.roads[i],a=road.points[1],b=road.points[2],length=Math.hypot(b.x-a.x,b.y-a.y);
    const tx=(b.x-a.x)/length,ty=(b.y-a.y)/length;
    for(let d=100;d<length-70;d+=260) for(const side of [-1,1]) {
      const p={x:a.x+tx*d,y:a.y+ty*d,nx:-ty,ny:tx,tx,ty};
      add(p,side,180+rng()*80,150+rng()*65,road.width/2+city.sidewalk+145,"townhouse",`lane:${i}:${d}:${side}`);
    }
  }
  return plots;
}
