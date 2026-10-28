import assert from "node:assert/strict";
import { generateTrack, polylineSelfIntersects, pitLaneFitsCircuit, wallBoundaryPoint, RUNOFF_SURFACES } from "../scripts/track.js";
import { sceneryRoadDistance, sceneryOverlaps, sceneryContact } from "../scripts/scenery-geometry.js";
import { RaceSimulation, buildRaceCarMeta, neutralInput } from "../scripts/physics.js";
import { cloneDefaultBuild } from "../scripts/catalog.js";
import { advanceCarMotion, terrainModifiers, applyTerrainForces } from "../scripts/physics/car-motion.js";
import { LocalPrediction } from "../scripts/netcode/local-prediction.js";

const layouts = new Set();
let minimumBuildings = Infinity;
for (let seed = 0; seed < 45; seed++) {
  const track = generateTrack(`urban-check-${seed}`, 1 + seed % 5, "city");
  assert.equal(polylineSelfIntersects(track.samples), false);
  assert.ok(pitLaneFitsCircuit(track.pit, track.samples, track.totalLength, track.width, track.spatialGrid));
  for (const side of [-1,1]) assert.equal(polylineSelfIntersects(track.samples.map(p => wallBoundaryPoint(p,track.width,side))), false);
  const city = track.city, c = Math.cos(city.rotation), s = Math.sin(city.rotation);
  const straight = track.samples.filter(p => Math.min(Math.abs(p.tx*c+p.ty*s),Math.abs(-p.tx*s+p.ty*c)) < .015).length;
  assert.ok(straight / track.samples.length > .4, "city streets became a freeform spline");
  minimumBuildings = Math.min(minimumBuildings,track.scenery.length);
  assert.ok(track.scenery.length >= 100 && track.scenery.length <= 192, "city density escaped its bounded plot count");
  const cityArea=(city.columns.at(-1)-city.columns[0])*(city.rows.at(-1)-city.rows[0]);
  assert.ok(track.scenery.reduce((sum,b)=>sum+b.width*b.height,0)/cityArea>.18,"city lost its built frontage");
  assert.ok(city.blocks.some(block=>block.type==="civic"),"city landmark disappeared");
  const pitRunoff = Math.max(...track.pit.samples.flatMap(p => [p.grassWidthLeft,p.grassWidthRight]));
  for (const building of track.scenery) {
    assert.equal(building.collisionShape,"box");
    assert.ok(building.width >= 170 && building.height >= 120, "buildings returned to toy scale");
    assert.ok(Math.abs(Math.sin((building.angle-city.rotation)*2)) < 1e-8, "building rotated away from street grid");
    assert.ok(Math.abs(building.collisionRadius-Math.hypot(building.width,building.height)/2) < 1e-8);
    assert.ok(sceneryRoadDistance(building,track.samples) >= track.width/2+32+12-1e-5, "foundation entered the race perimeter");
    assert.ok(sceneryRoadDistance(building,track.pit.samples,false) >= track.pit.width/2+pitRunoff+12-1e-5, "foundation entered the service perimeter");
  }
  for (let a=0;a<track.scenery.length;a++) for(let b=a+1;b<track.scenery.length;b++) {
    assert.equal(sceneryOverlaps(track.scenery[a],track.scenery[b],11.9),false,"city plots overlapped");
  }
  assert.ok(track.samples.every(p => p.surfaceLeft === "paving" && p.surfaceRight === "paving"));
  assert.ok(track.pit.samples.every(p => p.surfaceLeft === "paving" && p.surfaceRight === "paving"));
  const step = city.columns[1]-city.columns[0];
  layouts.add(JSON.stringify(track.controls.map(p=>[Math.round((p.x*c+p.y*s)/step),Math.round((-p.x*s+p.y*c)/(city.rows[1]-city.rows[0]))])));
  if (track.complexity===5) assert.ok(track.tournamentLayout.technicalRatio>=.28 && track.tournamentLayout.longestStraightRatio>=.105);
}
assert.ok(layouts.size>=20,"city seeds did not produce distinct routes");
const first=generateTrack("repeat-city",4,"city"), second=generateTrack("repeat-city",4,"city");
assert.deepEqual(first,second,"city generation is not deterministic");
assert.deepEqual(generateTrack(9,2.9,"city"),generateTrack(9,2,"city"),"fractional public complexity was not normalized");

for(let seed=0;seed<25;seed++) {
  const circuit=generateTrack(`foundation-audit-${seed}`,1+seed%5,["industrial","woodland","estate","ruins","tournament"][seed%5]);
  const walls=[-1,1].flatMap(side=>[
    {points:circuit.samples.map(p=>wallBoundaryPoint(p,circuit.width,side)),closed:true},
    {points:circuit.pit.samples.map(p=>wallBoundaryPoint(p,circuit.pit.width,side)),closed:false}
  ]);
  for(const building of circuit.scenery.filter(b=>b.collisionShape==="box")) for(const wall of walls) {
    assert.ok(sceneryRoadDistance(building,wall.points,wall.closed)>=12-1e-5,"perimeter fence passed through a building");
  }
}

// Test contacts at a real rectangular wall/corner, and reject the false
// collision that an enclosing circle would cause beside a long building.
const box={x:0,y:0,angle:0,width:200,height:100,collisionShape:"box",collisionRadius:Math.hypot(100,50)};
const car={x:98,y:54,vx:0,vy:-100,angle:0};
const capsule=car=>({start:{x:car.x-8,y:car.y},end:{x:car.x+8,y:car.y},halfWidth:6,halfLength:14});
const hit=sceneryContact(capsule(car),box,car);
assert.ok(hit && Math.abs(hit.ny-1)<1e-8 && Math.abs(hit.penetration-2)<1e-8);
assert.equal(sceneryContact(capsule({...car,x:80,y:90}),box,{...car,x:80,y:90}),null,"enclosing circle caused a phantom wall");
for(const rotation of [0,.4,1.7]) {
  const center={x:0,y:0,vx:10,vy:0,angle:0}, rotated={...box,angle:rotation};
  const contact=sceneryContact(capsule(center),rotated,center);
  assert.ok(contact && Number.isFinite(contact.penetration));
  assert.ok(Math.abs(Math.hypot(contact.nx,contact.ny)-1)<1e-8);
}

// New paving is a mildly rough hard shoulder, not a lawn or a random gravel
// event. Its deterministic motion and drag must replay identically for players.
globalThis.foundry={utils:{deepClone:structuredClone}};
const build=cloneDefaultBuild(), meta=buildRaceCarMeta({id:"car",build});
const physics={...meta.prediction,maxHealth:meta.maxHealth,maxCharge:meta.maxCharge};
const initial={...meta,x:0,y:0,vx:240,vy:0,angle:0,angularVelocity:0,steeringPosition:0,
  health:meta.maxHealth,charge:meta.maxCharge,heat:0,overheated:false,pitState:"track",lap:0,
  surfaceType:"paving",surfaceSeverity:.7,driftAmount:0,lastSteer:0};
const paved=terrainModifiers(initial,physics), grass=terrainModifiers({...initial,surfaceType:"grass"},physics);
assert.ok(paved.grip>grass.grip && paved.dragRate<grass.dragRate && paved.topSpeed>grass.topSpeed);
const input={...neutralInput(),throttle:.6,steer:.1}, state=structuredClone(initial);
for(let tick=0;tick<6;tick++) {
  advanceCarMotion(state,input,physics,1/60,{laps:3,pit:{}});
  applyTerrainForces(state,input,physics,1/60);
}
const prediction=new LocalPrediction();prediction.submit(input,1,0);
prediction.sample({...initial,inputSequence:-1},{tick:0,simulationTime:0,started:true,laps:3,cars:[initial]}, {now:100,clockOffset:0});
for(const key of ["x","y","vx","vy","angle"]) assert.ok(Math.abs(state[key]-prediction.state[key])<1e-7,`paving replay diverged: ${key}`);
for(const surface of RUNOFF_SURFACES) for(const severity of [0,.2,1]) {
  const terrain=terrainModifiers({...initial,surfaceType:surface,surfaceSeverity:severity},physics);
  assert.ok(Object.values(terrain).filter(v=>typeof v==="number").every(Number.isFinite));
}
const brakeDifference=surface=>{
  const coasting={...initial,surfaceType:surface,surfaceSeverity:1,steeringPosition:0};
  const braking={...coasting};
  advanceCarMotion(coasting,neutralInput(),physics,1/60,{laps:3,pit:{}});
  advanceCarMotion(braking,{...neutralInput(),brake:true},physics,1/60,{laps:3,pit:{}});
  return coasting.vx-braking.vx;
};
const asphaltBrake=brakeDifference("road");
for(const material of RUNOFF_SURFACES) assert.ok(brakeDifference(material)<asphaltBrake,"tyre braking ignored the road material");
assert.ok(brakeDifference("paving")>brakeDifference("grass"));
for(const material of RUNOFF_SURFACES) {
  const car={...initial,vx:900,vy:0,angle:0,surfaceType:material,surfaceSeverity:1};
  const terrain=terrainModifiers(car,physics), before=car.vx;
  applyTerrainForces(car,neutralInput(),physics,1/60,terrain);
  assert.ok((before-car.vx)*60<=terrain.maxDragDeceleration+1e-7,"ground resistance exceeded its force ceiling");
}
const stopDistance=material=>{
  const car={...initial,x:0,y:0,vx:80/(.62/3),vy:0,angle:0,surfaceType:material,surfaceSeverity:material==="road"?0:1};
  const input={...neutralInput(),brake:true};
  for(let tick=0;tick<600&&car.vx>0;tick++){
    advanceCarMotion(car,input,physics,1/60,{laps:3,pit:{}});
    applyTerrainForces(car,input,physics,1/60);
  }
  return car.x*(.62/3)/3.6;
};
assert.ok(stopDistance("road")>25 && stopDistance("road")<35);
assert.ok(stopDistance("paving")>stopDistance("road"));
assert.ok(stopDistance("grass")>stopDistance("road"));
assert.ok(stopDistance("gravel")>24 && stopDistance("sand")>18,"loose ground still caused a multi-g stop");

// Exercise the actual simulation collision path, not only the geometry helper.
{
  const circuit=generateTrack("building-impact",2,"woodland");
  const sim=new RaceSimulation({track:circuit,entries:[{id:"impact",build}],laps:2});
  const vehicle=sim.cars[0],p=circuit.samples[0];
  sim.started=true;sim.countdown=0;
  Object.assign(vehicle,{x:p.x,y:p.y,vx:300,vy:0,angle:0});
  const obstacle={x:p.x+100,y:p.y,width:160,height:120,angle:0,collisionShape:"box",collisionRadius:100,solid:true};
  circuit.scenery=[obstacle];sim.step();
  assert.ok(vehicle.health<vehicle.physics.maxHealth,"rectangle impact did not reach damage/impulse handling");
  assert.ok(vehicle.vx<200,"building did not stop forward momentum");
  assert.ok(vehicle.x+vehicle.physics.collisionHalfLength<obstacle.x-obstacle.width/2+.1,"vehicle remained inside the foundation");
}
const track=generateTrack("city-checkpoint",3,"city"), entries=[{id:"car",build,isBot:true,botSkill:3}];
const original=new RaceSimulation({track,entries,laps:2});for(let i=0;i<700;i++)original.step();
const restored=new RaceSimulation({track,entries,laps:2}).restoreCheckpoint(JSON.parse(JSON.stringify(original.exportCheckpoint())));
for(let i=0;i<120;i++){original.step();restored.step();}
assert.deepEqual(restored.exportCheckpoint(),original.exportCheckpoint(),"city F5 restore diverged");
console.log(`track-environment-tests: ok (45 city seeds, ${layouts.size} layouts, min ${minimumBuildings} buildings, box contacts, paving replay, recovery)`);
