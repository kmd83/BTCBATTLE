// ---------- Canvas setup ----------
const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');

// offscreen cached background texture (regenerated on resize, drawn every frame for cheap perf)
const groundCanvas = document.createElement('canvas');
const groundCtx = groundCanvas.getContext('2d');
let horizonY = 0;

// ---------- Battlefield background art (CraftPix free RPG battleground pack) ----------
// layered scene: distant sky+mountains, a castle wall with towers sitting at
// the horizon, and a wooden bridge/plank floor where the armies clash.
const BG_BASE = 'assets/bg/';
const BG_FILES = {
  sky: 'castle_sky.jpg',
  wall: 'castle_wall.png',
  ground: 'castle_bridge.jpg',
};
const BG_IMAGES = {};
let bgLoadTotal = 0;
let bgLoadDone = 0;
let bgReady = false;

function loadBgImages() {
  Object.keys(BG_FILES).forEach((key) => {
    bgLoadTotal++;
    const img = new Image();
    img.onload = () => { bgLoadDone++; checkBgReady(); };
    img.onerror = () => { bgLoadDone++; checkBgReady(); }; // don't hang forever on a missing file
    img.src = `${BG_BASE}${BG_FILES[key]}`;
    BG_IMAGES[key] = img;
  });
}
function checkBgReady() {
  if (bgLoadDone >= bgLoadTotal) {
    bgReady = true;
    generateGroundTexture(); // rebake the cached composite now that the art is available
  }
}
loadBgImages();

// draws `img` into the rect (dx,dy,dw,dh) using "cover" fit: scales uniformly
// so the rect is fully filled, cropping any overflow, centered on both axes
function drawCoverImage(g, img, dx, dy, dw, dh) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const ir = img.naturalWidth / img.naturalHeight;
  const tr = dw / dh;
  let sw, sh, sx, sy;
  if (ir > tr) {
    sh = img.naturalHeight;
    sw = sh * tr;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / tr;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  g.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// draws `img` scaled uniformly to exactly span width `w`, anchored so either
// its top or bottom edge lands on `edgeY` (used for the castle wall, which
// has transparent padding and shouldn't be stretched off-aspect)
function drawWidthAlignedImage(g, img, x, w, edgeY, anchor) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const scale = w / img.naturalWidth;
  const h = img.naturalHeight * scale;
  const y = anchor === 'bottom' ? edgeY - h : edgeY;
  g.drawImage(img, x, y, w, h);
}

// single source of truth for the horizon line's y-position, so combat layout
// (lanes/formations) and the background art always agree on where it is
function computeHorizon() {
  horizonY = window.innerHeight * 0.48;
}

// ---------- Mobile / small-screen responsiveness ----------
// desktop-width battlefields (>=1100px) use full-size spacing between the
// ~22 units per side; narrower viewports (phones/tablets) compact both the
// formation spacing AND the character size together, clamped so nothing
// shrinks into an unreadable blob or overlaps into a mess on a phone screen
let fieldScale = 1;
function computeFieldScale() {
  const W = window.innerWidth;
  fieldScale = Math.max(0.55, Math.min(1, W / 1100));
  UNIT_SIZE_MULT = 0.8 * (0.5 + 0.5 * fieldScale);
}

// devicePixelRatio is uncapped on some phones (2.5-3x), which would blow up
// the canvas to millions of extra pixels for no visible benefit and tank
// frame rate — cap it so mobile GPUs stay smooth
function resize() {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * DPR;
  canvas.height = window.innerHeight * DPR;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  computeFieldScale();
  computeHorizon(); // must run before layout, since formations/lanes clamp against it
  layoutArmies();
  layoutArchers();
  layoutMortars();
  computeLanes();
  generateGroundTexture();
}
window.addEventListener('resize', resize);
// mobile browsers can report stale innerWidth/innerHeight in the same tick
// an orientation change fires, before the chrome (address bar etc.) has
// finished reflowing — re-run resize a beat later to catch the settled size
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

// ---------- Config ----------
const TEAM = { LONG: 'long', SHORT: 'short' };
const COLORS = {
  long:  { body: '#2ecc40', dark: '#1a7a24', metal: '#c8f5c8' },
  short: { body: '#ff4136', dark: '#a11f18', metal: '#ffd6d3' },
};
const KNIGHTS_PER_SIDE = 14;
const N_LANES = 5;   // parallel meeting points near the center where duels happen
const MEET_GAP = 24; // how close (px, center-to-center) the two duelists stop from the centerline
const ARCHERS_PER_SIDE = 4; // backline ranged units, only triggered by bigger trades
const MORTARS_PER_SIDE = 1; // one small mortar per side, stationed just ahead of the gunners
const HORIZON_MARGIN = 90; // keep every unit's whole body (not just its feet) below the horizon line —
                            // large enough to clear a full-height knight sprite even at max combat scale,
                            // so units read as standing on the bridge deck instead of hovering near the wall
let UNIT_SIZE_MULT = 0.8; // -20% overall character size baseline (applies to sprite + procedural
                           // rendering); recomputed responsively per-screen-width by computeFieldScale()
const MAX_BATTLE_SHIFT = 130; // px the melee front line can push toward either side as one team dominates
const MAX_FORMATION_ADVANCE = 90; // px each army's whole formation pushes forward when winning / pulls back when losing

// ---------- Pirate sprites (CraftPix free pack) ----------
// Melee knights use the cutlass ATTACK animation. Ranged "archer" units get
// their own dedicated pistol-captain character (separate art), firing a
// bullet tracer instead of an arrow.
const SPRITE_STATES = ['IDLE', 'WALK', 'ATTACK', 'HURT', 'DIE'];
const SPRITE_FRAME_COUNT = 7;
const SPRITE_BASE = 'assets/';
const SPRITE_FOLDER = { long: 'pirate_buy', short: 'pirate_sell' };
// native pixel size of the exported frames (see manifest.json)
const SPRITE_NATIVE = {
  long: { w: 289, h: 220 },
  short: { w: 296, h: 220 },
};

// dedicated gunner (pistol) character used only by ranged Archer units
const SPRITE_FOLDER_ARCHER = { long: 'pirate_gunner_buy', short: 'pirate_gunner_sell' };
const SPRITE_NATIVE_ARCHER = {
  long: { w: 298, h: 220 },
  short: { w: 298, h: 220 },
};

const SPRITES = { long: {}, short: {} };
const SPRITES_ARCHER = { long: {}, short: {} };
let spriteLoadTotal = 0;
let spriteLoadDone = 0;
let spritesReady = false;

function loadSpriteSet(target, folderMap) {
  Object.keys(folderMap).forEach((team) => {
    const folder = folderMap[team];
    SPRITE_STATES.forEach((state) => {
      target[team][state] = [];
      for (let i = 0; i < SPRITE_FRAME_COUNT; i++) {
        spriteLoadTotal++;
        const img = new Image();
        img.onload = () => { spriteLoadDone++; checkSpritesReady(); };
        img.onerror = () => { spriteLoadDone++; checkSpritesReady(); }; // don't hang forever on a missing file
        img.src = `${SPRITE_BASE}${folder}/${state}_${i}.png`;
        target[team][state].push(img);
      }
    });
  });
}
function loadSprites() {
  loadSpriteSet(SPRITES, SPRITE_FOLDER);
  loadSpriteSet(SPRITES_ARCHER, SPRITE_FOLDER_ARCHER);
}
function checkSpritesReady() {
  if (spriteLoadDone >= spriteLoadTotal) spritesReady = true;
}
loadSprites();

// maps a Knight's combat state + timer to a {state, frame} sprite lookup
function spriteFrameForKnight(k) {
  const T = performance.now();
  const phase = k.bob * 260; // desyncs idle/walk loops between individual units
  switch (k.state) {
    case 'approach':
    case 'return':
      return { state: 'WALK', frame: Math.floor(((T + phase) / 90) % SPRITE_FRAME_COUNT) };
    case 'lunge':
      return { state: 'ATTACK', frame: Math.min(3, Math.floor(k.timer / 45)) };
    case 'clash':
      return { state: 'ATTACK', frame: Math.min(6, 4 + Math.floor(k.timer / 47)) };
    case 'die':
      if (k.timer < 150) return { state: 'HURT', frame: Math.min(6, Math.floor(k.timer / 21.4)) };
      return { state: 'DIE', frame: Math.min(6, Math.floor((k.timer - 150) / 50)) };
    case 'idle':
    case 'respawn':
    default:
      return { state: 'IDLE', frame: Math.floor(((T + phase) / 160) % SPRITE_FRAME_COUNT) };
  }
}

// maps an Archer's state + timer to a {state, frame} sprite lookup (reuses
// the same ATTACK animation: early frames = aiming, late frames = firing)
function spriteFrameForArcher(a) {
  const T = performance.now();
  const phase = a.bob * 260;
  switch (a.state) {
    case 'draw':
      return { state: 'ATTACK', frame: Math.min(3, Math.floor(a.timer / 75)) };
    case 'shoot':
      return { state: 'ATTACK', frame: Math.min(6, 4 + Math.floor(a.timer / 50)) };
    case 'idle':
    default:
      return { state: 'IDLE', frame: Math.floor(((T + phase) / 160) % SPRITE_FRAME_COUNT) };
  }
}

// ---------- Knight entity ----------
class Knight {
  constructor(team, row, col) {
    this.team = team;
    this.row = row;
    this.col = col;
    this.state = 'idle'; // idle, approach, lunge, clash, return, die, respawn
    this.timer = 0;
    this.scale = 1;
    this.bob = Math.random() * Math.PI * 2;
    this.baseX = 0; this.baseY = 0;
    this.meetX = 0; this.meetY = 0;
    this.x = 0; this.y = 0;
    this.opacity = 1;
    this.flash = 0;
    this.reserved = false; // true while an in-flight arrow/bullet is already targeting this knight
    this.wanderSeed = Math.random() * 1000; // offsets this knight's idle roaming so the whole line doesn't sway in sync
  }
}

// ---------- Archer entity (backline ranged unit) ----------
class Archer {
  constructor(team, index) {
    this.team = team;
    this.index = index;
    this.state = 'idle'; // idle, draw, shoot
    this.timer = 0;
    this.scale = 1;
    this.bob = Math.random() * Math.PI * 2;
    this.baseX = 0; this.baseY = 0;
    this.x = 0; this.y = 0;
    this.opacity = 1;
    this.flash = 0;
  }
}

// ---------- Mortar entity (single stationary siege unit per side) ----------
class Mortar {
  constructor(team, index) {
    this.team = team;
    this.index = index;
    this.state = 'idle'; // idle, aim, fire
    this.timer = 0;
    this.scale = 1;
    this.bob = Math.random() * Math.PI * 2;
    this.baseX = 0; this.baseY = 0;
    this.x = 0; this.y = 0;
    this.opacity = 1;
    this.flash = 0;
  }
}

let longKnights = [];
let shortKnights = [];
let longArchers = [];
let shortArchers = [];
let longMortars = [];
let shortMortars = [];
let longCannonGuards = []; // one sword-armed knight parked beside each mortar, purely decorative
let shortCannonGuards = [];
let arrows = [];
let mortarShells = []; // lobbed mortar projectiles, arc from launcher to target
let explosions = []; // brief blast burst drawn where a mortar shell lands
let souls = []; // little skull-with-a-tail spirits that float up from a fallen unit
let laneYs = [];
let laneBusy = new Array(N_LANES).fill(false);

// smooth horizontal "front line" shift: leans toward whichever side is
// currently dominating (more BTC bought vs sold), so sword duels drift
// visibly into the losing side's territory over time
let battleShiftX = 0;
let battleShiftTarget = 0;
// whole-formation advance/retreat: eases toward the same dominance value as
// battleShiftX, but pushes each army's *home* standing position (not just the
// duel meeting point) — the winning side's line creeps forward across the
// field, the losing side's line falls back, independent of any single duel.
let formationAdvance = 0;
let formationAdvanceTarget = 0;
function updateBattleShift(dt) {
  const total = longTotal + shortTotal;
  const advantage = total > 0 ? (longTotal - shortTotal) / total : 0; // -1 (short dominant) .. 1 (long dominant)
  battleShiftTarget = advantage * MAX_BATTLE_SHIFT;
  battleShiftX += (battleShiftTarget - battleShiftX) * Math.min(1, dt / 4000);
  formationAdvanceTarget = advantage * MAX_FORMATION_ADVANCE * fieldScale;
  formationAdvance += (formationAdvanceTarget - formationAdvance) * Math.min(1, dt / 3000);
}

function computeLanes() {
  const H = window.innerHeight;
  const centerY = H * 0.60;
  const spread = 64 * fieldScale; // duel lanes pack closer together on narrow screens
  const minY = horizonY + HORIZON_MARGIN; // never let a duel meeting point land above the horizon
  laneYs = [];
  for (let i = 0; i < N_LANES; i++) {
    const y = centerY - (spread * (N_LANES - 1)) / 2 + i * spread;
    laneYs.push(Math.max(minY, y));
  }
}

function findLane() {
  for (let i = 0; i < N_LANES; i++) if (!laneBusy[i]) return i;
  return Math.floor(Math.random() * N_LANES);
}

function layoutArmies() {
  const W = window.innerWidth, H = window.innerHeight;
  const centerY = H * 0.62;
  const rowGap = 46 * fieldScale;
  const colGap = 44 * fieldScale;
  const minY = horizonY + HORIZON_MARGIN; // formation rows never stand above the horizon

  longKnights.forEach((k) => {
    k.baseX = W * 0.08 + k.col * colGap;
    k.baseY = Math.max(minY, centerY - k.row * rowGap * 0.5 + (k.row % 2 === 0 ? 0 : rowGap * 0.25));
  });
  shortKnights.forEach((k) => {
    k.baseX = W * 0.92 - k.col * colGap;
    k.baseY = Math.max(minY, centerY - k.row * rowGap * 0.5 + (k.row % 2 === 0 ? 0 : rowGap * 0.25));
  });
}

function initArmies() {
  longKnights = [];
  shortKnights = [];
  const rows = 3;
  for (let i = 0; i < KNIGHTS_PER_SIDE; i++) {
    const row = i % rows;
    const col = Math.floor(i / rows);
    longKnights.push(new Knight(TEAM.LONG, row, col));
    shortKnights.push(new Knight(TEAM.SHORT, row, col));
  }
  layoutArmies();
}
initArmies();

// archers stand further back than the melee formation, one column behind
function layoutArchers() {
  const W = window.innerWidth, H = window.innerHeight;
  const centerY = H * 0.62;
  const rowGap = 40 * fieldScale;
  const minY = horizonY + HORIZON_MARGIN; // backline never stands above the horizon either

  longArchers.forEach((a) => {
    a.baseX = W * 0.055 + a.index * 6 * fieldScale;
    a.baseY = Math.max(minY, centerY - (a.index - (ARCHERS_PER_SIDE - 1) / 2) * rowGap * 1.4);
    a.x = a.baseX; a.y = a.baseY;
  });
  shortArchers.forEach((a) => {
    a.baseX = W * 0.945 - a.index * 6 * fieldScale;
    a.baseY = Math.max(minY, centerY - (a.index - (ARCHERS_PER_SIDE - 1) / 2) * rowGap * 1.4);
    a.x = a.baseX; a.y = a.baseY;
  });
}

function initArchers() {
  longArchers = [];
  shortArchers = [];
  for (let i = 0; i < ARCHERS_PER_SIDE; i++) {
    longArchers.push(new Archer(TEAM.LONG, i));
    shortArchers.push(new Archer(TEAM.SHORT, i));
  }
  layoutArchers();
}
initArchers();

// the mortar sits just ahead of the gunners (closer to the centerline than
// the archer backline) but still well behind the melee formation
function layoutMortars() {
  const W = window.innerWidth, H = window.innerHeight;
  const centerY = H * 0.62;
  const minY = horizonY + HORIZON_MARGIN; // mortar crew never stands above the horizon either

  longMortars.forEach((m) => {
    m.baseX = W * 0.09;
    m.baseY = Math.max(minY, centerY - 6);
    m.x = m.baseX; m.y = m.baseY;
  });
  shortMortars.forEach((m) => {
    m.baseX = W * 0.91;
    m.baseY = Math.max(minY, centerY - 6);
    m.x = m.baseX; m.y = m.baseY;
  });
  layoutCannonGuards();
}

function initMortars() {
  longMortars = [];
  shortMortars = [];
  for (let i = 0; i < MORTARS_PER_SIDE; i++) {
    longMortars.push(new Mortar(TEAM.LONG, i));
    shortMortars.push(new Mortar(TEAM.SHORT, i));
  }
  layoutMortars();
}
initMortars();

// each mortar keeps a single dedicated knight standing guard right beside it —
// reuses the Knight class/sprites/drawKnight so it looks identical to the
// melee troops, but it's parked outside longKnights/shortKnights so duels
// never pick it as a combatant. It idles beside the cannon and swings its
// sword the instant the cannon fires (see tryPlayMortarShot).
function layoutCannonGuards() {
  const dir = { [TEAM.LONG]: 1, [TEAM.SHORT]: -1 };
  longMortars.forEach((m, i) => {
    const g = longCannonGuards[i];
    if (!g) return;
    g.baseX = m.baseX + dir[TEAM.LONG] * 20 * fieldScale;
    g.baseY = m.baseY + 4 * fieldScale;
    if (g.state === 'idle') { g.x = g.baseX; g.y = g.baseY; }
  });
  shortMortars.forEach((m, i) => {
    const g = shortCannonGuards[i];
    if (!g) return;
    g.baseX = m.baseX + dir[TEAM.SHORT] * 20 * fieldScale;
    g.baseY = m.baseY + 4 * fieldScale;
    if (g.state === 'idle') { g.x = g.baseX; g.y = g.baseY; }
  });
}

function initCannonGuards() {
  longCannonGuards = [];
  shortCannonGuards = [];
  for (let i = 0; i < MORTARS_PER_SIDE; i++) {
    longCannonGuards.push(new Knight(TEAM.LONG, 0, 0));
    shortCannonGuards.push(new Knight(TEAM.SHORT, 0, 0));
  }
  layoutCannonGuards();
}
initCannonGuards();

// simplified knight update for the cannon guard: no duel lanes, no
// formation advance/retreat, no wander — it just idles in place and, when
// nudged into 'lunge'/'clash' by a cannon shot, plays the sword-swing
// animation before settling back into position.
function updateCannonGuard(k, dt) {
  k.bob += dt * 0.004;
  k.timer += dt;
  if (k.flash > 0) k.flash -= dt * 0.004;

  switch (k.state) {
    case 'idle':
      k.x += (k.baseX - k.x) * 0.15;
      k.y += (k.baseY - k.y) * 0.15;
      k.scale += (1 - k.scale) * 0.1;
      k.opacity += (1 - k.opacity) * 0.1;
      break;
    case 'lunge': {
      const dir = k.team === TEAM.LONG ? 1 : -1;
      const targetX = k.baseX + dir * 7;
      k.x += (targetX - k.x) * 0.35;
      if (k.timer > 130) { k.state = 'clash'; k.timer = 0; }
      break;
    }
    case 'clash':
      if (k.timer > 170) { k.state = 'idle'; k.timer = 0; }
      break;
  }
}

// ---------- Battlefield background (nature art, procedural fallback while it loads) ----------
function generateGroundTexture() {
  const W = window.innerWidth, H = window.innerHeight;
  horizonY = H * 0.48;
  const groundH = Math.max(1, H - horizonY);
  groundCanvas.width = W;
  groundCanvas.height = H;
  const g = groundCtx;
  g.clearRect(0, 0, W, H);

  if (bgReady) {
    // sky + distant mountains fill everything above the horizon
    drawCoverImage(g, BG_IMAGES.sky, 0, 0, W, horizonY);
    // castle wall + towers straddle the horizon: battlements above, stone
    // base rooted at the bridge deck
    drawWidthAlignedImage(g, BG_IMAGES.wall, 0, W, horizonY, 'bottom');
    // wooden bridge deck fills everything below the horizon — this is where the armies clash
    drawCoverImage(g, BG_IMAGES.ground, 0, horizonY, W, groundH);

    // battle-scorched patch across the middle, where the duels happen
    const pathY = horizonY + groundH * 0.4;
    const pathGrad = g.createRadialGradient(W / 2, pathY, 20, W / 2, pathY, W * 0.4);
    pathGrad.addColorStop(0, 'rgba(20,14,10,0.30)');
    pathGrad.addColorStop(1, 'rgba(20,14,10,0)');
    g.fillStyle = pathGrad;
    g.fillRect(0, horizonY, W, groundH);

    // gentle dusk wash so unit sprites/particles stay readable against the bright art
    g.fillStyle = 'rgba(8,16,8,0.22)';
    g.fillRect(0, 0, W, H);
    return;
  }

  // ---- procedural fallback while the background art is still loading ----
  // base gradient: hazy far edge -> rich near edge (depth cue)
  const base = g.createLinearGradient(0, horizonY, 0, H);
  base.addColorStop(0, '#28421f');
  base.addColorStop(0.35, '#1d3117');
  base.addColorStop(1, '#0d1a0a');
  g.fillStyle = base;
  g.fillRect(0, horizonY, W, groundH);

  // scattered grass tufts, smaller/duller near the horizon, taller/richer near the viewer
  const tuftCount = Math.floor((W * groundH) / 700);
  for (let i = 0; i < tuftCount; i++) {
    const ty = horizonY + Math.random() * groundH;
    const depth = (ty - horizonY) / groundH; // 0 = far, 1 = near
    const tx = Math.random() * W;
    const len = 3 + depth * 10 + Math.random() * 3;
    const g2 = 70 + Math.floor(depth * 90) + Math.floor(Math.random() * 25);
    g.strokeStyle = `rgb(${28 + g2 * 0.28},${55 + g2},${25 + g2 * 0.3})`;
    g.lineWidth = 1 + depth * 1.4;
    g.beginPath();
    g.moveTo(tx, ty);
    g.lineTo(tx + (Math.random() - 0.5) * 4, ty - len);
    g.stroke();
  }

  // trampled dirt battleground across the middle, where the duels happen
  const pathY = horizonY + groundH * 0.38;
  const pathGrad = g.createRadialGradient(W / 2, pathY, 20, W / 2, pathY, W * 0.4);
  pathGrad.addColorStop(0, 'rgba(96,68,40,0.55)');
  pathGrad.addColorStop(1, 'rgba(96,68,40,0)');
  g.fillStyle = pathGrad;
  g.fillRect(0, horizonY, W, groundH);

  // mist near the horizon for atmospheric depth
  const mist = g.createLinearGradient(0, horizonY, 0, horizonY + groundH * 0.3);
  mist.addColorStop(0, 'rgba(190,205,180,0.20)');
  mist.addColorStop(1, 'rgba(190,205,180,0)');
  g.fillStyle = mist;
  g.fillRect(0, horizonY, W, groundH * 0.3);

  // sky
  const sky = g.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, '#080c14');
  sky.addColorStop(0.65, '#131d2b');
  sky.addColorStop(1, '#22301c');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizonY);
}

function drawGround() {
  const W = window.innerWidth, H = window.innerHeight;

  // cached full-scene composite (sky/mountains/castle wall/bridge deck, or the
  // procedural fallback while the art loads)
  ctx.drawImage(groundCanvas, 0, 0);

  // faint centerline marking the front line (drifts with the battle shift)
  ctx.strokeStyle = 'rgba(244,211,94,0.12)';
  ctx.setLineDash([6, 10]);
  ctx.beginPath();
  ctx.moveTo(W / 2 + battleShiftX, horizonY);
  ctx.lineTo(W / 2 + battleShiftX, H);
  ctx.stroke();
  ctx.setLineDash([]);

  // vignette for depth/focus
  const vig = ctx.createRadialGradient(W / 2, H * 0.6, H * 0.2, W / 2, H * 0.6, H * 0.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

// ---------- Drawing ----------
// sprite-based renderer used once the pirate images are loaded; falls back to
// the fully procedural canvas drawing below until then (or if load fails)
function drawKnight(k) {
  if (!spritesReady) return drawKnightProcedural(k);

  const native = SPRITE_NATIVE[k.team];
  const flip = k.team === TEAM.LONG ? 1 : -1; // art faces left by default; mirror SHORT to face left toward the enemy
  const drawH = 78 * UNIT_SIZE_MULT * k.scale;
  const drawW = drawH * (native.w / native.h);
  const { state, frame } = spriteFrameForKnight(k);
  const img = SPRITES[k.team][state][frame];

  ctx.save();
  ctx.globalAlpha = k.opacity;
  ctx.translate(k.x, k.y);

  const bob = (k.state === 'idle' || k.state === 'approach') ? Math.sin(k.bob) * 2 : 0;
  ctx.translate(0, bob);

  ctx.scale(flip, 1);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, -drawW / 2, 24 - drawH, drawW, drawH);
  }
  ctx.restore(); // undo flip/bob, keep translate(k.x,k.y)

  // clash/hit flash spark, drawn in unflipped world space
  if (k.flash > 0) {
    ctx.save();
    ctx.globalAlpha = k.flash;
    ctx.translate(-flip * 16, -18);
    ctx.fillStyle = '#fff6c8';
    for (let a = 0; a < 6; a++) {
      ctx.save();
      ctx.rotate((a / 6) * Math.PI * 2);
      ctx.fillRect(-1, 0, 2, 10);
      ctx.restore();
    }
    ctx.restore();
  }

  ctx.restore();
}

function drawKnightProcedural(k) {
  const c = COLORS[k.team];
  const facing = k.team === TEAM.LONG ? 1 : -1; // 1 = faces right, -1 = faces left

  ctx.save();
  ctx.globalAlpha = k.opacity;
  ctx.translate(k.x, k.y);
  ctx.scale(facing * k.scale * UNIT_SIZE_MULT, k.scale * UNIT_SIZE_MULT);

  const bob = (k.state === 'idle' || k.state === 'approach') ? Math.sin(k.bob) * 2 : 0;
  ctx.translate(0, bob);

  // legs
  ctx.fillStyle = c.dark;
  ctx.fillRect(-7, 6, 5, 16);
  ctx.fillRect(2, 6, 5, 16);

  // body
  ctx.fillStyle = c.body;
  ctx.fillRect(-9, -14, 18, 22);

  // belt
  ctx.fillStyle = c.dark;
  ctx.fillRect(-9, 4, 18, 3);

  // shield arm (back side, opposite of sword)
  ctx.fillStyle = c.dark;
  ctx.beginPath();
  ctx.ellipse(-10, -2, 5, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.fillStyle = c.metal;
  ctx.beginPath();
  ctx.arc(0, -20, 8, 0, Math.PI * 2);
  ctx.fill();

  // helmet plume
  ctx.fillStyle = c.dark;
  ctx.fillRect(-1.5, -30, 3, 8);

  // visor slit
  ctx.fillStyle = '#111';
  ctx.fillRect(-5, -21, 10, 2);

  // sword arm + sword
  let swordAngle = -0.5; // resting / marching angle
  if (k.state === 'lunge') swordAngle = -1.4 + Math.sin(k.timer * 0.06) * 0.5;
  if (k.state === 'clash') swordAngle = -2.1;

  ctx.save();
  ctx.translate(8, -8);
  ctx.rotate(swordAngle);
  // arm
  ctx.fillStyle = c.body;
  ctx.fillRect(-2, -2, 4, 10);
  // blade
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(-1.5, -26, 3, 24);
  ctx.fillStyle = '#bfbfbf';
  ctx.fillRect(-1.5, -26, 3, 4);
  // hilt
  ctx.fillStyle = '#8a6d3b';
  ctx.fillRect(-4, -2, 8, 3);
  ctx.restore();

  // clash flash spark
  if (k.flash > 0) {
    ctx.save();
    ctx.globalAlpha = k.flash;
    ctx.translate(14, -14);
    ctx.fillStyle = '#fff6c8';
    for (let a = 0; a < 6; a++) {
      ctx.save();
      ctx.rotate((a / 6) * Math.PI * 2);
      ctx.fillRect(-1, 0, 2, 10);
      ctx.restore();
    }
    ctx.restore();
  }

  ctx.restore();
}

// ---------- Archer drawing (dedicated pistol-captain character) ----------
function drawArcher(a) {
  if (!spritesReady) return drawArcherProcedural(a);

  const native = SPRITE_NATIVE_ARCHER[a.team];
  const flip = a.team === TEAM.LONG ? 1 : -1;
  const drawH = 70 * UNIT_SIZE_MULT * a.scale; // slightly smaller than melee, sits further back
  const drawW = drawH * (native.w / native.h);
  const { state, frame } = spriteFrameForArcher(a);
  const img = SPRITES_ARCHER[a.team][state][frame];

  ctx.save();
  ctx.globalAlpha = a.opacity;
  ctx.translate(a.x, a.y);

  const bob = a.state === 'idle' ? Math.sin(a.bob) * 2 : 0;
  ctx.translate(0, bob);

  ctx.scale(flip, 1);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, -drawW / 2, 24 - drawH, drawW, drawH);
  }
  ctx.restore();

  // muzzle flash on release
  if (a.flash > 0) {
    ctx.save();
    ctx.globalAlpha = a.flash;
    ctx.translate(-flip * 22, -8);
    ctx.fillStyle = '#fff6c8';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function drawArcherProcedural(a) {
  const c = COLORS[a.team];
  const facing = a.team === TEAM.LONG ? 1 : -1;

  ctx.save();
  ctx.globalAlpha = a.opacity;
  ctx.translate(a.x, a.y);
  ctx.scale(facing * a.scale * UNIT_SIZE_MULT, a.scale * UNIT_SIZE_MULT);

  const bob = a.state === 'idle' ? Math.sin(a.bob) * 2 : 0;
  ctx.translate(0, bob);

  // legs
  ctx.fillStyle = c.dark;
  ctx.fillRect(-6, 6, 5, 15);
  ctx.fillRect(2, 6, 5, 15);

  // body (slimmer hooded silhouette)
  ctx.fillStyle = c.body;
  ctx.fillRect(-8, -13, 16, 20);

  // hood/head
  ctx.fillStyle = c.metal;
  ctx.beginPath();
  ctx.arc(0, -19, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.dark;
  ctx.beginPath();
  ctx.arc(0, -21, 7, Math.PI, Math.PI * 2);
  ctx.fill();

  // bow draw amount: 0 = relaxed, 1 = fully drawn
  let draw = 0;
  if (a.state === 'draw') draw = Math.min(1, a.timer / 300);
  if (a.state === 'shoot') draw = Math.max(0, 1 - a.timer / 150);

  ctx.save();
  ctx.translate(9, -6);
  ctx.strokeStyle = c.dark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 12, -1.1, 1.1);
  ctx.stroke();

  // string, pulled back proportional to draw amount
  const stringX = -3 - draw * 8;
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.cos(-1.1) * 12, Math.sin(-1.1) * 12);
  ctx.lineTo(stringX, 0);
  ctx.lineTo(Math.cos(1.1) * 12, Math.sin(1.1) * 12);
  ctx.stroke();

  // nocked arrow while drawing/releasing
  if (draw > 0) {
    ctx.strokeStyle = '#e8c98a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(stringX, 0);
    ctx.lineTo(stringX - 14, 0);
    ctx.stroke();
  }
  ctx.restore();

  // release flash
  if (a.flash > 0) {
    ctx.save();
    ctx.globalAlpha = a.flash;
    ctx.translate(20, -6);
    ctx.fillStyle = '#fff6c8';
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function updateArcher(a, dt) {
  a.bob += dt * 0.004;
  a.timer += dt;
  if (a.flash > 0) a.flash -= dt * 0.005;

  switch (a.state) {
    case 'idle':
      a.x += (a.baseX - a.x) * 0.12;
      a.y += (a.baseY - a.y) * 0.12;
      a.scale += (1 - a.scale) * 0.1;
      a.opacity += (1 - a.opacity) * 0.1;
      break;
    case 'draw':
      // holds position while nocking/drawing the bow (visual only, via a.timer)
      break;
    case 'shoot':
      if (a.timer > 150) {
        a.state = 'idle';
        a.timer = 0;
      }
      break;
  }
}

// ---------- Mortar drawing (small siege piece stationed ahead of the gunners) ----------
function drawMortar(m) {
  const c = COLORS[m.team];
  const facing = m.team === TEAM.LONG ? 1 : -1;

  ctx.save();
  ctx.globalAlpha = m.opacity;
  ctx.translate(m.x, m.y);
  // negated facing: the carriage/barrel art was drawn pointing the wrong
  // way, so mirror the whole assembly 180° horizontally to aim at the enemy
  ctx.scale(-facing * m.scale * UNIT_SIZE_MULT, m.scale * UNIT_SIZE_MULT);

  // recoil kick on fire
  const recoil = m.state === 'fire' ? Math.max(0, 1 - m.timer / 140) * 5 : 0;
  ctx.translate(-recoil, 0);

  // wheels
  ctx.fillStyle = '#3b2a1a';
  ctx.beginPath(); ctx.arc(-6, 14, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(7, 14, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1c130b';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(-6, 14, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(7, 14, 7, 0, Math.PI * 2); ctx.stroke();

  // wooden carriage base
  ctx.fillStyle = '#5a3d22';
  ctx.fillRect(-11, 6, 22, 8);

  // barrel, tilted up toward the enemy side
  ctx.save();
  ctx.translate(2, 4);
  ctx.rotate(-0.95);
  ctx.fillStyle = c.dark;
  ctx.fillRect(-5, -22, 10, 24);
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.ellipse(0, -22, 5.5, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // team-color trim band
  ctx.fillStyle = c.body;
  ctx.fillRect(-5, -4, 10, 4);
  ctx.restore();

  // muzzle flash + smoke puff on fire
  if (m.flash > 0) {
    ctx.save();
    ctx.globalAlpha = m.flash;
    ctx.translate(-6, -26);
    ctx.fillStyle = '#fff2b0';
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(180,180,180,0.6)';
    ctx.beginPath();
    ctx.arc(-4, -6, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function updateMortar(m, dt) {
  m.bob += dt * 0.004;
  m.timer += dt;
  if (m.flash > 0) m.flash -= dt * 0.004;

  switch (m.state) {
    case 'idle':
      m.x += (m.baseX - m.x) * 0.12;
      m.y += (m.baseY - m.y) * 0.12;
      m.scale += (1 - m.scale) * 0.1;
      m.opacity += (1 - m.opacity) * 0.1;
      break;
    case 'aim':
      // holds position while the crew raises/loads the barrel (visual only, via m.timer)
      break;
    case 'fire':
      if (m.timer > 260) {
        m.state = 'idle';
        m.timer = 0;
      }
      break;
  }
}

// ---------- Mortar shells (lobbed, arcing projectiles with an explosive landing) ----------
function updateMortarShells(dt) {
  for (let i = mortarShells.length - 1; i >= 0; i--) {
    const sh = mortarShells[i];
    sh.t += dt / sh.duration;
    if (sh.t >= 1) {
      const target = sh.target;
      target.state = 'die';
      target.timer = 0;
      target.flash = 1;
      target.reserved = false;
      spawnSoul(target.x, target.y);
      spawnExplosion(target.x, target.y);
      shakeAmount = Math.max(shakeAmount, 5);
      requestAnimationFrame(applyShake);
      mortarShells.splice(i, 1);
    }
  }
}

function drawMortarShells() {
  mortarShells.forEach((sh) => {
    const t = Math.min(1, sh.t);
    const tx = sh.target.x, ty = sh.target.y;
    const x = sh.fromX + (tx - sh.fromX) * t;
    const y = sh.fromY + (ty - sh.fromY) * t - Math.sin(t * Math.PI) * sh.arcHeight;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 10); // tumbling spin as it flies

    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#1c1c1c';
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // lit fuse spark
    ctx.fillStyle = '#ffb84d';
    ctx.beginPath();
    ctx.arc(2.5, -2.5, 1.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
}

// ---------- Explosions (brief blast burst where a mortar shell lands) ----------
function spawnExplosion(x, y) {
  explosions.push({ x, y, t: 0, duration: 420 });
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    explosions[i].t += dt / explosions[i].duration;
    if (explosions[i].t >= 1) explosions.splice(i, 1);
  }
}

function drawExplosions() {
  explosions.forEach((e) => {
    const t = e.t;
    const r = 6 + t * 32;
    const op = Math.max(0, 1 - t);
    if (op <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = op;
    ctx.translate(e.x, e.y);

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, 'rgba(255,230,150,0.9)');
    grad.addColorStop(0.5, 'rgba(255,140,40,0.55)');
    grad.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // radiating shard lines
    ctx.strokeStyle = `rgba(255,210,120,${op * 0.8})`;
    ctx.lineWidth = 2;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r * 0.3, Math.sin(ang) * r * 0.3);
      ctx.lineTo(Math.cos(ang) * r * 0.9, Math.sin(ang) * r * 0.9);
      ctx.stroke();
    }

    ctx.restore();
  });
}

// ---------- Arrow projectiles ----------
function updateArrows(dt) {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const ar = arrows[i];
    ar.t += dt / ar.duration;
    if (ar.t >= 1) {
      const target = ar.target;
      target.state = 'die';
      target.timer = 0;
      target.flash = 1;
      target.reserved = false;
      spawnSoul(target.x, target.y);
      arrows.splice(i, 1);
    }
  }
}

// pistol shots fly flat and fast, with a short bright tracer + fading trail
// (kept the "arrows"/"arrows" naming internally since it's the same queue/logic
// as the original bow concept, just re-skinned as a bullet)
function drawArrows() {
  arrows.forEach((ar) => {
    const t = Math.min(1, ar.t);
    const tx = ar.target.x, ty = ar.target.y;
    const x = ar.fromX + (tx - ar.fromX) * t;
    const y = ar.fromY + (ty - ar.fromY) * t;
    const angle = Math.atan2(ty - ar.fromY, tx - ar.fromX);
    const dist = Math.hypot(tx - ar.fromX, ty - ar.fromY);
    const trailLen = Math.min(24, dist * t);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // short fading tracer trail behind the bullet
    const grad = ctx.createLinearGradient(-trailLen, 0, 0, 0);
    grad.addColorStop(0, 'rgba(255,225,140,0)');
    grad.addColorStop(1, 'rgba(255,245,200,0.85)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-trailLen, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();

    // round bullet, with a soft glow so it reads clearly against the field
    ctx.shadowColor = 'rgba(255,235,170,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#fffbe6';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#c9a227';
    ctx.beginPath();
    ctx.arc(0.4, 0.4, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ---------- Departing souls (a little semi-transparent skull-with-a-tail
// that drifts up and fades out from wherever a unit just fell) ----------
function spawnSoul(x, y) {
  souls.push({
    x,
    y,
    t: 0,
    duration: 1500 + Math.random() * 400,
    sway: (Math.random() - 0.5) * 24,
    phase: Math.random() * Math.PI * 2,
  });
}

function updateSouls(dt) {
  for (let i = souls.length - 1; i >= 0; i--) {
    souls[i].t += dt / souls[i].duration;
    if (souls[i].t >= 1) souls.splice(i, 1);
  }
}

function drawSouls() {
  souls.forEach((s) => {
    const t = s.t;
    const rise = 68 * t; // drifts upward as it fades
    const x = s.x + Math.sin(t * Math.PI * 2 + s.phase) * (s.sway * t);
    const y = s.y - 14 - rise;

    // fade in quickly, hold, then fade out over the back half of its life
    const fade = t < 0.12 ? t / 0.12 : t > 0.6 ? Math.max(0, 1 - (t - 0.6) / 0.4) : 1;
    const op = fade * 0.7;
    if (op <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = op;
    ctx.translate(x, y);

    // wispy little tail trailing beneath the skull
    ctx.strokeStyle = 'rgba(210,235,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2.5, 6.5);
    ctx.quadraticCurveTo(-6 + Math.sin(t * 9) * 2.5, 13, -1, 18);
    ctx.quadraticCurveTo(4 + Math.sin(t * 9 + 1.4) * 2.5, 13.5, 2.5, 7.5);
    ctx.stroke();

    // soft glow behind the skull
    ctx.shadowColor = 'rgba(200,230,255,0.85)';
    ctx.shadowBlur = 7;

    // skull cranium + jaw
    ctx.fillStyle = 'rgba(248,251,255,0.92)';
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, Math.PI, 0, false);
    ctx.lineTo(5.5, 4.5);
    ctx.quadraticCurveTo(0, 9, -5.5, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    // eye sockets
    ctx.fillStyle = 'rgba(15,20,30,0.85)';
    ctx.beginPath();
    ctx.ellipse(-2.8, -0.8, 1.5, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(2.8, -0.8, 1.5, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // nose notch
    ctx.beginPath();
    ctx.moveTo(0, 1.3);
    ctx.lineTo(-1.1, 3.2);
    ctx.lineTo(1.1, 3.2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  });
}

// ---------- Animation / combat loop ----------
function updateKnight(k, dt) {
  k.bob += dt * 0.004;
  k.timer += dt;
  if (k.flash > 0) k.flash -= dt * 0.004;

  switch (k.state) {
    case 'idle': {
      // knights don't freeze on a fixed formation line: the whole army eases
      // toward its home column offset by the current formationAdvance (pushed
      // forward across the field while winning, pulled back while losing),
      // plus a slow per-knight wander so the line reads as living/roaming
      // rather than a rigid grid.
      const wx = Math.sin(k.bob * 0.6 + k.wanderSeed) * 10 * fieldScale;
      const wy = Math.cos(k.bob * 0.45 + k.wanderSeed) * 6 * fieldScale;
      const targetX = k.baseX + formationAdvance + wx;
      const targetY = k.baseY + wy;
      k.x += (targetX - k.x) * 0.06;
      k.y += (targetY - k.y) * 0.06;
      k.scale += (1 - k.scale) * 0.1;
      k.opacity += (1 - k.opacity) * 0.1;
      break;
    }
    case 'approach':
      // walk from formation toward the meeting point at the centerline; the
      // transition to 'lunge'/'clash' is driven externally by playDuel's timers
      // so both combatants arrive together.
      k.x += (k.meetX - k.x) * 0.09;
      k.y += (k.meetY - k.y) * 0.09;
      break;
    case 'lunge': {
      const dir = k.team === TEAM.LONG ? 1 : -1;
      const targetX = k.meetX + dir * 9;
      k.x += (targetX - k.x) * 0.3;
      break;
    }
    case 'clash':
      if (k.timer > 140) {
        // the winner heads back into formation (which itself may now be
        // advancing into what used to be the meeting point, if their side
        // keeps winning) instead of freezing at the exact clash spot
        k.state = 'idle';
        k.timer = 0;
      }
      break;
    case 'return': {
      const targetX = k.baseX + formationAdvance;
      k.x += (targetX - k.x) * 0.15;
      k.y += (k.baseY - k.y) * 0.15;
      if (Math.hypot(targetX - k.x, k.baseY - k.y) < 2) {
        k.state = 'idle';
      }
      break;
    }
    case 'die':
      // stay down in the fallen pose for a full 2s so the kill actually
      // reads on screen, then fade out quickly right before respawning
      if (k.timer < 1700) {
        k.scale += (1 - k.scale) * 0.15;
        k.opacity += (1 - k.opacity) * 0.15;
      } else {
        k.opacity += (0 - k.opacity) * 0.18;
      }
      if (k.timer > 2000) {
        k.state = 'respawn';
        k.timer = 0;
        k.scale = 0;
        k.opacity = 0;
      }
      break;
    case 'respawn':
      k.x = k.baseX + formationAdvance;
      k.y = k.baseY;
      if (k.timer > 400 + Math.random() * 500) {
        k.state = 'idle';
      }
      break;
  }
}

function frame(t) {
  const dt = frame.last ? t - frame.last : 16;
  frame.last = t;

  const W = window.innerWidth, H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);
  updateBattleShift(dt);
  drawGround();

  [...longKnights, ...shortKnights].forEach((k) => updateKnight(k, dt));
  [...longArchers, ...shortArchers].forEach((a) => updateArcher(a, dt));
  [...longMortars, ...shortMortars].forEach((m) => updateMortar(m, dt));
  [...longCannonGuards, ...shortCannonGuards].forEach((k) => updateCannonGuard(k, dt));
  updateArrows(dt);
  updateMortarShells(dt);
  updateExplosions(dt);
  updateSouls(dt);

  const all = [...longKnights, ...shortKnights, ...longArchers, ...shortArchers, ...longMortars, ...shortMortars, ...longCannonGuards, ...shortCannonGuards].sort((a, b) => a.y - b.y);
  all.forEach((e) => {
    if (e instanceof Archer) drawArcher(e);
    else if (e instanceof Mortar) drawMortar(e);
    else drawKnight(e);
  });

  drawArrows();
  drawMortarShells();
  drawSouls();
  drawExplosions();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Combat trigger ----------
// only ever returns a unit that is truly free (idle/return AND not already
// reserved as someone's in-flight arrow/bullet target) — never grabs a unit
// mid-animation, so nothing already walking/fighting ever gets yanked around
function pickCombatant(list, preferredStates) {
  for (const state of preferredStates) {
    const matches = list.filter((k) => k.state === state && !k.reserved);
    if (matches.length) return matches[Math.floor(Math.random() * matches.length)];
  }
  return null;
}

// events that couldn't find free units are queued here and retried on every
// tick below, instead of being dropped or forced onto a busy unit — this is
// what keeps the battle flowing continuously as slots free up
let pendingDuels = [];
let pendingShots = [];
let pendingMortarShots = [];

function playDuel(winnerTeam, magnitude) {
  if (!tryPlayDuel(winnerTeam, magnitude)) {
    pendingDuels.push({ winnerTeam, magnitude });
  }
}

function tryPlayDuel(winnerTeam, magnitude) {
  const winners = winnerTeam === TEAM.LONG ? longKnights : shortKnights;
  const losers = winnerTeam === TEAM.LONG ? shortKnights : longKnights;

  const attacker = pickCombatant(winners, ['idle', 'return']);
  const defender = pickCombatant(losers, ['idle', 'return']);
  if (!attacker || !defender) return false;

  const lane = findLane();
  laneBusy[lane] = true;
  const meetY = laneYs[lane] ?? window.innerHeight * 0.6;
  // the meeting point drifts toward whichever side is currently dominating
  // (more BTC bought vs sold), so the melee line visibly pushes into the
  // losing side's territory as the imbalance grows
  const centerX = window.innerWidth / 2 + battleShiftX;
  const dirAtk = attacker.team === TEAM.LONG ? 1 : -1;
  const dirDef = defender.team === TEAM.LONG ? 1 : -1;

  attacker.state = 'approach';
  attacker.timer = 0;
  attacker.meetX = centerX - dirAtk * MEET_GAP;
  attacker.meetY = meetY;
  attacker.scale = 1 + Math.min(magnitude * 0.3, 0.5);

  defender.state = 'approach';
  defender.timer = 0;
  defender.meetX = centerX - dirDef * MEET_GAP;
  defender.meetY = meetY;
  defender.scale = 1;

  // instead of a fixed timer, poll until both combatants have actually
  // arrived at the meeting point (or a safety cap trips) — guarantees a
  // smooth, uninterrupted walk with no snapping/teleporting on arrival
  const ARRIVE_DIST = 4;
  const SAFETY_MS = 1600;
  const startedAt = performance.now();

  const arrivalCheck = setInterval(() => {
    if (attacker.state !== 'approach' || defender.state !== 'approach') {
      // one of them got reset externally (shouldn't happen now, but stay safe)
      clearInterval(arrivalCheck);
      laneBusy[lane] = false;
      return;
    }
    const elapsed = performance.now() - startedAt;
    const attackerHere = Math.hypot(attacker.meetX - attacker.x, attacker.meetY - attacker.y) < ARRIVE_DIST;
    const defenderHere = Math.hypot(defender.meetX - defender.x, defender.meetY - defender.y) < ARRIVE_DIST;
    if (!((attackerHere && defenderHere) || elapsed > SAFETY_MS)) return;

    clearInterval(arrivalCheck);
    attacker.state = 'lunge';
    attacker.timer = 0;

    setTimeout(() => {
      defender.state = 'die';
      defender.timer = 0;
      defender.flash = 1;
      spawnSoul(defender.x, defender.y);
      attacker.state = 'clash';
      attacker.timer = 0;
      attacker.flash = 1;

      setTimeout(() => {
        laneBusy[lane] = false;
      }, 200);
    }, 180);
  }, 40);

  return true;
}

// ranged attack, only triggered by larger trades (ARCHER_THRESHOLD_BTC): a
// gunner on the winning side aims and fires a pistol shot at a distant enemy,
// instead of the two sides walking together for a melee clash
function playArcherShot(winnerTeam, magnitude) {
  if (!tryPlayArcherShot(winnerTeam, magnitude)) {
    pendingShots.push({ winnerTeam, magnitude });
  }
}

function tryPlayArcherShot(winnerTeam, magnitude) {
  const archers = winnerTeam === TEAM.LONG ? longArchers : shortArchers;
  const losers = winnerTeam === TEAM.LONG ? shortKnights : longKnights;

  const archer = pickCombatant(archers, ['idle']);
  const target = pickCombatant(losers, ['idle', 'return']);
  if (!archer || !target) return false;

  archer.state = 'draw';
  archer.timer = 0;
  archer.scale = 1 + Math.min(magnitude * 0.25, 0.4);
  target.reserved = true; // lock the target so a melee duel can't also claim it mid-flight

  const DRAW_MS = 300;
  setTimeout(() => {
    archer.state = 'shoot';
    archer.timer = 0;
    archer.flash = 1;

    const dir = archer.team === TEAM.LONG ? 1 : -1;
    arrows.push({
      team: archer.team,
      fromX: archer.x + dir * 20,
      fromY: archer.y - 6,
      target,
      t: 0,
      duration: 260, // pistol shot: fast, flat trajectory
    });
  }, DRAW_MS);

  return true;
}

// siege attack, only triggered by the biggest trades (MORTAR_THRESHOLD_BTC):
// the mortar on the winning side aims and lobs a shell at a distant enemy,
// landing in a small explosion instead of a straight-line shot
function playMortarShot(winnerTeam, magnitude) {
  if (!tryPlayMortarShot(winnerTeam, magnitude)) {
    pendingMortarShots.push({ winnerTeam, magnitude });
  }
}

function tryPlayMortarShot(winnerTeam, magnitude) {
  const mortars = winnerTeam === TEAM.LONG ? longMortars : shortMortars;
  const losers = winnerTeam === TEAM.LONG ? shortKnights : longKnights;

  const mortar = pickCombatant(mortars, ['idle']);
  const target = pickCombatant(losers, ['idle', 'return']);
  if (!mortar || !target) return false;

  mortar.state = 'aim';
  mortar.timer = 0;
  mortar.scale = 1 + Math.min(magnitude * 0.3, 0.5);
  target.reserved = true; // lock the target so a melee duel can't also claim it mid-flight

  const AIM_MS = 420;
  setTimeout(() => {
    mortar.state = 'fire';
    mortar.timer = 0;
    mortar.flash = 1;

    // the guard standing beside this cannon swings his sword the instant it fires
    const guards = mortar.team === TEAM.LONG ? longCannonGuards : shortCannonGuards;
    const guard = guards[mortar.index];
    if (guard) { guard.state = 'lunge'; guard.timer = 0; }

    const dir = mortar.team === TEAM.LONG ? 1 : -1;
    const dist = Math.hypot(target.x - mortar.x, target.y - mortar.y);
    mortarShells.push({
      team: mortar.team,
      fromX: mortar.x + dir * 16,
      fromY: mortar.y - 30,
      target,
      t: 0,
      duration: 620, // slow lobbed arc, much longer hang time than a pistol shot
      arcHeight: 70 + Math.min(90, dist * 0.18),
    });
  }, AIM_MS);

  return true;
}

// retry queued duels/shots as units free up, so bursts of trades resolve as
// a continuous flowing battle instead of dropping events on the floor
setInterval(() => {
  if (pendingDuels.length && tryPlayDuel(pendingDuels[0].winnerTeam, pendingDuels[0].magnitude)) {
    pendingDuels.shift();
  }
  if (pendingShots.length && tryPlayArcherShot(pendingShots[0].winnerTeam, pendingShots[0].magnitude)) {
    pendingShots.shift();
  }
  if (pendingMortarShots.length && tryPlayMortarShot(pendingMortarShots[0].winnerTeam, pendingMortarShots[0].magnitude)) {
    pendingMortarShots.shift();
  }
  // don't let a huge burst pile up forever into an unresolvable backlog
  if (pendingDuels.length > 30) pendingDuels.length = 30;
  if (pendingShots.length > 15) pendingShots.length = 15;
  if (pendingMortarShots.length > 10) pendingMortarShots.length = 10;
}, 150);

// screen shake for big trades
let shakeAmount = 0;
function applyShake() {
  if (shakeAmount <= 0) return;
  const dx = (Math.random() - 0.5) * shakeAmount;
  const dy = (Math.random() - 0.5) * shakeAmount;
  canvas.style.transform = `translate(${dx}px, ${dy}px)`;
  shakeAmount *= 0.85;
  if (shakeAmount > 0.2) requestAnimationFrame(applyShake);
  else canvas.style.transform = '';
}

// ---------- HUD + ticker ----------
const longTotalEl = document.getElementById('longTotal');
const shortTotalEl = document.getElementById('shortTotal');
const tickerLineEl = document.getElementById('tickerLine');
const priceRowEl = document.getElementById('priceRow');
const statusEl = document.getElementById('status');

let longTotal = 0;
let shortTotal = 0;

function fmtUsd(v) {
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return '$' + (v / 1_000).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function bumpHud(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function fmtBtc(v) {
  return v.toFixed(4) + ' BTC';
}

// single-line ticker: replaces its own text on every trade instead of stacking
// cards, so it never grows tall enough to cover the battlefield
let tickerPulseTimer = null;
function pushTick(side, type, amountBtc, amountUsd) {
  const icon = type === 'archer' ? ' \u{1F3F9}' : type === 'mortar' ? ' \u{1F4A3}' : '';
  const label = (side === 'long' ? 'BUY' : 'SELL') + icon;
  const fontSize = Math.min(9 + Math.log10(1 + amountUsd) * 3, 23); // halved vs before
  tickerLineEl.style.fontSize = fontSize + 'px';
  tickerLineEl.className = 'ticker-line ' + side;
  tickerLineEl.textContent = `${label}  ${fmtBtc(amountBtc)}  ${fmtUsd(amountUsd)}`;

  // restart the pulse animation
  clearTimeout(tickerPulseTimer);
  tickerLineEl.classList.remove('pulse');
  void tickerLineEl.offsetWidth;
  tickerLineEl.classList.add('pulse');
}

// current BTC price display, colored green/red by last move direction,
// throttled so rapid trades don't thrash the DOM
let latestPrice = null;
let displayedPrice = null;
function fmtPrice(v) {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
setInterval(() => {
  if (latestPrice == null) return;
  const up = displayedPrice == null || latestPrice >= displayedPrice;
  priceRowEl.textContent = 'BTC/USDT  ' + fmtPrice(latestPrice);
  priceRowEl.classList.toggle('price-up', latestPrice !== displayedPrice && up);
  priceRowEl.classList.toggle('price-down', latestPrice !== displayedPrice && !up);
  displayedPrice = latestPrice;
}, 300);

// side: true = buy (green wins), false = sell (red wins)
function handleTrade(type, isBuy, amountBtc, amountUsd) {
  const magnitude = Math.log10(1 + amountUsd) / 6;
  const winnerTeam = isBuy ? TEAM.LONG : TEAM.SHORT;

  if (isBuy) {
    longTotal += amountUsd;
    longTotalEl.textContent = fmtUsd(longTotal);
    bumpHud(longTotalEl);
    pushTick('long', type, amountBtc, amountUsd);
  } else {
    shortTotal += amountUsd;
    shortTotalEl.textContent = fmtUsd(shortTotal);
    bumpHud(shortTotalEl);
    pushTick('short', type, amountBtc, amountUsd);
  }

  if (type === 'archer') {
    playArcherShot(winnerTeam, magnitude);
  } else if (type === 'mortar') {
    playMortarShot(winnerTeam, magnitude);
  } else {
    playDuel(winnerTeam, magnitude);
  }

  if (amountUsd > 20000) {
    shakeAmount = Math.min(10, amountUsd / 8000);
    requestAnimationFrame(applyShake);
  }
}

// ---------- Data feed (Binance Futures BTCUSDT real trades) ----------
// Two redundant sources, deduplicated by aggTrade id:
//  1) WebSocket (instant, but can be blocked by some ISPs/firewalls/regions)
//  2) REST polling fallback (kicks in automatically if the WS goes quiet)
const WS_URL = 'wss://fstream.binance.com/ws/btcusdt@aggTrade';
const REST_URL = 'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT';
const THRESHOLD_BTC = 1.0;        // every 1.0 BTC bought/sold triggers one melee (cutlass) duel
const ARCHER_THRESHOLD_BTC = 2.0; // every 2.0 BTC bought/sold triggers one pistol shot
const MORTAR_THRESHOLD_BTC = 3.0; // every 3.0 BTC bought/sold triggers one mortar shell (min step size)

let ws;
let queue = [];
let reconnectDelay = 1000;
let buyAccum = 0;
let sellAccum = 0;
let mortarBuyAccum = 0;
let mortarSellAccum = 0;
let archerBuyAccum = 0;
let archerSellAccum = 0;
let lastAggId = 0;
let lastMessageAt = 0;
let wsConnected = false;
let restPolling = false;

function ingestTrade(aggId, price, qty, isBuy) {
  if (aggId <= lastAggId) return; // dedupe (already processed via the other source)
  lastAggId = aggId;
  lastMessageAt = Date.now();
  latestPrice = price;

  // sword duels: every THRESHOLD_BTC of buy/sell volume
  if (isBuy) buyAccum += qty; else sellAccum += qty;
  let accum = isBuy ? buyAccum : sellAccum;
  const units = Math.floor(accum / THRESHOLD_BTC);
  if (units > 0) {
    const consumedBtc = units * THRESHOLD_BTC;
    if (isBuy) buyAccum -= consumedBtc; else sellAccum -= consumedBtc;

    if (units <= 3) {
      for (let i = 0; i < units; i++) {
        queue.push({ type: 'sword', isBuy, amountBtc: THRESHOLD_BTC, amountUsd: THRESHOLD_BTC * price });
      }
    } else {
      queue.push({ type: 'sword', isBuy, amountBtc: consumedBtc, amountUsd: consumedBtc * price });
    }
  }

  // archer shots: rarer, bigger trades (every ARCHER_THRESHOLD_BTC)
  if (isBuy) archerBuyAccum += qty; else archerSellAccum += qty;
  let archerAccum = isBuy ? archerBuyAccum : archerSellAccum;
  const archerUnits = Math.floor(archerAccum / ARCHER_THRESHOLD_BTC);
  if (archerUnits > 0) {
    const consumedBtc = archerUnits * ARCHER_THRESHOLD_BTC;
    if (isBuy) archerBuyAccum -= consumedBtc; else archerSellAccum -= consumedBtc;
    queue.push({ type: 'archer', isBuy, amountBtc: consumedBtc, amountUsd: consumedBtc * price });
  }

  // mortar shells: rarest, biggest trades (every MORTAR_THRESHOLD_BTC, minimum step of 3.0 BTC)
  if (isBuy) mortarBuyAccum += qty; else mortarSellAccum += qty;
  let mortarAccum = isBuy ? mortarBuyAccum : mortarSellAccum;
  const mortarUnits = Math.floor(mortarAccum / MORTAR_THRESHOLD_BTC);
  if (mortarUnits > 0) {
    const consumedBtc = mortarUnits * MORTAR_THRESHOLD_BTC;
    if (isBuy) mortarBuyAccum -= consumedBtc; else mortarSellAccum -= consumedBtc;
    queue.push({ type: 'mortar', isBuy, amountBtc: consumedBtc, amountUsd: consumedBtc * price });
  }
}

function updateStatus() {
  const mode = wsConnected ? 'WebSocket' : (restPolling ? 'REST polling (fallback)' : 'connecting…');
  statusEl.textContent = `live · ${mode} · BTC/USDT`;
}

function connectWS() {
  statusEl.textContent = 'connecting…';
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.error('WS create failed', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    reconnectDelay = 1000;
    updateStatus();
  };

  ws.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      if (!ev || ev.e !== 'aggTrade') return;
      wsConnected = true;
      updateStatus();
      const isBuy = ev.m === false; // taker bought (m=false: buyer is not the maker)
      ingestTrade(Number(ev.a), parseFloat(ev.p), parseFloat(ev.q), isBuy);
    } catch (e) {
      console.error('WS parse error', e);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateStatus();
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
    wsConnected = false;
    updateStatus();
    ws.close();
  };
}

function scheduleReconnect() {
  setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
}

async function pollRestOnce() {
  try {
    const url = lastAggId > 0 ? `${REST_URL}&fromId=${lastAggId + 1}&limit=1000` : `${REST_URL}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const trades = await res.json();
    trades.forEach((t) => {
      const isBuy = t.m === false;
      ingestTrade(Number(t.a), parseFloat(t.p), parseFloat(t.q), isBuy);
    });
    restPolling = true;
    updateStatus();
  } catch (e) {
    console.error('REST poll error', e);
  }
}

// Watchdog: if no message arrives for 4s (WS blocked / failing), fall back to REST polling.
setInterval(() => {
  const quiet = Date.now() - lastMessageAt > 4000;
  if (quiet && !restPolling) {
    pollRestOnce(); // kicks restPolling into gear; interval below keeps it going
  }
}, 2000);

setInterval(() => {
  if (restPolling) pollRestOnce();
}, 800);

connectWS();

// process queue at a steady visual pace so bursts don't overwhelm the animation
setInterval(() => {
  if (queue.length === 0) return;
  const batchSize = queue.length > 20 ? 4 : 1;
  const batch = queue.splice(0, batchSize);
  batch.forEach((item) => handleTrade(item.type, item.isBuy, item.amountBtc, item.amountUsd));
}, 120);

// ---------- background music toggle ----------
// autoplay-with-sound is blocked by browsers until a user gesture, so the
// track only starts/stops via this button click.
(function setupMusicToggle() {
  const btn = document.getElementById('musicToggle');
  const audio = document.getElementById('bgMusic');
  if (!btn || !audio) return;
  audio.volume = 0.35;
  let playing = false;
  btn.addEventListener('click', () => {
    if (playing) {
      audio.pause();
      btn.textContent = '🔇';
      btn.classList.remove('playing');
      playing = false;
    } else {
      audio.play().then(() => {
        btn.textContent = '🔊';
        btn.classList.add('playing');
        playing = true;
      }).catch(() => {}); // ignore if blocked; user can click again
    }
  });
})();

// ---------- init ----------
resize();
