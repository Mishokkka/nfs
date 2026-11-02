import assert from "node:assert/strict";
import { generateTrack } from "../scripts/track.js";
import { RaceSimulation } from "../scripts/physics.js";
import { cloneDefaultBuild } from "../scripts/catalog.js";
import { positiveInteger } from "./test-harness.mjs";

const profiles=[5,1,2,3,4].slice(0,Math.min(5,positiveInteger("NFS_CITY_SOAK_PROFILES",5)));
const frames=["allantry","arrow","spider","keel","bull","turtle"];
const results=[];
for(const complexity of profiles) {
  const track=generateTrack(`urban-race-${complexity}`,complexity,"city");
  const entries=Array.from({length:12},(_,i)=>({id:`car-${i}`,name:`City ${i}`,
    build:{...cloneDefaultBuild(),frame:frames[i%frames.length]},isBot:true,botSkill:1+i%4,botSeed:`urban-bot-${i}`}));
  const simulation=new RaceSimulation({track,entries,laps:2,requiredPitStops:1});
  for(let tick=0;tick<60*600&&!simulation.finished;tick++) simulation.step();
  assert.ok(simulation.finished,`city profile ${complexity} did not finish: ${JSON.stringify(simulation.cars.filter(c=>!c.finished).map(c=>({id:c.id,lap:c.lap,pit:c.pitState,d:c.raceDistance})))}`);
  for(const car of simulation.cars) {
    assert.equal(car.pitStopsCompleted,1);assert.equal(car.lap,2);
    assert.ok([car.x,car.y,car.health,car.charge,car.heat,car.finishTime].every(Number.isFinite));
  }
  results.push({complexity,seconds:+simulation.time.toFixed(2),buildings:track.scenery.length});
}
console.log(`city-soak-tests: ok ${JSON.stringify(results)}`);
