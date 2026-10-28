const PALETTES = [
  ["#735348", "#523d38", "#b49a78"], ["#59656a", "#3d4a51", "#b9b1a0"],
  ["#8c674d", "#654632", "#b59c7c"], ["#62756d", "#42594f", "#a6a695"],
  ["#736570", "#50444f", "#c0b099"], ["#7c5844", "#533f36", "#c0ad8a"]
];

/** Plan-view buildings have a single measured foundation. The roof stays in
 * that footprint; shadow, parapets, chimneys and façades are static tile paint. */
export function paintBuilding(ctx, building) {
  const w = building.width, h = building.height, kind = building.kind;
  const [roof, shade, stone] = PALETTES[(building.variant ?? Math.floor(building.scale * 17)) % PALETTES.length];
  ctx.fillStyle = "#080e1250"; ctx.fillRect(-w / 2 + 10, -h / 2 + 12, w, h);
  ctx.fillStyle = stone; ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = "#302e2a"; ctx.lineWidth = 3; ctx.strokeRect(-w / 2, -h / 2, w, h);
  if (kind === "grandstand") {
    ctx.fillStyle = "#55504a"; ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10);
    for (let row = 0; row < 7; row++) {
      ctx.fillStyle = row % 2 ? "#8b8774" : "#514c46";
      ctx.fillRect(-w / 2 + 12, -h / 2 + 12 + row * (h - 30) / 7, w - 24, 7);
    }
    ctx.fillStyle = "#5f777a"; ctx.fillRect(-w / 2 - 1, -h / 2, w + 2, h * .19);
    return;
  }
  ctx.fillStyle = shade; ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 18);
  if (kind === "warehouse" || kind === "workshop") {
    const bays = Math.max(2, Math.round(w / 85));
    for (let bay = 0; bay < bays; bay++) {
      const x = -w / 2 + 7 + bay * (w - 14) / bays;
      ctx.fillStyle = bay % 2 ? "#626f70" : "#506063";
      ctx.fillRect(x, -h / 2 + 7, (w - 14) / bays - 3, h - 30);
      ctx.fillStyle = "#86a6a7"; ctx.fillRect(x + 6, -h / 2 + 15, 12, h - 48);
      ctx.strokeStyle = "#b4b3a46b"; ctx.lineWidth = 1;
      for (let y = -h / 2 + 22; y < h / 2 - 24; y += 23) {
        ctx.beginPath(); ctx.moveTo(x + 4, y); ctx.lineTo(x + (w - 14) / bays - 6, y); ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = roof; ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h / 2 - 5);
    ctx.strokeStyle = "#d0b9937a"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-w / 2 + 7, 0); ctx.lineTo(w / 2 - 7, 0); ctx.stroke();
    ctx.strokeStyle = "#261f2352"; ctx.lineWidth = 1;
    for (let y = -h / 2 + 17; y < h / 2 - 20; y += 16) {
      ctx.beginPath(); ctx.moveTo(-w / 2 + 7, y); ctx.lineTo(w / 2 - 7, y); ctx.stroke();
    }
    if (kind === "apartment") {
      ctx.fillStyle = "#555d5c"; ctx.fillRect(-w * .27, -h * .22, w * .54, h * .42);
      ctx.strokeStyle = "#b4b2a3"; ctx.lineWidth = 2; ctx.strokeRect(-w * .27, -h * .22, w * .54, h * .42);
      ctx.fillStyle = "#8ca6a4"; ctx.fillRect(-w * .11, -h * .08, w * .22, h * .13);
    }
  }
  // Street-facing façade: individual windows and a door establish the metre
  // scale at chase zoom without floating text or per-frame decoration.
  ctx.fillStyle = stone; ctx.fillRect(-w / 2 + 4, h / 2 - 17, w - 8, 13);
  const windows = Math.max(2, Math.floor(w / 38));
  for (let i = 0; i < windows; i++) {
    const x = -w / 2 + (i + .5) * w / windows;
    ctx.fillStyle = "#303f45"; ctx.fillRect(x - 6, h / 2 - 14, 12, 6);
    ctx.fillStyle = "#c4b991"; ctx.fillRect(x - 1, h / 2 - 14, 2, 6);
  }
  ctx.fillStyle = "#3a3029"; ctx.fillRect(-7, h / 2 - 17, 14, 17);
  ctx.fillStyle = "#aaa18a"; ctx.fillRect(w * .26, -h * .31, 17, 21);
  ctx.fillStyle = "#333231"; ctx.fillRect(w * .26 + 3, -h * .31 + 3, 11, 12);
  if (kind === "tower" || kind === "timingTower" || kind === "civic") {
    ctx.fillStyle = "#556f68"; ctx.beginPath(); ctx.arc(0, -h * .03, Math.min(w,h) * .31, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#c6b787"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#e5d7a5"; ctx.beginPath(); ctx.arc(0, -h * .03, 6, 0, Math.PI * 2); ctx.fill();
    if(kind==="civic") {
      ctx.fillStyle="#c5bba2";ctx.fillRect(-w*.23,h/2-28,w*.46,26);
      ctx.fillStyle="#514d48";
      for(let i=-2;i<=2;i++)ctx.fillRect(i*w*.08-4,h/2-24,8,22);
      ctx.fillStyle="#d9c38c";ctx.fillRect(-9,-h*.30,18,8);
    }
  }
}
