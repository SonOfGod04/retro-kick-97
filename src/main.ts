import Phaser from 'phaser';
import './style.css';

// ═══════════════ CONSTANTS ═══════════════
const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_TIME_SECONDS = 60;
const CENTER_X = FIELD_W / 2;
const CENTER_Y = FIELD_H / 2;
const LINE = 19;
const GOAL_HALF = 52;
const GOAL_HEIGHT = 40;          // crossbar height in ball-height units
const BOX_DEPTH = 137;
const BOX_HALF_H = 125;
const PENALTY_SPOT_X = 112;
const SECOND_SPOT_X = 235;
const FOUL_LIMIT = 5;
const FOUR_SECONDS = 4;
const CONTACT_RADIUS = 12;
const SHADOW_DY = 6;

// Goalkeeper physics
const E_MAX = 34;                // max dive extension (total hand reach = E_MAX + 8 = 42 px)
const MIN_DIVE_LEAD = 0.165;     // minimum time (after reaction) needed to complete a dive
const HOLD_T = 0.14;             // time the keeper holds full extension
const FALL_T = 0.32;             // time lying on the ground
const RECOVER_T = 0.45;          // time to get back up
const HAND_R = 11;               // hand/glove contact radius (includes ball radius)
const Z_WIN = 11;                // vertical tolerance around hand height
const BODY_R = 11;               // body/legs contact radius
const GK_PREDICT_ERR = 6;        // px of misjudgement in the keeper's read of a shot

type TeamSide = 'home' | 'away';
type GameState = 'playing' | 'restart' | 'goal' | 'fulltime';
type RestartKind =
  | 'kickoff' | 'kick-in' | 'corner' | 'goal-clearance'
  | 'free-kick' | 'indirect-free-kick' | 'penalty' | 'second-penalty';
type ActionType = 'pass' | 'shoot' | 'throw' | 'tackle' | 'jump' | 'miss';
type SaveType = 'stand' | 'jump' | 'dive-low' | 'dive-high' | 'stretch';
type GkMode = 'ready' | 'diving' | 'fallen' | 'recovering' | 'concede';
type AnimName =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'turn' | 'celebrate' | ActionType
  | 'gk-ready' | 'gk-shuffle' | 'dive-low' | 'dive-high' | 'stretch' | 'jump-save'
  | 'catch' | 'parry' | 'fall' | 'recover' | 'concede';

interface Pt { x: number; y: number }
interface Sample { t: number; x: number; y: number; z: number }
interface RestartSpec { kind: RestartKind; team: TeamSide; x: number; y: number }
interface OutOfPlay { kind: 'goal' | 'kick-in' | 'corner' | 'goal-clearance'; team: TeamSide; x: number; y: number }

interface Kit {
  jersey: number; jerseyDark: number; shorts: number; socks: number; boots: number;
  skin: number; skinShade: number; hair: number; glove: number; longSleeves: boolean;
}
interface Action { type: ActionType; t: number; dur: number; aim?: number }
interface Gait { legAmp: number; armAmp: number; lean: number; elbowIn: number; cycle: number; stance: number }

interface SavePlan {
  type: SaveType;
  dirX: number; dirY: number;    // world direction of the dive
  ext: number;                   // dive extension (px)
  zTarget: number;               // hand height the keeper aims for
  startAt: number;               // seconds after the plan was made
  arrive: number;                // when the ball is expected at the intercept point
  guess: boolean;                // penalty guess (not a read of the ball)
  reachable: boolean;
}

interface GkBrain {
  mode: GkMode;
  t: number;                     // time in current mode
  clock: number;                 // time since the current plan was made
  plan: SavePlan | null;
  react: number;
  origX: number; origY: number;  // position when the dive began
  extNow: number; zNow: number;  // current hand extension / height (used for collision AND drawing)
  result: 'none' | 'catch' | 'parry' | 'block';
  flickT: number;                // time left showing a catch / parry pose
  contactCool: number;
  planTouchId: number;
}

interface Footballer {
  sprite: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Arc;
  rig: Phaser.GameObjects.Graphics;
  shadow: Phaser.GameObjects.Ellipse;
  label: Phaser.GameObjects.Text;
  side: TeamSide;
  role: 'GK' | 'DEF' | 'MID' | 'FWD';
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  number: number;
  cooldown: number;
  celebrating: boolean;
  celebrateUntil: number;
  facing: number;
  kit: Kit;
  vis: number;
  stride: number;
  speed: number;
  lastX: number;
  lastY: number;
  anim: AnimName;
  act: Action | null;
  gk: GkBrain | null;            // goalkeeper brain (null for outfield players)
}

interface Particle {
  obj: Phaser.GameObjects.Shape;
  vx: number; vy: number; life: number; maxLife: number;
}

interface Restart extends RestartSpec {
  taker: Footballer;
  targets: Map<Footballer, Pt>;
  elapsed: number;
  ready: boolean;
  timer: number;
  cpuDelay: number;
  aim: number;
  power: number;
  charging: boolean;
  lofted: boolean;
  baseMsg: string;
}

const RESTART_INFO: Record<RestartKind, {
  label: string; min: number; max: number; lift: number; indirect: boolean; limit: number | null;
}> = {
  'kickoff':            { label: 'KICK-OFF',       min: 110, max: 260, lift: 5,  indirect: false, limit: null },
  'kick-in':            { label: 'KICK-IN',        min: 140, max: 330, lift: 10, indirect: true,  limit: FOUR_SECONDS },
  'corner':             { label: 'CORNER',         min: 200, max: 480, lift: 40, indirect: false, limit: FOUR_SECONDS },
  'goal-clearance':     { label: 'GK CLEARANCE',   min: 160, max: 380, lift: 25, indirect: true,  limit: FOUR_SECONDS },
  'free-kick':          { label: 'FREE KICK',      min: 220, max: 470, lift: 30, indirect: false, limit: FOUR_SECONDS },
  'indirect-free-kick': { label: 'INDIRECT FK',    min: 220, max: 470, lift: 30, indirect: true,  limit: FOUR_SECONDS },
  'penalty':            { label: 'PENALTY',        min: 260, max: 500, lift: 20, indirect: false, limit: null },
  'second-penalty':     { label: '10m FREE KICK',  min: 260, max: 500, lift: 20, indirect: false, limit: null },
};

// ═══════════════ ANIMATION DATA (Phase 2) ═══════════════

const ACTIONS: Record<ActionType, { dur: number; start: number }> = {
  pass:   { dur: 0.34, start: 0.2 },
  shoot:  { dur: 0.45, start: 0.3 },
  throw:  { dur: 0.40, start: 0.15 },
  tackle: { dur: 0.40, start: 0 },
  jump:   { dur: 0.50, start: 0 },
  miss:   { dur: 1.20, start: 0 },
};

const KF = {
  passFoot:    [[0, 0], [0.3, -6], [0.55, 11], [1, 0]],
  shootFoot:   [[0, 0], [0.4, -11], [0.6, 15], [0.8, 10], [1, 0]],
  shootLean:   [[0, 0], [0.4, -1], [0.6, 3.5], [1, 0.5]],
  tackleSlide: [[0, 0], [0.35, 9], [0.8, 9], [1, 0]],
  throwHand:   [[0, -3], [0.3, -7], [0.55, 12], [1, 2]],
  throwLean:   [[0, 0], [0.3, -1.2], [0.55, 2.5], [1, 0]],
};

const GAIT_TABLE: number[][] = [
  [0,   0,    0,   0,   0,   40, 4.0],
  [70,  4.5,  3.5, 0,   0.5, 34, 3.6],
  [150, 7.5,  6.0, 1.5, 2.0, 46, 3.2],
  [200, 8.5,  7.0, 2.2, 2.8, 50, 3.0],
  [260, 10.5, 8.5, 3.6, 3.8, 56, 2.8],
];
const GAIT_TMP: Gait = { legAmp: 0, armAmp: 0, lean: 0, elbowIn: 0, cycle: 40, stance: 4 };

function keyframe(t: number, keys: number[][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

function gaitFor(speed: number, out: Gait): Gait {
  const s = Math.max(0, speed);
  let i = 0;
  while (i < GAIT_TABLE.length - 2 && s > GAIT_TABLE[i + 1][0]) i++;
  const a = GAIT_TABLE[i];
  const b = GAIT_TABLE[i + 1];
  const t = Phaser.Math.Clamp((s - a[0]) / (b[0] - a[0]), 0, 1);
  const l = (k: number) => a[k] + (b[k] - a[k]) * t;
  out.legAmp = l(1); out.armAmp = l(2); out.lean = l(3);
  out.elbowIn = l(4); out.cycle = l(5); out.stance = l(6);
  return out;
}

function classifyLocomotion(speed: number): 'idle' | 'walk' | 'run' | 'sprint' {
  if (speed < 25) return 'idle';
  if (speed < 95) return 'walk';
  if (speed < 225) return 'run';
  return 'sprint';
}

const SKINS: number[][] = [[0xf4c892, 0xd9a877], [0xd9a066, 0xb98048], [0x8d5a3b, 0x6e4328], [0x5b3a29, 0x452b1e]];
const HAIRS: number[] = [0x2a1810, 0x111111, 0x3a2418, 0x6b4a2b];

function makeKit(side: TeamSide, role: Footballer['role'], number: number): Kit {
  const isGK = role === 'GK';
  const [skin, skinShade] = SKINS[(number * 3 + (side === 'home' ? 0 : 2)) % SKINS.length];
  const hair = HAIRS[(number + (side === 'home' ? 1 : 3)) % HAIRS.length];
  if (isGK) {
    return {
      jersey: side === 'home' ? 0x9b59b6 : 0xff9800,
      jerseyDark: side === 'home' ? 0x6c3483 : 0xc77700,
      shorts: 0x333333, socks: 0x333333, boots: 0x111111,
      skin, skinShade, hair, glove: 0xffe14d, longSleeves: true,
    };
  }
  return {
    jersey: side === 'home' ? 0x2d7fff : 0xff3b47,
    jerseyDark: side === 'home' ? 0x0a4fb5 : 0xb01822,
    shorts: side === 'home' ? 0x0a4fb5 : 0xb01822,
    socks: 0xffffff, boots: 0x161616,
    skin, skinShade, hair, glove: skin, longSleeves: false,
  };
}

// ═══════════════ PURE RULE FUNCTIONS (Phase 1) ═══════════════
const other = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');
const teamName = (s: TeamSide): string => (s === 'home' ? 'Rockets' : 'Comets');
const dist = Phaser.Math.Distance.Between;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (u: number): number => 1 - (1 - u) * (1 - u);
const clampPt = (x: number, y: number): Pt => ({
  x: Phaser.Math.Clamp(x, 31, FIELD_W - 31),
  y: Phaser.Math.Clamp(y, 31, FIELD_H - 31),
});

function cornerSpec(attacker: TeamSide, ballY: number): RestartSpec {
  return {
    kind: 'corner', team: attacker,
    x: attacker === 'home' ? FIELD_W - 22 : 22,
    y: ballY < CENTER_Y ? 22 : FIELD_H - 22,
  };
}

function clearanceSpec(defender: TeamSide): RestartSpec {
  return { kind: 'goal-clearance', team: defender, x: defender === 'home' ? 55 : FIELD_W - 55, y: CENTER_Y };
}

/** Out-of-play decision. z = ball height: a ball over the crossbar is not a goal. */
function decideOutOfPlay(x: number, y: number, lastTouch: TeamSide, z = 0): OutOfPlay | null {
  const onLeft = x < LINE;
  const onRight = x > FIELD_W - LINE;
  if (onLeft || onRight) {
    const defender: TeamSide = onLeft ? 'home' : 'away';
    const attacker = other(defender);
    if (Math.abs(y - CENTER_Y) <= GOAL_HALF && z <= GOAL_HEIGHT) return { kind: 'goal', team: attacker, x, y };
    if (lastTouch === defender) {
      const c = cornerSpec(attacker, y);
      return { kind: 'corner', team: attacker, x: c.x, y: c.y };
    }
    const g = clearanceSpec(defender);
    return { kind: 'goal-clearance', team: defender, x: g.x, y: g.y };
  }
  if (y < LINE || y > FIELD_H - LINE) {
    return {
      kind: 'kick-in', team: other(lastTouch),
      x: Phaser.Math.Clamp(x, 40, FIELD_W - 40),
      y: y < LINE ? 24 : FIELD_H - 24,
    };
  }
  return null;
}

function decideFoul(fouler: TeamSide, victimX: number, victimY: number, foulNumber: number): RestartSpec {
  const fouled = other(fouler);
  const inOwnBox =
    (fouler === 'home' ? victimX < BOX_DEPTH : victimX > FIELD_W - BOX_DEPTH) &&
    Math.abs(victimY - CENTER_Y) < BOX_HALF_H;
  if (inOwnBox) {
    return { kind: 'penalty', team: fouled, x: fouled === 'home' ? FIELD_W - PENALTY_SPOT_X : PENALTY_SPOT_X, y: CENTER_Y };
  }
  if (foulNumber > FOUL_LIMIT) {
    const fartherThanSpot = fouler === 'home' ? victimX > SECOND_SPOT_X : victimX < FIELD_W - SECOND_SPOT_X;
    if (fartherThanSpot) {
      return { kind: 'second-penalty', team: fouled, x: fouled === 'home' ? FIELD_W - SECOND_SPOT_X : SECOND_SPOT_X, y: CENTER_Y };
    }
  }
  const p = clampPt(victimX, victimY);
  return { kind: 'free-kick', team: fouled, x: p.x, y: p.y };
}

// ═══════════════ PURE GOALKEEPER LOGIC (Phase 3) ═══════════════

const DIVE_T: Record<SaveType, number> = { stand: 0, jump: 0.34, 'dive-low': 0.28, 'dive-high': 0.30, stretch: 0.32 };

/** Lift (initial vertical speed) for a shot. Low = driven along the ground; high = aimed to arrive at 24–34 height. */
function shotLiftFor(speed: number, distance: number, high: boolean): number {
  if (!high) return Phaser.Math.Between(10, 40);
  const T = Math.max(0.12, distance / (speed * 0.92));
  const zt = Phaser.Math.Between(24, 34);
  return Phaser.Math.Clamp((zt + 200 * T * T) / T, 40, 300);
}

/** How far off the goal line the keeper stands for a given ball distance from goal centre (narrows the angle in range). */
function keeperDepth(d: number): number {
  if (d >= 420) return 70;
  if (d >= 250) return 82 - ((d - 250) / 170) * 12;
  if (d >= 120) return 56 + ((d - 120) / 130) * 26;
  return 46 + (d / 120) * 10;
}

/** Keeper's ideal position: on the line from goal centre to the ball (angle bisector approximation). */
function keeperTarget(side: TeamSide, ballX: number, ballY: number): Pt {
  const dirIn = side === 'home' ? 1 : -1;
  const goalX = side === 'home' ? LINE : FIELD_W - LINE;
  const vx = ballX - goalX;
  const vy = ballY - CENTER_Y;
  const d = Math.hypot(vx, vy);
  if (d < 1) return { x: goalX + dirIn * 46, y: CENTER_Y };
  const s = keeperDepth(d);
  let x = goalX + (vx / d) * s;
  const y = Phaser.Math.Clamp(CENTER_Y + (vy / d) * s, CENTER_Y - (GOAL_HALF - 10), CENTER_Y + (GOAL_HALF - 10));
  x = dirIn === 1 ? Phaser.Math.Clamp(x, goalX + 24, goalX + 92) : Phaser.Math.Clamp(x, goalX - 92, goalX - 24);
  return { x, y };
}

/**
 * Decide how the keeper will try to save a predicted shot. Pure: depends only on the trajectory,
 * the keeper's position and his reaction time.
 */
function chooseSave(
  kx: number, ky: number, dirIn: number, samples: Sample[], react: number, err: { y: number; z: number }
): SavePlan | null {
  if (!samples.length) return null;
  const goalLine = dirIn === 1 ? LINE : FIELD_W - LINE;
  const behind = (x: number): boolean => (dirIn === 1 ? x < goalLine : x > goalLine);

  let best: Sample | null = null;
  let bestD = Infinity;
  for (const s of samples) {
    if (behind(s.x)) continue;
    if (s.t - react < MIN_DIVE_LEAD) continue;           // not enough time to get 
    const d = Math.hypot(s.x - kx, s.y - ky);
    if (d < bestD) { bestD = d; best = s; }
  }
  let reachable = best !== null && bestD - 8 <= E_MAX;
  let target: Sample;
  if (best) {
    target = best;
  } else {
    const inside = samples.filter((s) => !behind(s.x));
    target = inside.length ? inside[inside.length - 1] : samples[0];
    reachable = false;
  }

  const ty = target.y + err.y;
  const tz = Phaser.Math.Clamp(target.z + err.z, 2, 44);
  const dx = target.x - kx;
  const dy = ty - ky;
  const d = Math.hypot(dx, dy);
  const E = Phaser.Math.Clamp(d - 8, 0, E_MAX);
  const dirX = d < 1 ? 0 : dx / d;
  const dirY = d < 1 ? 1 : dy / d;

  let type: SaveType;
  if (E < 4) type = tz <= 33 ? 'stand' : 'jump';
  else if (E > 26) type = 'stretch';
  else type = tz <= 16 ? 'dive-low' : 'dive-high';

  const startAt = type === 'stand' ? 0 : Math.max(react, target.t - DIVE_T[type] * 0.9);
  return {
    type, dirX, dirY, ext: type === 'stand' || type === 'jump' ? 0 : E,
    zTarget: type === 'jump' ? Math.min(tz + 2, 44) : tz,
    startAt, arrive: target.t, guess: false, reachable,
  };
}

/** What happens when the ball meets the keeper's hands. */
function resolveSaveContact(speed: number, quality: number, z: number): 'catch' | 'parry' | 'tip-over' {
  if (speed <= 240) return 'catch';
  if (speed <= 300 && quality >= 0.35) return 'catch';
  return z > 30 ? 'tip-over' : 'parry';
}

/** Run with ?selftest in the URL — logs the Phase 1 + 2 + 3 pure-logic tests. */
function runSelfTests(): void {
  const results: [string, boolean][] = [];
  const t = (name: string, ok: boolean) => results.push([name, ok]);
  // ── Phase 1
  const a = decideOutOfPlay(450, 10, 'home');
  t('P1 Home last touch over touchline -> AWAY kick-in', a?.kind === 'kick-in' && a.team === 'away');
  const b = decideOutOfPlay(450, 510, 'away');
  t('P1 Away last touch over touchline -> HOME kick-in', b?.kind === 'kick-in' && b.team === 'home');
  const c = decideOutOfPlay(10, 100, 'home');
  t('P1 Home defender last touch, own goal line -> AWAY corner', c?.kind === 'corner' && c.team === 'away' && c.x < 100 && c.y < CENTER_Y);
  const d = decideOutOfPlay(10, 100, 'away');
  t('P1 Away attacker last touch, home goal line -> HOME GK clearance', d?.kind === 'goal-clearance' && d.team === 'home');
  const e = decideOutOfPlay(890, 400, 'away');
  t('P1 Away defender last touch, own goal line -> HOME corner', e?.kind === 'corner' && e.team === 'home' && e.x > 800 && e.y > CENTER_Y);
  const f = decideOutOfPlay(890, 400, 'home');
  t('P1 Home attacker last touch, away goal line -> AWAY GK clearance', f?.kind === 'goal-clearance' && f.team === 'away');
  t('P1 Left goal mouth -> goal for AWAY', decideOutOfPlay(10, 260, 'home')?.team === 'away');
  t('P1 Right goal mouth -> goal for HOME', decideOutOfPlay(890, 260, 'away')?.team === 'home');
  t('P1 Ball in play -> no decision', decideOutOfPlay(450, 260, 'home') === null);
  const g = decideFoul('home', 500, 260, 1);
  t('P1 Home foul midfield -> AWAY free kick', g.kind === 'free-kick' && g.team === 'away');
  const h = decideFoul('home', 60, 260, 1);
  t('P1 Home foul in own box -> AWAY penalty', h.kind === 'penalty' && h.team === 'away' && h.x === PENALTY_SPOT_X);
  const i = decideFoul('away', 800, 260, 1);
  t('P1 Away foul in own box -> HOME penalty', i.kind === 'penalty' && i.team === 'home' && i.x === FIELD_W - PENALTY_SPOT_X);
  const j = decideFoul('home', 500, 260, 6);
  t('P1 6th accumulated foul -> 10m free kick to AWAY', j.kind === 'second-penalty' && j.team === 'away' && j.x === SECOND_SPOT_X);
  t('P1 Away foul -> restart for HOME', decideFoul('away', 400, 260, 3).team === 'home');
  // ── Phase 2
  t('P2 classify 0 -> idle', classifyLocomotion(0) === 'idle');
  t('P2 classify 60 -> walk', classifyLocomotion(60) === 'walk');
  t('P2 classify 190 -> run', classifyLocomotion(190) === 'run');
  t('P2 classify 260 -> sprint', classifyLocomotion(260) === 'sprint');
  const gi = gaitFor(0, { ...GAIT_TMP }), gw = gaitFor(70, { ...GAIT_TMP }),
    gr = gaitFor(190, { ...GAIT_TMP }), gs = gaitFor(260, { ...GAIT_TMP });
  t('P2 leg swing grows idle < walk < run < sprint', gi.legAmp === 0 && gw.legAmp > gi.legAmp && gr.legAmp > gw.legAmp && gs.legAmp > gr.legAmp);
  t('P2 sprint leans more and has longer stride than run', gs.lean > gr.lean && gs.cycle > gr.cycle);
  t('P2 sprint bends elbows more than run', gs.elbowIn > gr.elbowIn);
  t('P2 shoot backswing behind body, strike ahead', keyframe(0.4, KF.shootFoot) < -10 && keyframe(0.6, KF.shootFoot) > 14);
  t('P2 pass and shoot use different leg motion', keyframe(0.55, KF.passFoot) !== keyframe(0.55, KF.shootFoot));
  t('P2 shoot swings farther than pass', keyframe(0.6, KF.shootFoot) > keyframe(0.55, KF.passFoot));
  // ── Phase 3
  // A shot travelling at 400 px/s toward the home goal (keeper dirIn = +1), lateral offset `lat`, height `z`.
  const shot = (lat: number, z: number, t0 = 0.05): Sample[] => {
    const out: Sample[] = [];
    for (let n = 0; ; n++) {
      const tt = t0 + n / 60;
      const x = 400 - 400 * tt;
      if (x < LINE) break;
      out.push({ t: tt, x, y: CENTER_Y + lat, z });
    }
    return out;
  };
  const noErr = { y: 0, z: 0 };
  const plan = (lat: number, z: number) => chooseSave(67, CENTER_Y, 1, shot(lat, z), 0.15, noErr);
  const pLowL = plan(-30, 4), pLowR = plan(30, 4), pHighR = plan(30, 30), pHighL = plan(-30, 30);
  t('P3 low shot to one side -> low dive that way', pLowL?.type === 'dive-low' && pLowL.dirY < 0);
  t('P3 low shot to the other side -> low dive that way', pLowR?.type === 'dive-low' && pLowR.dirY > 0);
  t('P3 high shot -> high dive (both directions)', pHighR?.type === 'dive-high' && pHighR.dirY > 0 && pHighL?.type === 'dive-high' && pHighL.dirY < 0);
  t('P3 high shot at the keeper -> vertical jump', plan(0, 40)?.type === 'jump');
  t('P3 low shot at the keeper -> stand', plan(0, 4)?.type === 'stand');
  const far = plan(52, 4);
  t('P3 far-corner shot -> full stretch, reach capped (impossible saves prevented)', far?.type === 'stretch' && far.ext <= E_MAX && far.reachable === false);
  const late: Sample[] = [];
  for (let n = 0; ; n++) { const x = 90 - 400 * (n / 60); if (x < LINE) break; late.push({ t: n / 60, x, y: CENTER_Y + 30, z: 4 }); }
  t('P3 shot arriving before the keeper can react -> unreachable', chooseSave(67, CENTER_Y, 1, late, 0.15, noErr)?.reachable === false);
  t('P3 slow central shot is caught', resolveSaveContact(200, 0.2, 10) === 'catch');
  t('P3 firm shot with good contact is caught', resolveSaveContact(280, 0.6, 10) === 'catch');
  t('P3 hard shot is parried', resolveSaveContact(420, 0.9, 10) === 'parry');
  t('P3 hard high shot is tipped over', resolveSaveContact(420, 0.9, 36) === 'tip-over');
  t('P3 keeper narrows the angle in shooting range', keeperDepth(250) > keeperDepth(700) && keeperDepth(250) >= 42 && keeperDepth(250) <= 92);
  const kt = keeperTarget('home', 300, 120);
  t('P3 keeper shifts toward the ball side but stays in the goal mouth', kt.y < CENTER_Y && kt.y >= CENTER_Y - GOAL_HALF && kt.x >= LINE + 24);
  t('P3 high shot lift > low shot lift', shotLiftFor(400, 300, true) > 100 && shotLiftFor(400, 300, false) <= 40);
  t('P3 ball over the crossbar is not a goal (-> goal clearance)', decideOutOfPlay(890, 260, 'home', 60)?.kind === 'goal-clearance');
  t('P3 ball under the crossbar is a goal', decideOutOfPlay(890, 260, 'home', 10)?.kind === 'goal');
  const failed = results.filter((r) => !r[1]);
  results.forEach(([n, ok]) => console.log(`${ok ? '✅' : '❌'} ${n}`));
  console.log(failed.length === 0 ? `SELF-TEST: all ${results.length} passed` : `SELF-TEST: ${failed.length} FAILED`);
}

// Keeper pose output (local space: +x facing, +y right)
interface GkPose {
  fLx: number; fLy: number; fRx: number; fRy: number;
  hLx: number; hLy: number; hRx: number; hRy: number;
  lean: number; scale: number; shadow: number; handR: number; elbowOut: number;
  liftL: number; liftR: number; free: boolean;
  capsule?: { dx: number; dy: number; half: number };
  head?: Pt;
}

// ═══════════════ SCENE ═══════════════
class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ball!: Phaser.GameObjects.Arc;           // invisible logic anchor (ground position)
  private ballVis!: Phaser.GameObjects.Arc;        // what you see (raised by ball height)
  private ballInner!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private ballHeight = 0;
  private ballVz = 0;
  private ballVx = 0;
  private ballVy = 0;
  private ballSpin = 0;
  private possession: TeamSide | null = 'home';
  private lastTouch: TeamSide = 'home';
  private touchId = 0;
  private controlled!: Footballer;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private homeScore = 0;
  private awayScore = 0;
  private remaining = HALF_SECONDS;
  private clockAcc = 0;
  private half = 1;
  private paused = true;
  private pauseKeyHeld = false;
  private ended = false;
  private kickoffLock = 0;
  private state: GameState = 'restart';
  private goalScored = false;
  private message = 'Ready for kick-off';
  private openingKickoff: TeamSide = 'home';

  private restart: Restart | null = null;
  private indirectPending: { team: TeamSide; taker: Footballer } | null = null;
  private foulCount: Record<TeamSide, number> = { home: 0, away: 0 };
  private gkHolder: Footballer | null = null;
  private gkHoldTimer = 0;
  private goalTimer?: Phaser.Time.TimerEvent;
  private restartLabel!: Phaser.GameObjects.Text;
  private aimGfx!: Phaser.GameObjects.Graphics;

  private shooter: Footballer | null = null;
  private shooterUntil = 0;

  private goalText!: Phaser.GameObjects.Text;
  private goalSubText!: Phaser.GameObjects.Text;
  private goalFlash!: Phaser.GameObjects.Rectangle;
  private particles: Particle[] = [];
  private cameraShake = 0;
  private hint!: HTMLElement | null;
  private homeScoreEl!: HTMLElement | null;
  private awayScoreEl!: HTMLElement | null;
  private clockEl!: HTMLElement | null;
  private periodEl!: HTMLElement | null;
  private statusEl!: HTMLElement | null;
  private audioCtx?: AudioContext;

  constructor() {
    super('RetroKickScene');
  }

  create(): void {
    this.drawPitch();
    this.createTeams();
    this.createBall();
    this.createOverlays();
    this.keys = this.input.keyboard!.addKeys(
      'W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,C,SPACE,SHIFT,P,ENTER'
    ) as Record<string, Phaser.Input.Keyboard.Key>;
    this.homeScoreEl = document.getElementById('home-score');
    this.awayScoreEl = document.getElementById('away-score');
    this.clockEl = document.getElementById('clock');
    this.periodEl = document.getElementById('period');
    this.statusEl = document.getElementById('status-message');
    this.hint = document.getElementById('canvas-hint');
    this.input.on('pointerdown', () => {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (this.ended) this.resetMatch();
      this.paused = false;
      if (this.hint) this.hint.style.display = 'none';
      this.setMessage(this.restart ? this.restart.baseMsg : 'Play on!');
    });
    document.getElementById('restart-button')?.addEventListener('click', () => this.resetMatch());

    // Debug hooks (only with ?selftest):
    //   retroKickDebug.act(5, 'shoot')                      -> play an outfield animation
    //   retroKickDebug.shot('away', 230, 4)                 -> shot at the away goal: targetY, height, [speed]
    //   retroKickDebug.shot('home', 300, 30, 420)           -> high shot at the home goal
    if (new URLSearchParams(window.location.search).has('selftest')) {
      (window as any).retroKickDebug = {
        players: this.players,
        act: (i: number, type: ActionType) => this.playAction(this.players[i], type, undefined, true),
        shot: (side: TeamSide, y: number, z: number, speed = 380) => this.fireTestShot(side, y, z, speed),
      };
    }

    this.selectControlled();
    this.startKickoff(this.openingKickoff);
    this.updateHud();
  }

  // ═══════════════ GRAPHICS ═══════════════

  private drawPitch(): void {
    const g = this.add.graphics();
    g.setDepth(0);

    for (let i = 0; i < 12; i++) {
      const shade = i % 2 === 0 ? 0x1f7a52 : 0x1a6846;
      g.fillStyle(shade, 1);
      g.fillRect(i * (FIELD_W / 12), 0, FIELD_W / 12, FIELD_H);
    }

    g.fillStyle(0x3a3a3a, 1);
    g.fillRect(0, 0, FIELD_W, 10);
    g.fillRect(0, FIELD_H - 10, FIELD_W, 10);
    for (let i = 0; i < FIELD_W; i += 6) {
      const topColor = Phaser.Math.Between(0, 1) ? 0xffd166 : 0xef476f;
      g.fillStyle(topColor, 0.6);
      g.fillRect(i, 2, 4, 6);
      const bottomColor = Phaser.Math.Between(0, 1) ? 0x06d6a0 : 0x118ab2;
      g.fillStyle(bottomColor, 0.6);
      g.fillRect(i, FIELD_H - 8, 4, 6);
    }

    g.lineStyle(3, 0xffffff, 0.95);
    g.strokeRect(19, 19, FIELD_W - 38, FIELD_H - 38);
    g.lineBetween(FIELD_W / 2, 19, FIELD_W / 2, FIELD_H - 19);
    g.strokeCircle(FIELD_W / 2, FIELD_H / 2, 67);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W / 2, FIELD_H / 2, 4);

    g.strokeRect(19, 135, 118, 250);
    g.strokeRect(19, 190, 49, 140);
    g.strokeRect(FIELD_W - 137, 135, 118, 250);
    g.strokeRect(FIELD_W - 68, 190, 49, 140);

    g.fillStyle(0xffffff, 1).fillCircle(PENALTY_SPOT_X, FIELD_H / 2, 3);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W - PENALTY_SPOT_X, FIELD_H / 2, 3);
    g.fillStyle(0xffffff, 0.85).fillCircle(SECOND_SPOT_X, FIELD_H / 2, 3);
    g.fillStyle(0xffffff, 0.85).fillCircle(FIELD_W - SECOND_SPOT_X, FIELD_H / 2, 3);

    g.beginPath(); g.arc(112, FIELD_H / 2, 40, -0.9, 0.9); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 112, FIELD_H / 2, 40, Math.PI - 0.9, Math.PI + 0.9); g.strokePath();

    const cr = 10;
    g.beginPath(); g.arc(19, 19, cr, 0, Math.PI / 2); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, 19, cr, Math.PI / 2, Math.PI); g.strokePath();
    g.beginPath(); g.arc(19, FIELD_H - 19, cr, -Math.PI / 2, 0); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, FIELD_H - 19, cr, Math.PI, 1.5 * Math.PI); g.strokePath();

    this.drawGoal(g, 0, FIELD_H / 2 - 52, true);
    this.drawGoal(g, FIELD_W - 22, FIELD_H / 2 - 52, false);

    this.drawCornerFlag(22, 22);
    this.drawCornerFlag(FIELD_W - 22, 22);
    this.drawCornerFlag(22, FIELD_H - 22);
    this.drawCornerFlag(FIELD_W - 22, FIELD_H - 22);
  }

  private drawGoal(g: Phaser.GameObjects.Graphics, x: number, y: number, left: boolean): void {
    g.fillStyle(0xffffff, 1);
    g.fillRect(x, y, 22, 4);
    g.fillRect(x, y + 100, 22, 4);
    g.fillStyle(0xdddddd, 1);
    g.fillRect(left ? x : x + 20, y, 2, 104);
    g.lineStyle(1, 0xf0f0f0, 0.5);
    for (let i = 4; i < 20; i += 4) g.lineBetween(x + i, y + 4, x + i, y + 100);
    for (let j = 10; j < 100; j += 10) g.lineBetween(x + 2, y + j, x + 20, y + j);
  }

  private drawCornerFlag(x: number, y: number): void {
    const flag = this.add.graphics();
    flag.setDepth(4);
    flag.fillStyle(0x222222, 1).fillRect(x - 1, y - 14, 2, 14);
    flag.fillStyle(0xffd23f, 1).fillTriangle(x, y - 14, x + 8, y - 11, x, y - 8);
  }

  private createOverlays(): void {
    this.goalFlash = this.add
      .rectangle(FIELD_W / 2, FIELD_H / 2, FIELD_W, FIELD_H, 0xffffff, 0)
      .setDepth(50).setAlpha(0);

    this.goalText = this.add
      .text(FIELD_W / 2, FIELD_H / 2 - 20, '', {
        fontFamily: 'Impact, Arial Black, sans-serif', fontSize: '80px', color: '#ffd23f',
        stroke: '#000000', strokeThickness: 8, align: 'center',
      })
      .setOrigin(0.5).setDepth(51).setAlpha(0);

    this.goalSubText = this.add
      .text(FIELD_W / 2, FIELD_H / 2 + 40, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif', fontSize: '28px', color: '#ffffff',
        stroke: '#000000', strokeThickness: 4, align: 'center',
      })
      .setOrigin(0.5).setDepth(51).setAlpha(0);

    this.restartLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif', fontSize: '16px', color: '#ffd23f',
        stroke: '#000000', strokeThickness: 3, align: 'center',
      })
      .setOrigin(0.5, 1).setDepth(46);
    this.aimGfx = this.add.graphics().setDepth(45);
  }

  // ═══════════════ TEAMS ═══════════════

  private createTeams(): void {
    const home = [
      [105, 260, 'GK'],
      [250, 145, 'DEF'], [250, 375, 'DEF'],
      [390, 205, 'MID'], [390, 315, 'MID'],
      [490, 155, 'FWD'], [490, 365, 'FWD'],
    ] as const;
    const away = [
      [795, 260, 'GK'],
      [650, 145, 'DEF'], [650, 375, 'DEF'],
      [510, 205, 'MID'], [510, 315, 'MID'],
      [410, 155, 'FWD'], [410, 365, 'FWD'],
    ] as const;
    home.forEach((p, i) => this.addPlayer('home', p[0], p[1], p[2], i + 1));
    away.forEach((p, i) => this.addPlayer('away', p[0], p[1], p[2], i + 1));
  }

  private makeBrain(): GkBrain {
    return {
      mode: 'ready', t: 0, clock: 0, plan: null, react: 0.15, origX: 0, origY: 0,
      extNow: 0, zNow: 24, result: 'none', flickT: 0, contactCool: 0, planTouchId: -1,
    };
  }

  private addPlayer(side: TeamSide, x: number, y: number, role: Footballer['role'], number: number): void {
    const kit = makeKit(side, role, number);
    const container = this.add.container(x, y).setDepth(20);
    const shadow = this.add
      .ellipse(x + 2, y + SHADOW_DY, role === 'GK' ? 24 : 22, 13, 0x000000, 0.3)
      .setDepth(15);
    const ring = this.add.circle(0, 0, 15).setStrokeStyle(2.5, 0xffd23f, 1).setFillStyle(0xffd23f, 0.12).setVisible(false);
    const rig = this.add.graphics();
    const label = this.add
      .text(0, -18, String(number), {
        fontFamily: 'Arial Black, sans-serif', fontSize: '9px', color: '#ffffff',
        stroke: '#000', strokeThickness: 2,
      })
      .setOrigin(0.5);
    container.add([ring, rig, label]);

    this.players.push({
      sprite: container, ring, rig, shadow, label, side, role,
      homeX: x, homeY: y, vx: 0, vy: 0, number, cooldown: 0,
      celebrating: false, celebrateUntil: 0,
      facing: side === 'home' ? 0 : Math.PI,
      kit, vis: side === 'home' ? 0 : Math.PI, stride: Math.random() * Math.PI * 2,
      speed: 0, lastX: x, lastY: y, anim: 'idle', act: null,
      gk: role === 'GK' ? this.makeBrain() : null,
    });
  }

  private createBall(): void {
    this.ballShadow = this.add.ellipse(FIELD_W / 2 + 2, FIELD_H / 2 + 6, 14, 6, 0x000000, 0.4).setDepth(12);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 0).setVisible(false);
    this.ballVis = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 1).setStrokeStyle(1.5, 0x111111).setDepth(30);
    this.ballInner = this.add.circle(FIELD_W / 2, FIELD_H / 2, 2, 0x111111).setDepth(31);
  }

  // ═══════════════ PLAYER ANIMATION ═══════════════

  private playAction(p: Footballer, type: ActionType, aim?: number, fromStart = false): void {
    const def = ACTIONS[type];
    p.act = { type, t: fromStart ? 0 : def.start, dur: def.dur, aim };
  }

  private animateAll(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.players) this.animatePlayer(p, dt);
  }

  private gkAnimName(b: GkBrain, moving: boolean): AnimName {
    switch (b.mode) {
      case 'diving': {
        if (b.flickT > 0 && b.result === 'catch') return 'catch';
        if (b.flickT > 0 && b.result === 'parry') return 'parry';
        const type = b.plan ? b.plan.type : 'stand';
        return type === 'jump' ? 'jump-save' : type === 'stretch' ? 'stretch' : type === 'dive-high' ? 'dive-high' : 'dive-low';
      }
      case 'fallen': return 'fall';
      case 'recovering': return 'recover';
      case 'concede': return 'concede';
      default:
        if (b.flickT > 0 && b.result === 'catch') return 'catch';
        if (b.flickT > 0 && b.result === 'parry') return 'parry';
        return moving ? 'gk-shuffle' : 'gk-ready';
    }
  }

  private animatePlayer(p: Footballer, dt: number): void {
    const x = p.sprite.x;
    const y = p.sprite.y;
    const dx = x - p.lastX;
    const dy = y - p.lastY;
    p.lastX = x; p.lastY = y;

    let inst = Math.hypot(dx, dy) / dt;
    if (inst > 420) inst = 0;
    p.speed += (inst - p.speed) * Math.min(1, dt * 14);
    const moving = p.speed > 25;

    if (p.act) {
      p.act.t += dt / p.act.dur;
      if (p.act.t >= 1) p.act = null;
    }

    // Heading: action aim > celebration > (keeper: always face the ball) > movement direction > the ball
    let target: number;
    if (p.act && p.act.aim !== undefined) target = p.act.aim;
    else if (p.celebrating) target = Math.PI / 2;
    else if (p.gk) target = Math.atan2(this.ball.y - y, this.ball.x - x);
    else if (moving) target = Math.atan2(dy, dx);
    else target = Math.atan2(this.ball.y - y, this.ball.x - x);

    const maxTurn = (moving ? 12 : 9) * dt;
    const diff = Phaser.Math.Angle.Wrap(target - p.vis);
    p.vis = Phaser.Math.Angle.Wrap(p.vis + Phaser.Math.Clamp(diff, -maxTurn, maxTurn));
    const remaining = Phaser.Math.Angle.Wrap(target - p.vis);

    const G = gaitFor(p.speed, GAIT_TMP);
    p.stride += (p.speed * dt / G.cycle) * Math.PI * 2;

    if (p.act) p.anim = p.act.type;
    else if (p.celebrating) p.anim = 'celebrate';
    else if (p.gk) p.anim = this.gkAnimName(p.gk, moving);
    else if (moving && Math.abs(remaining) > 0.7) p.anim = 'turn';
    else p.anim = classifyLocomotion(p.speed);

    this.drawPlayer(p, G, remaining, moving);
    p.sprite.setDepth(20 + y / FIELD_H);
  }

  /** Keeper pose, derived from the keeper's real state (the same numbers the collision test uses). */
  private gkPose(p: Footballer, b: GkBrain, ph: number): GkPose {
    const now = this.time.now;
    const bob = Math.sin(now * 0.004 + p.number) * 0.6;
    const base: GkPose = {
      fLx: 0, fLy: -5.5, fRx: 0, fRy: 5.5, hLx: 5, hLy: -10 + bob * 0.5, hRx: 5, hRy: 10 - bob * 0.5,
      lean: 1.5, scale: 0.97, shadow: 1, handR: 2.9, elbowOut: 0, liftL: 0, liftR: 0, free: false,
    };
    const toLocal = (wx: number, wy: number): Pt => ({
      x: wx * Math.cos(p.vis) + wy * Math.sin(p.vis),
      y: -wx * Math.sin(p.vis) + wy * Math.cos(p.vis),
    });

    const diveLike = (e: number, scale: number): GkPose => {
      const pl = b.plan!;
      const d = toLocal(pl.dirX, pl.dirY);
      const reach = 8 + 0.4 * e;
      const lead = { x: d.x * reach, y: d.y * reach };
      const second = { x: d.x * reach * 0.75 - d.y * 2.5, y: d.y * reach * 0.75 + d.x * 2.5 };
      const rightLead = d.y >= 0;
      const back = 6 + 0.3 * e;
      const q: GkPose = {
        ...base,
        hLx: rightLead ? second.x : lead.x, hLy: rightLead ? second.y : lead.y,
        hRx: rightLead ? lead.x : second.x, hRy: rightLead ? lead.y : second.y,
        fLx: -d.x * back - d.y * 2.5, fLy: -d.y * back + d.x * 2.5,
        fRx: -d.x * back + d.y * 2.5, fRy: -d.y * back - d.x * 2.5,
        lean: 0, scale, shadow: 1 - (scale - 1) * 1.5, handR: 3.1, free: true, liftL: 0.5, liftR: 0.5,
      };
      if (e > 3) {
        q.capsule = { dx: d.x, dy: d.y, half: 5 + 0.25 * e };
        q.head = { x: d.x * (5 + 0.3 * e), y: d.y * (5 + 0.3 * e) };
      }
      return q;
    };

    const jumpPose = (zNow: number): GkPose => {
      const sc = 1 + Math.max(0, zNow - 24) / 70;
      return {
        ...base, hLx: 4, hLy: -6.5, hRx: 4, hRy: 6.5, handR: 3.4, lean: 0, scale: sc, shadow: 1 - (sc - 1) * 1.4,
        fLx: -2, fLy: -2.5, fRx: -2, fRy: 2.5, liftL: 0.6, liftR: 0.6,
      };
    };

    const crouch: GkPose = { ...base, hLx: 2, hLy: -7, hRx: 2, hRy: 7, lean: 2, scale: 0.92 };

    switch (b.mode) {
      case 'diving': {
        const pl = b.plan!;
        if (pl.type === 'jump') return jumpPose(b.zNow);
        const sc = pl.type === 'dive-low' ? 0.96 : Phaser.Math.Clamp(1 + (b.zNow - 14) / 110, 0.96, 1.2);
        return diveLike(b.extNow, sc);
      }
      case 'fallen': {
        const pl = b.plan;
        if (!pl || pl.type === 'jump' || pl.type === 'stand') return crouch;
        return diveLike(pl.ext * 0.95, 0.94);
      }
      case 'recovering': {
        const u = Phaser.Math.Clamp(b.t / RECOVER_T, 0, 1);
        const pl = b.plan;
        if (!pl || pl.type === 'jump' || pl.type === 'stand') {
          return { ...base, hLy: lerp(-7, base.hLy, u), hRy: lerp(7, base.hRy, u), lean: lerp(2, 1.5, u), scale: lerp(0.92, 0.97, u) };
        }
        return diveLike(pl.ext * 0.95 * (1 - u), lerp(0.94, 0.97, u));
      }
      case 'concede':
        return { ...base, hLx: 1, hLy: -6, hRx: 1, hRy: 6, elbowOut: 3, lean: 2.5, scale: 0.95, fLy: -5, fRy: 5 };
      default: {
        if (b.flickT > 0 && b.result === 'catch') {
          return { ...base, hLx: 7, hLy: -3.2, hRx: 7, hRy: 3.2, lean: 1.5, scale: 1 };
        }
        if (b.flickT > 0 && b.result === 'parry') {
          return { ...base, hLx: 12, hLy: -8, hRx: 12, hRy: 8, lean: 2.5, scale: 1 };
        }
        if (b.plan && b.plan.type === 'stand') {
          return { ...base, hLx: 8, hLy: -10.5, hRx: 8, hRy: 10.5, scale: 0.96 };
        }
        if (p.speed > 25) {                                   // side-step shuffle while tracking the ball
          return {
            ...base,
            fLy: -5.5 + 3.5 * Math.sin(ph), fRy: 5.5 + 3.5 * Math.sin(ph + Math.PI),
            fLx: 1.5 * Math.cos(ph), fRx: -1.5 * Math.cos(ph),
          };
        }
        return base;
      }
    }
  }

  private drawPlayer(p: Footballer, G: Gait, rem: number, moving: boolean): void {
    const g = p.rig;
    g.clear();
    const k = p.kit;
    const now = this.time.now;
    const a = p.act;
    const t = a ? a.t : 0;

    const ph = p.stride;
    const sL = Math.sin(ph);
    const sR = Math.sin(ph + Math.PI);
    const liftAmt = Math.min(1, G.legAmp / 8);
    let stance = G.stance;
    let fLx = G.legAmp * sL;
    let fRx = G.legAmp * sR;
    let fLy = -stance;
    let fRy = stance;
    let liftL = Math.max(0, Math.cos(ph)) * liftAmt;
    let liftR = Math.max(0, Math.cos(ph + Math.PI)) * liftAmt;
    let hLx = G.armAmp * sR;
    let hRx = G.armAmp * sL;
    let hLy = -(9.2 - G.elbowIn);
    let hRy = 9.2 - G.elbowIn;
    let lean = G.lean + Math.sin(now * 0.002 + p.number) * 0.25 * (1 - liftAmt);
    let sx = 1;
    let sy = 1;
    let offX = 0;
    let handR = k.longSleeves ? 2.9 : 2;
    let elbowOut = 0;
    let shadowS = 1;
    let capsule: { dx: number; dy: number; half: number } | null = null;
    let headPos: Pt | null = null;
    let free = false;

    let headYaw = Phaser.Math.Clamp(rem * 0.8, -0.7, 0.7);
    if (moving && !a && !p.gk) {
      const out = Phaser.Math.Clamp(rem * 3, -2.5, 2.5);
      hLy -= out; hRy -= out;
    }

    // Goalkeeper poses come from the keeper's real state
    if (p.gk && !a && !p.celebrating) {
      const q = this.gkPose(p, p.gk, ph);
      fLx = q.fLx; fLy = q.fLy; fRx = q.fRx; fRy = q.fRy;
      hLx = q.hLx; hLy = q.hLy; hRx = q.hRx; hRy = q.hRy;
      lean = q.lean; sx = sy = q.scale; shadowK(q.shadow); handR = q.handR; elbowOut = q.elbowOut;
      liftL = q.liftL; liftR = q.liftR; free = q.free;
      capsule = q.capsule ?? null; headPos = q.head ?? null; headYaw = 0; stance = 5.5;
    }
    function shadowK(v: number): void { shadowS = v; }

    if (a) {
      switch (a.type) {
        case 'pass':
          fRx = keyframe(t, KF.passFoot); fLx = 0; fLy = -4;
          liftR = Math.abs(fRx) / 14; liftL = 0;
          hLx = 2; hLy = -12.5; hRx = -3; hRy = 11; lean = 1;
          break;
        case 'shoot':
          fRx = keyframe(t, KF.shootFoot); fLx = 0; fLy = -4.5;
          liftR = Math.abs(fRx) / 12; liftL = 0;
          hLx = -1; hLy = -14; hRx = -1; hRy = 14;
          lean = keyframe(t, KF.shootLean);
          sx = sy = 1 + 0.05 * Math.sin(Math.PI * t);
          break;
        case 'throw': {
          const hx = keyframe(t, KF.throwHand);
          hRx = hx; hRy = 10 - Math.max(0, hx) * 0.3;
          hLx = 3; hLy = -10;
          lean = keyframe(t, KF.throwLean);
          stance = 5; fLy = -5; fRy = 5; fLx = -1; fRx = 1;
          liftL = 0; liftR = 0;
          break;
        }
        case 'tackle':
          offX = keyframe(t, KF.tackleSlide);
          fRx = 15; fRy = 2; fLx = -7; fLy = -3; liftR = 0.2; liftL = 0.4;
          hLx = -6; hLy = -9.5; hRx = -6; hRy = 9.5;
          lean = 2; sx = 1.1; sy = 0.92;
          break;
        case 'jump': {
          const s = Math.sin(Math.PI * t);
          sx = sy = 1 + 0.22 * s;
          fLx = -2; fRx = -2; fLy = -2.5; fRy = 2.5; liftL = 0.6; liftR = 0.6;
          hLx = 4; hLy = -8.5; hRx = 4; hRy = 8.5; handR = 2.8;
          shadowS = 1 - 0.3 * s;
          break;
        }
        case 'miss':
          hLx = 1.5; hLy = -4.5; hRx = 1.5; hRy = 4.5; elbowOut = 3.5;
          lean = -1.2; headYaw = 0; stance = 4; fLy = -stance; fRy = stance;
          break;
      }
    } else if (p.celebrating) {
      const w = now * 0.02 + p.number;
      hLx = 3 + 2 * Math.sin(w); hRx = 3 + 2 * Math.sin(w + Math.PI);
      hLy = -11.5; hRy = 11.5; handR = 2.6; elbowOut = 1.5;
      fLx = 3 * Math.sin(w); fRx = -3 * Math.sin(w);
      liftL = 0.3; liftR = 0.3;
      sx = sy = 1 + 0.12 * Math.abs(Math.sin(now * 0.011 + p.number * 0.7));
      headYaw = 0;
    }

    // Keep limbs within anatomical reach
    if (free) {
      fLx = Phaser.Math.Clamp(fLx, -34, 34); fRx = Phaser.Math.Clamp(fRx, -34, 34);
      fLy = Phaser.Math.Clamp(fLy, -34, 34); fRy = Phaser.Math.Clamp(fRy, -34, 34);
      hLx = Phaser.Math.Clamp(hLx, -34, 34); hRx = Phaser.Math.Clamp(hRx, -34, 34);
      hLy = Phaser.Math.Clamp(hLy, -34, 34); hRy = Phaser.Math.Clamp(hRy, -34, 34);
    } else {
      fLx = Phaser.Math.Clamp(fLx, -16, 17); fRx = Phaser.Math.Clamp(fRx, -16, 17);
      hLx = Phaser.Math.Clamp(hLx, -13, 14); hRx = Phaser.Math.Clamp(hRx, -13, 14);
      hLy = Phaser.Math.Clamp(hLy, -15, -3); hRy = Phaser.Math.Clamp(hRy, 3, 15);
    }

    // ── Draw: legs → hips → torso → arms → head
    const leg = (hipY: number, fx: number, fy: number, lf: number, sd: number): void => {
      const kx = fx * 0.5;
      const ky = hipY + (fy - hipY) * 0.5 + (free ? 0 : sd * lf * 1.2);
      g.lineStyle(4.4, k.shorts, 1).lineBetween(0, hipY, kx, ky);
      g.lineStyle(3.4, k.socks, 1).lineBetween(kx, ky, fx, fy);
      g.fillStyle(k.boots, 1).fillEllipse(fx + 1, fy, 5.6 * (1 + lf * 0.15), 3.3);
    };
    leg(-3, fLx, fLy, liftL, -1);
    leg(3, fRx, fRy, liftR, 1);

    const tx = capsule ? 0 : lean * 0.5;
    if (capsule) {
      const hx = capsule.dx * capsule.half;
      const hy2 = capsule.dy * capsule.half;
      g.lineStyle(11.5, k.jerseyDark, 1).lineBetween(-hx, -hy2, hx, hy2);
      g.lineStyle(9.5, k.jersey, 1).lineBetween(-hx, -hy2, hx, hy2);
    } else {
      g.fillStyle(k.shorts, 1).fillEllipse(-1, 0, 7, 9);
      g.fillStyle(k.jersey, 1).fillEllipse(tx, 0, 9.5, 15.5);
      g.lineStyle(1.4, k.jerseyDark, 1).strokeEllipse(tx, 0, 9.5, 15.5);
    }

    const arm = (sd: number, hx: number, hy: number): void => {
      const spx = tx + 0.5;
      const spy = sd * 6.4;
      let ex: number; let ey: number;
      if (free) { ex = (spx + hx) * 0.5; ey = (spy + hy) * 0.5; }
      else {
        ex = (spx + hx) * 0.45;
        ey = sd * (6.8 + Math.max(0, Math.abs(hy) - 6.8) * 0.5 + elbowOut);
      }
      g.lineStyle(3.4, k.jersey, 1).lineBetween(spx, spy, ex, ey);
      g.lineStyle(2.6, k.longSleeves ? k.jersey : k.skin, 1).lineBetween(ex, ey, hx, hy);
      g.fillStyle(k.glove, 1).fillCircle(hx, hy, handR);
    };
    arm(-1, hLx, hLy);
    arm(1, hRx, hRy);

    if (capsule && headPos) {
      g.fillStyle(k.hair, 1).fillCircle(headPos.x - capsule.dx * 1.2, headPos.y - capsule.dy * 1.2, 4.9);
      g.fillStyle(k.skin, 1).fillCircle(headPos.x, headPos.y, 4.0);
      g.fillStyle(k.skinShade, 1).fillCircle(headPos.x + capsule.dx * 3.6, headPos.y + capsule.dy * 3.6, 1.25);
    } else {
      const hy = Math.sin(headYaw) * 2;
      g.fillStyle(k.hair, 1).fillCircle(tx + 0.2, hy * 0.5, 4.9);
      g.fillStyle(k.skin, 1).fillCircle(tx + 1.8, hy, 4.0);
      g.fillStyle(k.skinShade, 1).fillCircle(tx + 5.4, hy * 1.1, 1.25);
    }

    g.setRotation(p.vis);
    g.setScale(sx, sy);
    g.setPosition(Math.cos(p.vis) * offX, Math.sin(p.vis) * offX);
    p.shadow.setScale(shadowS);
  }

  // ═══════════════ UPDATE LOOP ═══════════════

  update(time: number, delta: number): void {
    if (this.keys.P.isDown && !this.pauseKeyHeld) {
      this.paused = !this.paused;
      this.pauseKeyHeld = true;
      this.setMessage(this.paused ? 'Paused — press P to resume' : this.restart ? this.restart.baseMsg : 'Play on!');
    }
    if (this.keys.P.isUp) this.pauseKeyHeld = false;
    if (this.keys.ENTER.isDown && this.ended) this.resetMatch();
    if (this.paused || this.ended) return;

    const dt = Math.min(delta / 1000, 0.035);

    if (this.state === 'playing') {
      this.clockAcc += dt;
      if (this.clockAcc >= 1) {
        this.clockAcc -= 1;
        this.remaining = Math.max(0, this.remaining - 1);
        this.updateHud();
        if (this.remaining === 0) this.handlePeriodEnd();
      }
    }

    this.kickoffLock = Math.max(0, this.kickoffLock - dt);
    this.players.forEach((p) => {
      if (p.celebrating && time > p.celebrateUntil) p.celebrating = false;
      if (p.cooldown > 0) p.cooldown -= dt;
    });

    if (this.state === 'restart') {
      this.updateRestart(dt);
    } else if (this.state === 'playing') {
      this.updateUser(dt);
      if (this.state === 'playing') this.updateCpu(dt);
      if (this.state === 'playing') {
        this.updateGkHold(dt);
        this.updateGoalkeepers(dt);
        this.updateBall(dt);
        this.updatePossession();
      }
    } else if (this.state === 'goal') {
      this.tickConcede(dt);
    }
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.syncBallVisuals();
    this.animateAll(dt);
  }

  private syncBallVisuals(): void {
    const vy = this.ball.y - this.ballHeight * 0.9;
    this.ballVis.setPosition(this.ball.x, vy).setScale(1 + this.ballHeight * 0.012);
    this.ballInner.setPosition(this.ball.x + Math.cos(this.ballSpin) * 2, vy + Math.sin(this.ballSpin) * 2);
    this.ballShadow.setPosition(this.ball.x + 2 + this.ballHeight * 0.15, this.ball.y + 6 + this.ballHeight * 0.1);
    this.ballShadow.setScale(1 - Math.min(0.5, this.ballHeight * 0.015));
  }

  private handlePeriodEnd(): void {
    this.foulCount = { home: 0, away: 0 };
    this.clockAcc = 0;
    if (this.half === 1) {
      this.half = 2;
      this.remaining = HALF_SECONDS;
      this.startKickoff(other(this.openingKickoff));
      this.setMessage('⚽ HALF-TIME! ' + this.restart!.baseMsg);
    } else if (this.half === 2 && this.homeScore === this.awayScore) {
      this.half = 3;
      this.remaining = EXTRA_TIME_SECONDS;
      this.startKickoff(this.openingKickoff);
      this.flashScreen(0xffd23f, 0.3);
      this.setMessage('⏱ EXTRA TIME! Golden goal — ' + this.restart!.baseMsg);
    } else {
      this.endMatch();
    }
  }

  private endMatch(): void {
    this.ended = true;
    this.state = 'fulltime';
    this.restart = null;
    this.restartLabel.setText('');
    this.aimGfx.clear();
    const msg =
      this.homeScore === this.awayScore
        ? '🤝 Full-time — it ends level!'
        : this.homeScore > this.awayScore
          ? '🏆 FULL-TIME — Rockets win!'
          : '🏆 FULL-TIME — Comets win!';
    this.setMessage(msg);
    if (this.hint) {
      this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN';
      this.hint.style.display = 'block';
    }
  }

  // ═══════════════ USER INPUT (open play) ═══════════════

  private updateUser(dt: number): void {
    if (this.controlled.celebrating) return;

    const left = this.keys.A.isDown || this.keys.LEFT.isDown;
    const right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const sprint = this.keys.SHIFT.isDown;
    const speed = sprint ? 260 : 190;
    let dx = Number(right) - Number(left);
    let dy = Number(down) - Number(up);
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;

    this.controlled.vx = dx * speed;
    this.controlled.vy = dy * speed;
    if (dx !== 0 || dy !== 0) this.controlled.facing = Math.atan2(dy, dx);

    this.movePlayer(this.controlled, dt, true);

    this.players
      .filter((p) => p.side === 'home' && p !== this.controlled && !p.celebrating && p.role !== 'GK')
      .forEach((p) => {
        const supportX = p.homeX + Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.14, -45, 45);
        const supportY = p.homeY + Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.1, -35, 35);
        this.steerTo(p, supportX, supportY, 110, dt);
      });

    if (Phaser.Input.Keyboard.JustDown(this.keys.X)) {
      const distance = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
      if (this.possession === 'home' && distance < 48) this.passBall();
      else this.selectControlled();
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.Z)) this.shootBall();
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) this.tackle();
  }

  // ═══════════════ CPU AI (open play) ═══════════════

  private updateCpu(dt: number): void {
    const awayPlayers = this.players.filter((p) => p.side === 'away');
    const nearest = this.nearestPlayer('away', this.ball.x, this.ball.y);

    for (const p of awayPlayers) {
      if (p.celebrating) { p.vx = 0; p.vy = 0; continue; }
      if (p.role === 'GK') continue;                       // keepers are handled by updateGoalkeepers
      if (p === nearest) {
        this.steerTo(p, this.ball.x + (this.ball.x < FIELD_W * 0.62 ? 8 : -12), this.ball.y, 150, dt);
        const d = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
        const ballSpeed = Math.hypot(this.ballVx, this.ballVy);
        if (d < 23 && this.possession !== 'away' && p.cooldown <= 0 && !this.gkHolder) {
          if (this.possession === 'home') {
            p.cooldown = 0.4;
            this.playAction(p, 'tackle', Math.atan2(this.ball.y - p.sprite.y, this.ball.x - p.sprite.x));
            const roll = Phaser.Math.Between(0, 100);
            if (roll < 10) {
              this.awardFoul('away', this.ball.x, this.ball.y);
              return;
            }
            if (roll < 55) {
              this.playSound('tackle');
              this.controlBall(p);
              this.spawnDustParticles(this.ball.x, this.ball.y);
              this.setMessage('Ball won by Comets!');
            }
          } else if (this.possession === null && ballSpeed < 150) {
            this.controlBall(p);
          }
        }
      } else {
        const driftX = Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.18, -58, 58);
        const driftY = Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.13, -38, 38);
        this.steerTo(p, p.homeX + driftX, p.homeY + driftY, 88, dt);
      }
    }

    if (this.possession === 'away' && this.kickoffLock <= 0 && !this.gkHolder) {
      const carrier = nearest;
      const d = dist(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y);
      if (d < 27) {
        if (this.ball.x < 300 && Math.abs(this.ball.y - FIELD_H / 2) < 175 && Phaser.Math.Between(0, 100) < 4) {
          const ty = CENTER_Y + Phaser.Math.Between(-40, 40);
          const angle = Math.atan2(ty - this.ball.y, LINE - this.ball.x);
          const lift = shotLiftFor(340, this.ball.x - LINE, Math.random() < 0.3);
          this.kickBall(Math.cos(angle) * 340, Math.sin(angle) * 340, carrier, lift, 'shoot');
          this.playSound('shoot');
          this.setMessage('Shot from Comets!');
        } else if (Phaser.Math.Between(0, 100) < 2) {
          const teammate = awayPlayers.find((p) => p !== carrier && p.role !== 'GK');
          if (teammate) {
            this.kickBall((teammate.sprite.x - this.ball.x) * 1.7, (teammate.sprite.y - this.ball.y) * 1.7, carrier, 15, 'pass');
          }
        } else {
          this.ballVx = Math.max(-140, this.ballVx - 8);
          this.ballVy += Phaser.Math.Clamp(carrier.sprite.y - this.ball.y, -30, 30) * dt * -1;
        }
      }
    }
  }

  // ═══════════════ MOVEMENT ═══════════════

  private movePlayer(p: Footballer, dt: number, userControlled = false): void {
    const newX = Phaser.Math.Clamp(p.sprite.x + p.vx * dt, 31, FIELD_W - 31);
    const newY = Phaser.Math.Clamp(p.sprite.y + p.vy * dt, 31, FIELD_H - 31);
    p.sprite.setPosition(newX, newY);
    p.shadow.setPosition(newX + 2, newY + SHADOW_DY);

    if (
      userControlled && this.possession === 'home' && this.state === 'playing' &&
      this.kickoffLock <= 0 && p.cooldown <= 0 && !this.gkHolder
    ) {
      const d = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
      if (d < 22) {
        this.ball.x = p.sprite.x + Math.cos(p.facing) * 15;
        this.ball.y = p.sprite.y + Math.sin(p.facing) * 15;
        this.ballVx = p.vx * 0.25;
        this.ballVy = p.vy * 0.25;
        this.registerTouch(p);
      }
    }
  }

  private steerTo(p: Footballer, x: number, y: number, speed: number, dt: number): void {
    const dx = x - p.sprite.x;
    const dy = y - p.sprite.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 3) {
      p.vx = (dx / distance) * Math.min(speed, distance * 3);
      p.vy = (dy / distance) * Math.min(speed, distance * 3);
      p.facing = Math.atan2(dy, dx);
    } else {
      p.vx = 0;
      p.vy = 0;
    }
    this.movePlayer(p, dt, false);
  }

  // ═══════════════ GOALKEEPERS (Phase 3) ═══════════════

  private keeperOf(side: TeamSide): Footballer {
    return this.players.find((p) => p.role === 'GK' && p.side === side)!;
  }

  private resetKeeper(b: GkBrain): void {
    b.mode = 'ready'; b.t = 0; b.plan = null; b.result = 'none'; b.extNow = 0; b.zNow = 24;
    b.contactCool = 0; b.flickT = 0; b.planTouchId = this.touchId;
  }

  /** Forward simulation of the ball with the SAME physics as updateBall (used to read a shot). */
  private predictBall(maxT = 1.6): Sample[] {
    let x = this.ball.x; let y = this.ball.y; let z = this.ballHeight;
    let vx = this.ballVx; let vy = this.ballVy; let vz = this.ballVz;
    const out: Sample[] = [];
    const dt = 1 / 60;
    for (let i = 1; i <= Math.round(maxT * 60); i++) {
      x += vx * dt; y += vy * dt; z += vz * dt; vz -= 400 * dt;
      if (z < 0) { z = 0; vz = vz < -30 ? vz * -0.4 : 0; }
      const fk = Math.pow(z > 1 ? 0.997 : 0.986, dt * 60);
      vx *= fk; vy *= fk;
      out.push({ t: i * dt, x, y, z });
      if (x < LINE || x > FIELD_W - LINE || y < LINE || y > FIELD_H - LINE) break;
      if (Math.hypot(vx, vy) < 15) break;
    }
    return out;
  }

  private updateGoalkeepers(dt: number): void {
    for (const p of this.players) {
      const b = p.gk;
      if (!b) continue;
      b.contactCool = Math.max(0, b.contactCool - dt);
      b.flickT = Math.max(0, b.flickT - dt);
      b.t += dt;
      b.clock += dt;
      switch (b.mode) {
        case 'ready': this.gkReady(p, b, dt); break;
        case 'diving': this.gkDive(p, b); break;
        case 'fallen':
          p.vx = 0; p.vy = 0;
          if (b.t >= FALL_T) { b.mode = 'recovering'; b.t = 0; }
          break;
        case 'recovering': {
          const tg = this.keeperTargetFor(p);
          this.steerTo(p, tg.x, tg.y, 70, dt);
          if (b.t >= RECOVER_T) this.resetKeeper(b);
          break;
        }
        case 'concede':
          p.vx = 0; p.vy = 0;
          if (b.t >= 2.0) this.resetKeeper(b);
          break;
      }
    }
  }

  private tickConcede(dt: number): void {
    for (const p of this.players) {
      const b = p.gk;
      if (b && b.mode === 'concede') b.t += dt;
    }
  }

  private keeperTargetFor(p: Footballer): Pt {
    const dirIn = p.side === 'home' ? 1 : -1;
    const speed = Math.hypot(this.ballVx, this.ballVy);
    const dBall = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
    const inBox =
      (dirIn === 1 ? this.ball.x < BOX_DEPTH : this.ball.x > FIELD_W - BOX_DEPTH) &&
      Math.abs(this.ball.y - CENTER_Y) < BOX_HALF_H;
    // Loose ball in the area and no opponent closer: come and claim it
    if (this.possession === null && speed < 120 && dBall < 120 && inBox) {
      const oppNear = this.players.some((o) =>
        o.side !== p.side && o.role !== 'GK' && dist(o.sprite.x, o.sprite.y, this.ball.x, this.ball.y) < dBall * 0.8);
      if (!oppNear) return { x: this.ball.x, y: this.ball.y };
    }
    return keeperTarget(p.side, this.ball.x, this.ball.y);
  }

  private gkReady(p: Footballer, b: GkBrain, dt: number): void {
    if (this.gkHolder === p) { p.vx = 0; p.vy = 0; return; }

    // A new ball event: read it
    if (b.planTouchId !== this.touchId) {
      b.planTouchId = this.touchId;
      b.plan = null;
      this.evaluateThreat(p, b);
    }

    if (b.plan) {
      if (b.plan.type !== 'stand' && b.clock >= b.plan.startAt) {
        b.mode = 'diving'; b.t = 0;
        b.origX = p.sprite.x; b.origY = p.sprite.y;
        b.extNow = 0; b.zNow = 24; b.result = 'none';
        p.vx = 0; p.vy = 0;
        return;
      }
      p.vx = 0; p.vy = 0;                                    // set and waiting for the ball
      if (b.plan.type === 'stand' && b.clock > b.plan.arrive + 0.4) b.plan = null;
      return;
    }

    const tg = this.keeperTargetFor(p);
    this.steerTo(p, tg.x, tg.y, 120, dt);
  }

  private evaluateThreat(p: Footballer, b: GkBrain): void {
    const dirIn = p.side === 'home' ? 1 : -1;
    const goalLine = p.side === 'home' ? LINE : FIELD_W - LINE;
    const speed = Math.hypot(this.ballVx, this.ballVy);
    if (speed < 140) return;
    if (this.ballVx * dirIn >= -30) return;                 // not heading toward this goal
    const samples = this.predictBall();
    if (!samples.length) return;
    const last = samples[samples.length - 1];
    const reachesLine = p.side === 'home' ? last.x < goalLine + 1 : last.x > goalLine - 1;
    if (!reachesLine) return;
    if (Math.abs(last.y - CENTER_Y) > GOAL_HALF + 10) return;   // going wide
    if (last.z > GOAL_HEIGHT + 8) return;                       // over the bar

    const react = Phaser.Math.FloatBetween(0.12, 0.2);
    const err = {
      y: Phaser.Math.FloatBetween(-GK_PREDICT_ERR, GK_PREDICT_ERR),
      z: Phaser.Math.FloatBetween(-5, 5),
    };
    const plan = chooseSave(p.sprite.x, p.sprite.y, dirIn, samples, react, err);
    if (!plan) return;
    b.plan = plan; b.react = react; b.clock = 0; b.result = 'none';
  }

  /** Penalty: the keeper cannot read a ball that arrives in ~0.2 s, so he commits to a guess. */
  private keeperAnticipate(def: TeamSide): void {
    const gk = this.keeperOf(def);
    const b = gk.gk!;
    const g = Math.random();
    const lat = g < 0.42 ? -1 : g < 0.58 ? 0 : 1;
    const high = Math.random() < 0.45;
    b.plan = {
      type: lat === 0 ? 'stand' : high ? 'dive-high' : 'dive-low',
      dirX: 0, dirY: lat, ext: lat === 0 ? 0 : 22, zTarget: high ? 28 : 5,
      startAt: 0.04, arrive: 0.2, guess: true, reachable: true,
    };
    b.clock = 0; b.planTouchId = this.touchId; b.result = 'none';
  }

  private gkDive(p: Footballer, b: GkBrain): void {
    const pl = b.plan;
    if (!pl) { b.mode = 'recovering'; b.t = 0; return; }
    const T = DIVE_T[pl.type];
    const e = easeOut(Math.min(1, b.t / T));
    b.extNow = pl.ext * e;
    b.zNow = lerp(24, pl.zTarget, e);
    if (pl.type !== 'jump') {
      // The body really travels (60% of the extension); the hands reach the rest (see keeperHit).
      const nx = Phaser.Math.Clamp(b.origX + pl.dirX * 0.6 * b.extNow, 24, FIELD_W - 24);
      const ny = Phaser.Math.Clamp(b.origY + pl.dirY * 0.6 * b.extNow, 24, FIELD_H - 24);
      p.sprite.setPosition(nx, ny);
      p.shadow.setPosition(nx + 2, ny + SHADOW_DY);
    }
    p.vx = 0; p.vy = 0;
    if (b.t >= T + HOLD_T) { b.mode = 'fallen'; b.t = 0; }
  }

  /** The keeper's hands in 3D — the same geometry that gkPose() draws. */
  private keeperHit(gk: Footballer, b: GkBrain, z: number): { kind: 'hand' | 'body'; quality: number; px: number; py: number } | null {
    const dirIn = gk.side === 'home' ? 1 : -1;
    const bx = gk.sprite.x; const by = gk.sprite.y;
    let pts: Pt[] = [];
    let handZ = 24;
    let bodyZMax = 10;

    if (b.mode === 'ready') {
      pts = [{ x: bx + dirIn * 6, y: by - 10 }, { x: bx + dirIn * 6, y: by + 10 }, { x: bx + dirIn * 8, y: by }];
      handZ = 24; bodyZMax = 26;
    } else if (b.mode === 'diving' && b.plan) {
      const pl = b.plan;
      handZ = b.zNow;
      if (pl.type === 'jump') {
        pts = [{ x: bx + dirIn * 6, y: by - 8 }, { x: bx + dirIn * 6, y: by + 8 }];
        bodyZMax = 22;
      } else {
        const reach = 8 + 0.4 * b.extNow;
        pts = [
          { x: bx + pl.dirX * reach, y: by + pl.dirY * reach },
          { x: bx + pl.dirX * reach * 0.55, y: by + pl.dirY * reach * 0.55 },
        ];
        bodyZMax = pl.type === 'dive-low' ? 12 : 22;
      }
    }

    for (const q of pts) {
      const dh = Math.hypot(this.ball.x - q.x, this.ball.y - q.y);
      if (dh < HAND_R && Math.abs(z - handZ) < Z_WIN) {
        return { kind: 'hand', quality: 1 - dh / HAND_R, px: q.x, py: q.y };
      }
    }
    if (Math.hypot(this.ball.x - bx, this.ball.y - by) < BODY_R && z < bodyZMax) {
      return { kind: 'body', quality: 0.3, px: bx, py: by };
    }
    return null;
  }

  private keeperContacts(): void {
    if (this.state !== 'playing' || this.gkHolder || this.ballHeight > 48) return;
    const speed = Math.hypot(this.ballVx, this.ballVy);
    if (speed <= 150) return;                               // slow balls are collected by handleBallContacts
    for (const gk of this.players) {
      const b = gk.gk;
      if (!b || gk.cooldown > 0 || b.contactCool > 0 || b.mode === 'concede') continue;
      const dirIn = gk.side === 'home' ? 1 : -1;
      if (this.lastTouch === gk.side && this.ballVx * dirIn > -20) continue;   // his own side's ball moving away
      const hit = this.keeperHit(gk, b, this.ballHeight);
      if (!hit) continue;
      this.saveContact(gk, b, hit, speed);
      return;
    }
  }

  private saveContact(gk: Footballer, b: GkBrain, hit: { kind: 'hand' | 'body'; quality: number; px: number; py: number }, speed: number): void {
    const dirIn = gk.side === 'home' ? 1 : -1;
    b.contactCool = 0.4;
    b.flickT = 0.5;

    if (hit.kind === 'body') {
      b.result = 'block';
      this.deflect(gk, speed, 0.35, false);                 // leg / body block
      return;
    }

    this.shotMissed();
    const res = resolveSaveContact(speed, hit.quality, this.ballHeight);
    if (res === 'catch') {
      b.result = 'catch';
      this.registerTouch(gk);
      this.possession = gk.side;
      this.ballVx = 0; this.ballVy = 0;
      this.gkCatch(gk);
      this.setMessage('🧤 Saved! Keeper holds it');
      return;
    }

    // Parry: pushed away from goal and along the line of the dive; high balls are tipped over the bar
    b.result = 'parry';
    const pl = b.plan;
    const latX = pl ? pl.dirX : 0;
    const latY = pl ? pl.dirY : (Math.sign(this.ball.y - gk.sprite.y) || 1);
    let px: number; let py: number; let vz: number; let sp: number;
    if (res === 'tip-over') {
      px = -dirIn * 0.8 + latX * 0.2; py = latY * 0.2; vz = 260; sp = speed * 0.5;
    } else {
      px = dirIn * 0.45 + latX * 0.55; py = latY * 0.55; vz = 50; sp = Math.max(90, speed * 0.42);
    }
    const nl = Math.hypot(px, py) || 1;
    this.ball.setPosition(hit.px + (px / nl) * 3, hit.py + (py / nl) * 3);
    this.ballVx = (px / nl) * sp;
    this.ballVy = (py / nl) * sp;
    this.ballVz = vz;
    this.registerTouch(gk);
    this.possession = null;
    this.playSound('tackle');
    this.spawnDustParticles(this.ball.x, this.ball.y);
    this.setMessage(res === 'tip-over' ? '🧤 Tipped over the bar!' : '🧤 Parried!');
  }

  // ═══════════════ BALL PHYSICS & TOUCH TRACKING ═══════════════

  private updateBall(dt: number): void {
    if (this.gkHolder) {
      const gk = this.gkHolder;
      this.ball.setPosition(gk.sprite.x + (gk.side === 'home' ? 10 : -10), gk.sprite.y);
      this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
      return;
    }

    this.ball.x += this.ballVx * dt;
    this.ball.y += this.ballVy * dt;

    this.ballHeight += this.ballVz * dt;
    this.ballVz -= 400 * dt;
    if (this.ballHeight < 0) {
      this.ballHeight = 0;
      this.ballVz = this.ballVz < -30 ? this.ballVz * -0.4 : 0;
    }

    const friction = this.ballHeight > 1 ? 0.997 : 0.986;
    this.ballVx *= Math.pow(friction, dt * 60);
    this.ballVy *= Math.pow(friction, dt * 60);
    this.ballSpin += Math.hypot(this.ballVx, this.ballVy) * dt * 0.05;

    this.keeperContacts();
    if (this.gkHolder) return;
    if (this.checkBoundaries()) return;

    this.ball.x = Phaser.Math.Clamp(this.ball.x, 5, FIELD_W - 5);
    this.ball.y = Phaser.Math.Clamp(this.ball.y, 5, FIELD_H - 5);

    this.handleBallContacts();
  }

  private checkBoundaries(): boolean {
    if (this.state !== 'playing' || this.goalScored || this.kickoffLock > 0) return false;
    const decision = decideOutOfPlay(this.ball.x, this.ball.y, this.lastTouch, this.ballHeight);
    if (!decision) return false;
    const z = this.ballHeight;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    if (decision.kind === 'goal') {
      this.scoreGoal(decision.team);
    } else {
      this.shotMissed();
      this.startRestart({ kind: decision.kind, team: decision.team, x: decision.x, y: decision.y });
      if (z > GOAL_HEIGHT && (decision.kind === 'goal-clearance' || decision.kind === 'corner')) {
        this.setMessage('Over the bar! · ' + this.restart!.baseMsg);
      }
    }
    return true;
  }

  private registerTouch(p: Footballer): void {
    this.lastTouch = p.side;
    this.touchId++;
    if (this.indirectPending && p !== this.indirectPending.taker) this.indirectPending = null;
    if (this.shooter && p.side === this.shooter.side && p !== this.shooter) this.shooter = null;
  }

  private controlBall(p: Footballer): void {
    this.registerTouch(p);
    this.possession = p.side;
    this.ballVx = 0;
    this.ballVy = 0;
    if (p.role === 'GK') { this.gkCatch(p); return; }
    if (p.side === 'home') { this.controlled = p; this.refreshMarker(); }
  }

  private handleBallContacts(): void {
    if (this.state !== 'playing' || this.kickoffLock > 0 || this.ballHeight > 12 || this.gkHolder) return;
    const speed = Math.hypot(this.ballVx, this.ballVy);
    let best: Footballer | null = null;
    let bestD = Infinity;
    for (const p of this.players) {
      if (p.celebrating || p.cooldown > 0) continue;
      if (p.gk) {
        // Fast shots are handled by the keeper's 3D hand/body test, not by this circle
        if (p.side !== this.lastTouch && speed > 150) continue;
        if (p.gk.mode === 'diving' || p.gk.mode === 'fallen' || p.gk.mode === 'concede') continue;
      }
      const d = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
      if (d < CONTACT_RADIUS && d < bestD) { best = p; bestD = d; }
    }
    if (!best) return;

    if (this.ballHeight > 2.5 && !best.act && !best.gk) this.playAction(best, 'jump');

    const own = best.side === this.lastTouch;
    if (own || speed < 150) {
      if (!own) this.shotMissed();
      this.controlBall(best);
    } else if (speed < 260) {
      this.shotMissed();
      this.controlBall(best);
      this.setMessage(`Intercepted by ${teamName(best.side)}`);
    } else {
      this.deflect(best, speed, 0.5, false);
    }
  }

  private deflect(p: Footballer, speed: number, keep: number, save: boolean): void {
    this.shotMissed();
    const ang = Math.atan2(this.ball.y - p.sprite.y, this.ball.x - p.sprite.x);
    let nx = Math.cos(ang) * 0.7 + (this.ballVx / speed) * 0.3;
    let ny = Math.sin(ang) * 0.7 + (this.ballVy / speed) * 0.3;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    this.ballVx = nx * speed * keep;
    this.ballVy = ny * speed * keep;
    this.ballVz = 20;
    this.ball.x = p.sprite.x + Math.cos(ang) * (CONTACT_RADIUS + 2);
    this.ball.y = p.sprite.y + Math.sin(ang) * (CONTACT_RADIUS + 2);
    this.registerTouch(p);
    p.cooldown = 0.3;
    this.possession = null;
    this.playSound('tackle');
    this.spawnDustParticles(this.ball.x, this.ball.y);
    this.setMessage(save ? '🧤 Parried!' : p.gk ? '🧤 Blocked by the keeper!' : 'Blocked!');
  }

  private shotMissed(): void {
    const s = this.shooter;
    if (!s) return;
    this.shooter = null;
    if (this.time.now > this.shooterUntil) return;
    this.playAction(s, 'miss');
  }

  private gkCatch(gk: Footballer): void {
    this.gkHolder = gk;
    this.gkHoldTimer = 1.5 + Math.random() * 0.5;           // long enough to get back up before distributing
    this.possession = gk.side;
    this.ballVx = 0; this.ballVy = 0;
    const b = gk.gk!;
    b.result = 'catch';
    b.flickT = 0.6;
    if (b.mode === 'ready') b.plan = null;
    this.setMessage(`🧤 ${teamName(gk.side)} keeper has the ball`);
  }

  private updateGkHold(dt: number): void {
    if (!this.gkHolder) return;
    this.gkHoldTimer -= dt;
    if (this.gkHoldTimer > 0) return;
    const gk = this.gkHolder;
    const dirA = gk.side === 'home' ? 1 : -1;
    const mate = this.findOpenTeammate(gk.side, gk.sprite.x, gk.sprite.y);
    const tx = mate ? mate.sprite.x : gk.sprite.x + dirA * 250;
    const ty = mate ? mate.sprite.y : CENTER_Y;
    const d = dist(gk.sprite.x, gk.sprite.y, tx, ty);
    const speed = Phaser.Math.Clamp(d * 1.3, 170, 380);
    const ang = Math.atan2(ty - gk.sprite.y, tx - gk.sprite.x);
    this.gkHolder = null;
    this.kickBall(Math.cos(ang) * speed, Math.sin(ang) * speed, gk, 25, 'throw');
    gk.cooldown = 1.0;
    this.playSound('pass');
    this.setMessage(`${teamName(gk.side)} keeper distributes`);
  }

  private updatePossession(): void {
    if (this.possession === 'home' && this.state === 'playing' && !this.gkHolder) {
      const carrier = this.controlled;
      const d = dist(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y);
      if (d < 32 && Math.hypot(this.ballVx, this.ballVy) < 120) {
        this.ball.x = carrier.sprite.x + Math.cos(carrier.facing) * 14;
        this.ball.y = carrier.sprite.y + Math.sin(carrier.facing) * 14;
        this.ballVx = carrier.vx * 0.22;
        this.ballVy = carrier.vy * 0.22;
        this.registerTouch(carrier);
      }
    }
  }

  private findOpenTeammate(side: TeamSide, fromX: number, fromY: number, exclude?: Footballer): Footballer | null {
    const dirA = side === 'home' ? 1 : -1;
    const foes = this.players.filter((p) => p.side !== side && p.role !== 'GK');
    let best: Footballer | null = null;
    let bestScore = -Infinity;
    for (const m of this.players) {
      if (m.side !== side || m.role === 'GK' || m === exclude) continue;
      const d = dist(m.sprite.x, m.sprite.y, fromX, fromY);
      if (d < 40 || d > 430) continue;
      const pressure = foes.filter((o) => dist(o.sprite.x, o.sprite.y, m.sprite.x, m.sprite.y) < 55).length;
      const score = dirA * (m.sprite.x - fromX) * 0.5 - pressure * 80 - d * 0.1;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  // ═══════════════ ACTIONS (open play) ═══════════════

  private passBall(): void {
    if (this.gkHolder) return;
    const teammates = this.players
      .filter((p) => p.side === 'home' && p !== this.controlled && p.role !== 'GK')
      .sort((a, b) =>
        dist(a.sprite.x, a.sprite.y, this.ball.x, this.ball.y) -
        dist(b.sprite.x, b.sprite.y, this.ball.x, this.ball.y));
    const teammate = teammates[0];
    if (!teammate) return;
    const angle = Math.atan2(teammate.sprite.y - this.ball.y, teammate.sprite.x - this.ball.x);
    this.kickBall(Math.cos(angle) * 260, Math.sin(angle) * 260, this.controlled, 10, 'pass');
    this.playSound('pass');
    this.setMessage('→ Pass played');
  }

  /** Z = driven (low) shot. Hold C + Z = high shot aimed at the top of the goal. */
  private shootBall(): void {
    if (this.gkHolder) return;
    const d = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('⚠ Get closer to shoot');
      return;
    }
    const high = this.keys.C.isDown;
    const targetY = CENTER_Y + Phaser.Math.Between(-46, 46);
    const angle = Math.atan2(targetY - this.ball.y, FIELD_W - 8 - this.ball.x);
    const power = this.ball.x > FIELD_W * 0.65 ? 430 : 350;
    const lift = shotLiftFor(power, FIELD_W - LINE - this.ball.x, high);
    this.kickBall(Math.cos(angle) * power, Math.sin(angle) * power, this.controlled, lift, 'shoot');
    this.playSound('shoot');
    this.setMessage(high ? '💥 HIGH SHOT!' : '💥 SHOT!');
    this.cameraShake = 0.12;
  }

  private tackle(): void {
    if (this.gkHolder) { this.setMessage('Keeper has the ball'); return; }
    const me = this.controlled;
    const opponent = this.nearestPlayer('away', me.sprite.x, me.sprite.y);
    const d = dist(me.sprite.x, me.sprite.y, opponent.sprite.x, opponent.sprite.y);
    const ballDist = dist(me.sprite.x, me.sprite.y, this.ball.x, this.ball.y);

    const aim = ballDist < 90 ? Math.atan2(this.ball.y - me.sprite.y, this.ball.x - me.sprite.x) : me.facing;
    this.playAction(me, 'tackle', aim);
    this.playSound('tackle');
    this.spawnDustParticles(me.sprite.x, me.sprite.y + 8);

    if (ballDist < 35 && this.possession === 'away') {
      this.registerTouch(me);
      this.possession = 'home';
      this.selectControlled();
      this.ballVx *= -0.3;
      this.ballVy *= -0.3;
      this.setMessage('✓ Clean tackle!');
    } else if (d < 37) {
      if (Phaser.Math.Between(0, 100) < 35) {
        this.awardFoul('home', opponent.sprite.x, opponent.sprite.y);
      } else {
        this.setMessage('Challenge missed!');
      }
    } else {
      this.setMessage('Missed tackle');
    }
  }

  private kickBall(vx: number, vy: number, kicker: Footballer, lift = 10, action?: ActionType): void {
    this.gkHolder = null;
    this.ballVx = vx;
    this.ballVy = vy;
    this.ballVz = lift;
    this.possession = null;
    this.registerTouch(kicker);
    kicker.cooldown = 0.25;
    if (action) this.playAction(kicker, action, Math.atan2(vy, vx));
    if (action === 'shoot') { this.shooter = kicker; this.shooterUntil = this.time.now + 3000; }
  }

  /** Debug: fire a shot at `targetSide`'s goal from 300 px out. y = where it crosses the line, z = arrival height. */
  private fireTestShot(targetSide: TeamSide, targetY: number, z: number, speed: number): void {
    const attacker = other(targetSide);
    const dirIn = targetSide === 'home' ? 1 : -1;
    const goalX = targetSide === 'home' ? LINE : FIELD_W - LINE;
    const sx = goalX + dirIn * 300;
    this.paused = false;
    this.restart = null;
    this.state = 'playing';
    this.gkHolder = null;
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.players.forEach((p) => { if (p.gk) this.resetKeeper(p.gk); });
    this.ball.setPosition(sx, CENTER_Y);
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    const shooter = this.players.find((p) => p.side === attacker && p.role === 'FWD')!;
    const ang = Math.atan2(targetY - CENTER_Y, goalX - sx);
    const lift = z > 15 ? shotLiftFor(speed, 300, true) : 20;
    this.kickBall(Math.cos(ang) * speed, Math.sin(ang) * speed, shooter, lift, 'shoot');
    this.kickoffLock = 0.1;
    this.setMessage(`Test shot at ${teamName(targetSide)} goal`);
  }

  // ═══════════════ FOULS ═══════════════

  private awardFoul(fouler: TeamSide, x: number, y: number): void {
    this.foulCount[fouler]++;
    const n = this.foulCount[fouler];
    const spec = decideFoul(fouler, x, y, n);
    this.startRestart(spec);
    this.playSound('tackle');
    const tag = n > FOUL_LIMIT ? ` (foul #${n} — accumulated)` : ` (foul #${n})`;
    this.setMessage(`⚑ FOUL by ${teamName(fouler)}${tag} · ${this.restart!.baseMsg}`);
  }

  // ═══════════════ RESTART SYSTEM ═══════════════

  private startKickoff(team: TeamSide): void {
    this.players.forEach((p) => {
      p.vx = 0; p.vy = 0; p.celebrating = false; p.act = null; p.cooldown = 0;
    });
    this.kickoffLock = 0;
    this.goalScored = false;
    this.startRestart({ kind: 'kickoff', team, x: CENTER_X, y: CENTER_Y }, true);
  }

  private startRestart(spec: RestartSpec, snap = false): void {
    const info = RESTART_INFO[spec.kind];
    this.state = 'restart';
    this.gkHolder = null;
    this.indirectPending = null;
    this.shooter = null;
    this.possession = spec.team;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ball.setPosition(spec.x, spec.y);
    this.players.forEach((p) => { if (p.gk) this.resetKeeper(p.gk); });

    const taker = this.pickTaker(spec);
    const r: Restart = {
      ...spec, taker, targets: new Map(), elapsed: 0, ready: false,
      timer: info.limit ?? 8, cpuDelay: Phaser.Math.FloatBetween(1.0, 2.4),
      aim: 0, power: 0, charging: false, lofted: false, baseMsg: '',
    };
    r.aim = this.defaultAim(r);
    r.baseMsg = `${info.label}: ${teamName(spec.team)}` + (spec.team === 'home' ? ' — aim with arrows, hold C, release to kick · Z = lofted' : '');
    this.restart = r;
    this.buildLayout(r);

    this.controlled = spec.team === 'home' ? taker : this.nearestPlayer('home', spec.x, spec.y);
    this.refreshMarker();
    if (snap) this.snapToLayout(r);
    this.aimGfx.clear();
    this.setMessage(r.baseMsg);
  }

  private pickTaker(spec: RestartSpec): Footballer {
    const mates = this.players.filter((p) => p.side === spec.team);
    if (spec.kind === 'goal-clearance') return mates.find((p) => p.role === 'GK')!;
    let pool = mates.filter((p) => p.role !== 'GK');
    if (spec.kind === 'kickoff' || spec.kind === 'penalty' || spec.kind === 'second-penalty') {
      const fwd = pool.filter((p) => p.role === 'FWD');
      if (fwd.length) pool = fwd;
    }
    if (spec.kind === 'kickoff') return pool[0];
    return pool.reduce((b, p) =>
      dist(p.sprite.x, p.sprite.y, spec.x, spec.y) < dist(b.sprite.x, b.sprite.y, spec.x, spec.y) ? p : b);
  }

  private takerSpot(r: RestartSpec): Pt {
    const dirA = r.team === 'home' ? 1 : -1;
    switch (r.kind) {
      case 'kick-in': return { x: r.x, y: r.y < CENTER_Y ? 31 : FIELD_H - 31 };
      case 'corner': return { x: r.x < CENTER_X ? 31 : FIELD_W - 31, y: r.y < CENTER_Y ? 31 : FIELD_H - 31 };
      case 'goal-clearance': return { x: r.x - dirA * 12, y: r.y };
      default: return { x: r.x - dirA * 13, y: r.y };
    }
  }

  private defaultAim(r: RestartSpec): number {
    const dirA = r.team === 'home' ? 1 : -1;
    const goalX = dirA === 1 ? FIELD_W - 8 : 8;
    let tx = goalX; const ty = CENTER_Y;
    switch (r.kind) {
      case 'kickoff': tx = CENTER_X + dirA * 100; break;
      case 'kick-in': tx = CENTER_X + dirA * 60; break;
      case 'corner': tx = goalX - dirA * 90; break;
      case 'goal-clearance': tx = r.x + dirA * 250; break;
      default: break;
    }
    return Math.atan2(ty - r.y, tx - r.x);
  }

  private formationSpot(p: Footballer, r: RestartSpec): Pt {
    let x = p.homeX + Phaser.Math.Clamp((r.x - CENTER_X) * 0.18, -58, 58);
    const y = p.homeY + Phaser.Math.Clamp((r.y - CENTER_Y) * 0.13, -38, 38);
    if (r.kind === 'kickoff') x = p.side === 'home' ? Math.min(x, CENTER_X - 16) : Math.max(x, CENTER_X + 16);
    return clampPt(x, y);
  }

  private optionSpots(r: RestartSpec): Pt[] {
    const dirA = r.team === 'home' ? 1 : -1;
    const inY = r.y < CENTER_Y ? 1 : -1;
    const inX = r.x < CENTER_X ? 1 : -1;
    let raw: Pt[] = [];
    switch (r.kind) {
      case 'kick-in':
        raw = [{ x: r.x + dirA * 70, y: r.y + inY * 75 }, { x: r.x - dirA * 60, y: r.y + inY * 95 }, { x: r.x + dirA * 20, y: r.y + inY * 150 }];
        break;
      case 'corner':
        raw = [{ x: r.x + inX * 70, y: r.y + inY * 45 }, { x: r.x + inX * 100, y: CENTER_Y - 35 }, { x: r.x + inX * 120, y: CENTER_Y + 35 }, { x: r.x + inX * 210, y: CENTER_Y }];
        break;
      case 'goal-clearance':
        raw = [{ x: r.x + dirA * 190, y: CENTER_Y - 110 }, { x: r.x + dirA * 190, y: CENTER_Y + 110 }, { x: r.x + dirA * 320, y: CENTER_Y }];
        break;
      case 'free-kick':
      case 'indirect-free-kick':
        raw = [{ x: r.x + dirA * 110, y: r.y - 70 }, { x: r.x + dirA * 110, y: r.y + 70 }, { x: r.x - dirA * 70, y: r.y + (r.y < CENTER_Y ? 60 : -60) }];
        break;
      case 'kickoff':
        raw = [{ x: CENTER_X - dirA * 40, y: CENTER_Y - 45 }, { x: CENTER_X - dirA * 40, y: CENTER_Y + 45 }];
        break;
      default: break;
    }
    return raw.map((p) => clampPt(p.x, p.y));
  }

  private applyRestartLimits(r: RestartSpec, t: Pt): Pt {
    const dirA = r.team === 'home' ? 1 : -1;
    let out = { ...t };
    if (r.kind === 'kickoff') {
      const dx = out.x - CENTER_X; const dy = out.y - CENTER_Y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 82) out = { x: CENTER_X + (dx / d) * 82, y: CENTER_Y + (dy / d) * 82 };
      return clampPt(out.x, out.y);
    }
    if (r.kind === 'goal-clearance') {
      out.x = r.team === 'home' ? Math.max(out.x, BOX_DEPTH + 25) : Math.min(out.x, FIELD_W - BOX_DEPTH - 25);
      return clampPt(out.x, out.y);
    }
    const minDist = 110;
    const dx = out.x - r.x; const dy = out.y - r.y;
    const d = Math.hypot(dx, dy);
    if (d < minDist) {
      const ux = d === 0 ? dirA : dx / d; const uy = d === 0 ? 0 : dy / d;
      out = { x: r.x + ux * minDist, y: r.y + uy * minDist };
    }
    return clampPt(out.x, out.y);
  }

  private buildLayout(r: Restart): void {
    r.targets.clear();
    const dirA = r.team === 'home' ? 1 : -1;
    const penaltyLike = r.kind === 'penalty' || r.kind === 'second-penalty';
    r.targets.set(r.taker, this.takerSpot(r));
    const others = this.players.filter((p) => p !== r.taker);

    others.filter((p) => p.role === 'GK').forEach((gk) => {
      const defendingPenalty = r.kind === 'penalty' && gk.side !== r.team;
      // Penalty: the defending keeper must stand ON his goal line
      const gx = defendingPenalty
        ? (gk.side === 'home' ? LINE + 10 : FIELD_W - LINE - 10)
        : (gk.side === 'home' ? 67 : FIELD_W - 67);
      const gy = penaltyLike && gk.side !== r.team ? CENTER_Y : Phaser.Math.Clamp(r.y, CENTER_Y - 36, CENTER_Y + 36);
      r.targets.set(gk, { x: gx, y: gy });
    });

    const field = others.filter((p) => p.role !== 'GK');
    if (penaltyLike) {
      field.forEach((p, i) => r.targets.set(p, clampPt(r.x - dirA * (75 + Math.floor(i / 6) * 28), 90 + (i % 6) * 68)));
      return;
    }

    const options = this.optionSpots(r);
    const mates = field.filter((p) => p.side === r.team)
      .sort((a, b) => dist(a.sprite.x, a.sprite.y, r.x, r.y) - dist(b.sprite.x, b.sprite.y, r.x, r.y));
    mates.forEach((p, i) => r.targets.set(p, options[i] ?? this.formationSpot(p, r)));
    field.filter((p) => p.side !== r.team)
      .forEach((p) => r.targets.set(p, this.applyRestartLimits(r, this.formationSpot(p, r))));
  }

  private snapToLayout(r: Restart): void {
    this.players.forEach((p) => {
      const t = r.targets.get(p);
      if (!t) return;
      p.sprite.setPosition(t.x, t.y);
      p.shadow.setPosition(t.x + 2, t.y + SHADOW_DY);
      p.vx = 0; p.vy = 0;
    });
  }

  private updateRestart(dt: number): void {
    const r = this.restart;
    if (!r) { this.state = 'playing'; return; }
    r.elapsed += dt;

    this.ball.setPosition(r.x, r.y);
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;

    let settled = true;
    this.players.forEach((p) => {
      const t = r.targets.get(p);
      if (!t) return;
      if ((p === r.taker || p.side !== r.team) && dist(p.sprite.x, p.sprite.y, t.x, t.y) > 10) settled = false;
      this.steerTo(p, t.x, t.y, 240, dt);
    });

    if (!r.ready) {
      if (settled || r.elapsed > 2.4) {
        r.ready = true;
        this.snapToLayout(r);
      } else {
        this.updateRestartLabel(r);
        return;
      }
    }

    const info = RESTART_INFO[r.kind];
    r.timer -= dt;
    if (r.team === 'home') {
      this.humanRestartInput(r, dt);
    } else {
      r.cpuDelay -= dt;
      if (r.cpuDelay <= 0) this.cpuTakeRestart(r);
    }
    if (this.restart !== r) return;

    if (r.timer <= 0) {
      if (info.limit !== null) this.fourSecondViolation(r);
      else this.takeRestart(r, r.aim, r.charging ? r.power : 0.7);
      return;
    }
    this.updateRestartLabel(r);
  }

  private updateRestartLabel(r: Restart): void {
    const info = RESTART_INFO[r.kind];
    const s = info.label
      + (r.ready && info.limit !== null ? ` · ${Math.ceil(Math.max(0, r.timer))}s` : '')
      + (r.lofted ? ' · LOFTED' : '');
    if (this.restartLabel.text !== s) this.restartLabel.setText(s);
    this.restartLabel.setPosition(r.x, Math.max(16, r.y - 16));
  }

  private humanRestartInput(r: Restart, dt: number): void {
    const k = this.keys;
    const ax = Number(k.D.isDown || k.RIGHT.isDown) - Number(k.A.isDown || k.LEFT.isDown);
    const ay = Number(k.S.isDown || k.DOWN.isDown) - Number(k.W.isDown || k.UP.isDown);
    if (ax || ay) r.aim = Math.atan2(ay, ax);
    if (Phaser.Input.Keyboard.JustDown(k.Z)) r.lofted = !r.lofted;
    if (Phaser.Input.Keyboard.JustDown(k.C)) { r.charging = true; r.power = 0.15; }
    if (r.charging) r.power = Math.min(1, r.power + dt * 1.1);
    this.drawAim(r);
    if (r.charging && Phaser.Input.Keyboard.JustUp(k.C)) this.takeRestart(r, r.aim, r.power);
  }

  private drawAim(r: Restart): void {
    const g = this.aimGfx;
    g.clear();
    const len = 34 + (r.charging ? r.power * 110 : 0);
    const ex = r.x + Math.cos(r.aim) * len;
    const ey = r.y + Math.sin(r.aim) * len;
    g.lineStyle(3, r.lofted ? 0x8ecae6 : 0xffd23f, 0.9).lineBetween(r.x, r.y, ex, ey);
    g.fillStyle(r.lofted ? 0x8ecae6 : 0xffd23f, 1).fillCircle(ex, ey, 3);
    const bx = r.x - 25;
    const by = r.y > FIELD_H - 40 ? r.y - 30 : r.y + 22;
    g.fillStyle(0x000000, 0.6).fillRect(bx, by, 50, 6);
    g.fillStyle(r.power > 0.8 ? 0xef476f : 0x06d6a0, 1).fillRect(bx, by, 50 * (r.charging ? r.power : 0), 6);
  }

  private cpuTakeRestart(r: Restart): void {
    const info = RESTART_INFO[r.kind];
    const dirA = r.team === 'home' ? 1 : -1;
    const goalX = dirA === 1 ? FIELD_W - 8 : 8;
    let tx: number; let ty: number; let shot = false;
    const toGoal = Math.abs(goalX - r.x);

    if (r.kind === 'penalty' || r.kind === 'second-penalty' || (r.kind === 'free-kick' && toGoal < 320)) {
      tx = goalX; ty = CENTER_Y + Phaser.Math.Between(-40, 40); shot = true;
    } else if (r.kind === 'corner') {
      tx = goalX - dirA * Phaser.Math.Between(90, 120); ty = CENTER_Y + Phaser.Math.Between(-45, 45);
    } else {
      const mate = this.findOpenTeammate(r.team, r.x, r.y, r.taker);
      if (mate) { tx = mate.sprite.x; ty = mate.sprite.y; }
      else { tx = r.x + dirA * 200; ty = CENTER_Y; }
    }
    if (shot) r.lofted = Math.random() < 0.35;
    const aim = Math.atan2(ty - r.y, tx - r.x);
    const speed = Phaser.Math.Clamp(Math.hypot(tx - r.x, ty - r.y) * 1.3, info.min, info.max);
    const power = shot ? Phaser.Math.FloatBetween(0.8, 1) : (speed - info.min) / (info.max - info.min);
    this.takeRestart(r, aim, power);
  }

  private takeRestart(r: Restart, aim: number, power: number): void {
    if (this.restart !== r) return;
    const info = RESTART_INFO[r.kind];
    const speed = info.min + (info.max - info.min) * Phaser.Math.Clamp(power, 0, 1);
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    if (r.kind === 'kick-in') {
      if (r.y < CENTER_Y && vy < 0) vy = -vy;
      if (r.y > CENTER_Y && vy > 0) vy = -vy;
    }
    if (r.kind === 'corner') {
      if (r.x < CENTER_X && vx < 0) vx = -vx;
      if (r.x > CENTER_X && vx > 0) vx = -vx;
      if (r.y < CENTER_Y && vy < 0) vy = -vy;
      if (r.y > CENTER_Y && vy > 0) vy = -vy;
    }

    let action: ActionType = 'pass';
    if (r.kind === 'goal-clearance') action = 'throw';
    else if (r.kind === 'penalty' || r.kind === 'second-penalty') action = 'shoot';
    else if ((r.kind === 'corner' || r.kind === 'free-kick') && power > 0.6) action = 'shoot';

    // Shots at goal get a real height; other restarts only change height when lofted
    const goalX = r.team === 'home' ? FIELD_W - LINE : LINE;
    let lift = info.lift + (r.lofted ? 100 : 0);
    if (r.kind === 'penalty' || r.kind === 'second-penalty' || (r.kind === 'free-kick' && action === 'shoot')) {
      lift = shotLiftFor(speed, Math.abs(goalX - r.x), r.lofted);
    }

    this.restart = null;
    this.state = 'playing';
    this.kickoffLock = 0.25;
    this.restartLabel.setText('');
    this.aimGfx.clear();

    this.kickBall(vx, vy, r.taker, lift, action);
    r.taker.cooldown = 1.0;
    this.indirectPending = info.indirect ? { team: r.team, taker: r.taker } : null;
    if (r.kind === 'penalty') this.keeperAnticipate(other(r.team));   // the keeper commits to a guess

    if (r.kind === 'penalty' || r.kind === 'second-penalty') { this.playSound('shoot'); this.cameraShake = 0.2; }
    else this.playSound('kick');
    if (r.team === 'home') this.selectControlled();
    this.setMessage(`${info.label} taken — play on!`);
  }

  private fourSecondViolation(r: Restart): void {
    const opp = other(r.team);
    let spec: RestartSpec;
    let msg: string;
    switch (r.kind) {
      case 'kick-in':
        spec = { kind: 'kick-in', team: opp, x: r.x, y: r.y };
        msg = '⏱ 4-SECOND RULE! Kick-in to ' + teamName(opp); break;
      case 'corner':
        spec = clearanceSpec(opp);
        msg = '⏱ 4-SECOND RULE! Goal clearance to ' + teamName(opp); break;
      case 'goal-clearance':
        spec = { kind: 'indirect-free-kick', team: opp, x: r.team === 'home' ? BOX_DEPTH : FIELD_W - BOX_DEPTH, y: CENTER_Y };
        msg = '⏱ 4-SECOND RULE! Indirect free kick to ' + teamName(opp); break;
      default:
        spec = { kind: 'indirect-free-kick', team: opp, x: r.x, y: r.y };
        msg = '⏱ 4-SECOND RULE! Indirect free kick to ' + teamName(opp); break;
    }
    this.startRestart(spec);
    this.setMessage(`${msg} · ${this.restart!.baseMsg}`);
  }

  // ═══════════════ GOAL ═══════════════

  private scoreGoal(side: TeamSide): void {
    if (this.goalScored) return;

    if (this.indirectPending) {
      const pend = this.indirectPending;
      this.indirectPending = null;
      this.shotMissed();
      if (side === pend.team) {
        this.startRestart(clearanceSpec(other(side)));
        this.setMessage('No goal — direct from an indirect restart · ' + this.restart!.baseMsg);
      } else {
        this.startRestart(cornerSpec(side, this.ball.y));
        this.setMessage('Own goal direct from restart — corner · ' + this.restart!.baseMsg);
      }
      return;
    }

    this.goalScored = true;
    this.shooter = null;
    if (side === 'home') this.homeScore++; else this.awayScore++;

    this.state = 'goal';
    this.restart = null;
    this.gkHolder = null;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.updateHud();

    const teamLabel = side === 'home' ? 'ROCKETS' : 'COMETS';
    this.showGoalCelebration('GOAL!!!', `${teamLabel} SCORE!`);
    this.flashScreen(0xffffff, 0.7);
    this.cameraShake = 0.4;
    this.playSound('goal');

    const confettiX = side === 'home' ? FIELD_W * 0.75 : FIELD_W * 0.25;
    for (let i = 0; i < 50; i++) this.spawnConfetti(confettiX, FIELD_H / 2);

    const now = this.time.now;
    this.players.forEach((p) => {
      p.vx = 0; p.vy = 0;
      if (p.side === side) {
        p.celebrating = true;
        p.celebrateUntil = now + 2500;
        p.act = null;
      }
    });

    // The conceding keeper reacts (hands on knees); a diving keeper first finishes his dive pose
    const conceder = this.keeperOf(other(side)).gk!;
    conceder.mode = 'concede'; conceder.t = 0; conceder.plan = null; conceder.result = 'none';
    conceder.extNow = 0; conceder.flickT = 0;

    this.setMessage(`⚽ GOAL! ${teamName(side)} score!`);

    this.goalTimer = this.time.delayedCall(2800, () => {
      this.goalScored = false;
      this.players.forEach((p) => { p.celebrating = false; });
      this.goalText.setAlpha(0);
      this.goalSubText.setAlpha(0);
      if (this.half === 3) { this.endMatch(); return; }
      this.startKickoff(other(side));
    });
  }

  private showGoalCelebration(big: string, sub: string): void {
    this.goalText.setText(big).setAlpha(1).setScale(0.2);
    this.tweens.add({
      targets: this.goalText, scale: 1.1, duration: 350, ease: 'Back.easeOut',
      yoyo: true, hold: 1800, onComplete: () => { this.goalText.setAlpha(0); },
    });
    this.goalSubText.setText(sub).setAlpha(0);
    this.tweens.add({ targets: this.goalSubText, alpha: 1, delay: 300, duration: 300, hold: 1700, yoyo: true });
  }

  private flashScreen(color: number, alpha: number): void {
    this.goalFlash.setFillStyle(color, 1).setAlpha(alpha);
    this.tweens.add({ targets: this.goalFlash, alpha: 0, duration: 500, ease: 'Cubic.easeOut' });
  }

  // ═══════════════ PARTICLES / CAMERA ═══════════════

  private spawnConfetti(x: number, y: number): void {
    const colors = [0xffd23f, 0xef476f, 0x06d6a0, 0x118ab2, 0xffffff];
    const color = colors[Phaser.Math.Between(0, colors.length - 1)];
    const obj = this.add
      .rectangle(x + Phaser.Math.Between(-20, 20), y + Phaser.Math.Between(-20, 20),
        Phaser.Math.Between(3, 6), Phaser.Math.Between(3, 6), color)
      .setDepth(49);
    this.particles.push({ obj, vx: Phaser.Math.Between(-180, 180), vy: Phaser.Math.Between(-320, -80), life: 2.5, maxLife: 2.5 });
  }

  private spawnDustParticles(x: number, y: number): void {
    for (let i = 0; i < 6; i++) {
      const obj = this.add.circle(x, y, Phaser.Math.Between(2, 4), 0xbfa678, 0.6).setDepth(14);
      this.particles.push({ obj, vx: Phaser.Math.Between(-60, 60), vy: Phaser.Math.Between(-50, 10), life: 0.4, maxLife: 0.4 });
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      (p.obj as any).x += p.vx * dt;
      (p.obj as any).y += p.vy * dt;
      p.vy += 350 * dt;
      p.life -= dt;
      p.obj.setAlpha(Math.max(0, p.life / p.maxLife));
      if ('rotation' in p.obj) (p.obj as any).rotation += dt * 4;
      if (p.life <= 0) { p.obj.destroy(); this.particles.splice(i, 1); }
    }
  }

  private updateCamera(dt: number): void {
    if (this.cameraShake > 0) {
      const intensity = this.cameraShake * 8;
      this.cameras.main.setScroll(Phaser.Math.Between(-intensity, intensity), Phaser.Math.Between(-intensity, intensity));
      this.cameraShake -= dt;
      if (this.cameraShake <= 0) { this.cameraShake = 0; this.cameras.main.setScroll(0, 0); }
    }
  }

  // ═══════════════ SOUND ═══════════════

  private beep(type: OscillatorType, f0: number, f1: number | null, gain: number, dur: number, delay = 0): void {
    const ctx = this.audioCtx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t);
    o.stop(t + dur);
  }

  private playSound(type: 'kick' | 'pass' | 'shoot' | 'goal' | 'tackle'): void {
    if (!this.audioCtx) return;
    try {
      switch (type) {
        case 'kick': this.beep('square', 200, null, 0.12, 0.1); break;
        case 'pass': this.beep('triangle', 350, null, 0.08, 0.08); break;
        case 'shoot': this.beep('sawtooth', 180, 80, 0.15, 0.2); break;
        case 'tackle': this.beep('square', 120, null, 0.12, 0.06); break;
        case 'goal': [523, 659, 784, 1047].forEach((f, i) => this.beep('square', f, null, 0.12, 0.25, i * 0.12)); break;
      }
    } catch (_e) { /* audio context may be suspended */ }
  }

  // ═══════════════ HELPERS ═══════════════

  private resetMatch(): void {
    this.goalTimer?.remove(false);
    this.particles.forEach((p) => p.obj.destroy());
    this.particles = [];
    this.tweens.killAll();

    this.goalText.setAlpha(0);
    this.goalSubText.setAlpha(0);
    this.goalFlash.setAlpha(0);
    this.cameras.main.setScroll(0, 0);
    this.cameraShake = 0;
    this.restartLabel.setText('');
    this.aimGfx.clear();

    this.homeScore = 0;
    this.awayScore = 0;
    this.remaining = HALF_SECONDS;
    this.half = 1;
    this.paused = false;
    this.ended = false;
    this.clockAcc = 0;
    this.goalScored = false;
    this.restart = null;
    this.indirectPending = null;
    this.gkHolder = null;
    this.shooter = null;
    this.foulCount = { home: 0, away: 0 };
    if (this.hint) this.hint.style.display = 'none';
    this.startKickoff(this.openingKickoff);
    this.updateHud();
    this.setMessage('New match — ' + this.restart!.baseMsg);
  }

  private selectControlled(): void {
    this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
    this.refreshMarker();
  }

  private refreshMarker(): void {
    this.players.forEach((p) => p.ring.setVisible(p === this.controlled));
  }

  private nearestPlayer(side: TeamSide, x: number, y: number): Footballer {
    const outfield = this.players.filter((p) => p.side === side && p.role !== 'GK');
    if (outfield.length === 0) return this.players.find((p) => p.side === side)!;
    return outfield.reduce((best, p) =>
      dist(p.sprite.x, p.sprite.y, x, y) < dist(best.sprite.x, best.sprite.y, x, y) ? p : best);
  }

  private updateHud(): void {
    if (this.homeScoreEl) this.homeScoreEl.textContent = String(this.homeScore);
    if (this.awayScoreEl) this.awayScoreEl.textContent = String(this.awayScore);
    if (this.clockEl) {
      const mins = String(Math.floor(this.remaining / 60)).padStart(2, '0');
      const secs = String(this.remaining % 60).padStart(2, '0');
      this.clockEl.textContent = `${mins}:${secs}`;
    }
    if (this.periodEl) {
      this.periodEl.textContent = this.half === 1 ? 'FIRST HALF' : this.half === 2 ? 'SECOND HALF' : 'EXTRA TIME';
    }
    if (this.statusEl && this.message) {
      this.statusEl.innerHTML = `<span class="status-icon">▶</span> ${this.message}`;
    }
  }

  private setMessage(message: string): void {
    this.message = message;
    this.updateHud();
  }
}

// ═══════════════ BOOT ═══════════════

if (new URLSearchParams(window.location.search).has('selftest')) runSelfTests();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: FIELD_W,
  height: FIELD_H,
  backgroundColor: '#1b6849',
  antialias: false,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: FIELD_W, height: FIELD_H },
  render: { pixelArt: true, roundPixels: true },
  scene: [RetroKickScene],
});

(window as Window & { retroKickGame?: Phaser.Game }).retroKickGame = game;
