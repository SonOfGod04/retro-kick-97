import Phaser from 'phaser';
import './style.css';
import { GameAudio } from './audio';
import {
  TEAMS, DIFFS, HALF_OPTIONS, STYLE, setStyles, resolveStyles, colorDistance, scaleColor,
  defaultSettings, sanitizeSettings, settingsFromQuery, loadSettings, saveSettings,
} from './settings';
import type { MatchSettings, DiffParams } from './settings';
import { MenuUI, nextSelectable, cycleIndex } from './ui';
import { contextHint, CONTROLS_LINES, buildTitle, buildSetup, buildPause, buildConfirm, buildControls } from './screens';
import type { ScreenHost } from './screens';

// ═══════════════ CONSTANTS ═══════════════
const FIELD_W = 900;
const FIELD_H = 520;
const STAND = 56;                         // height of each spectator stand (above and below the pitch)
const GAME_H = FIELD_H + STAND * 2;       // the canvas is taller than the pitch to fit the arena
const TUNNEL_Y = -72;                     // players enter from here (above the top stand, off-screen)
const HALF_SECONDS = 120;
const EXTRA_TIME_SECONDS = 60;            // improved
const CENTER_X = FIELD_W / 2;
const CENTER_Y = FIELD_H / 2;
const LINE = 19;
const GOAL_HALF = 52;
const GOAL_HEIGHT = 40;
const BOX_DEPTH = 137;
const BOX_HALF_H = 125;
const PENALTY_SPOT_X = 112;
const SECOND_SPOT_X = 235;
const FOUL_LIMIT = 5;
const FOUR_SECONDS = 4;
const CONTACT_RADIUS = 15;
const SHADOW_DY = 6;

// Goalkeeper physics (Phase 3)
const E_MAX = 34;
const MIN_DIVE_LEAD = 0.165;
const HOLD_T = 0.14;
const FALL_T = 0.32;
const RECOVER_T = 0.45;
const HAND_R = 11;
const Z_WIN = 11;
const BODY_R = 11;

// Ball physics (Phase 5)
const G = 400;
const MAGNUS = 0.6;
const POST_R = 9;

type TeamSide = 'home' | 'away';
type GameState = 'intro' | 'playing' | 'restart' | 'goal' | 'halftime' | 'fulltime';
type RestartKind =
  | 'kickoff' | 'kick-in' | 'corner' | 'goal-clearance'
  | 'free-kick' | 'indirect-free-kick' | 'penalty' | 'second-penalty';
type ActionType = 'pass' | 'shoot' | 'throw' | 'tackle' | 'jump' | 'miss' | 'point' | 'whistle' | 'raise';
type SaveType = 'stand' | 'jump' | 'dive-low' | 'dive-high' | 'stretch';
type GkMode = 'ready' | 'diving' | 'fallen' | 'recovering' | 'concede';
type AnimName =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'turn' | 'celebrate' | ActionType
  | 'gk-ready' | 'gk-shuffle' | 'dive-low' | 'dive-high' | 'stretch' | 'jump-save'
  | 'catch' | 'parry' | 'fall' | 'recover' | 'concede';
type Tactic = 'balanced' | 'press' | 'defensive' | 'counter' | 'possession';
type Phase = 'attack' | 'defend' | 'loose';
type BallEvent = 'none' | 'bounce' | 'post' | 'bar';

interface Pt { x: number; y: number }
interface Sample { t: number; x: number; y: number; z: number }
interface Order { x: number; y: number; speed: number }
interface Slot { x: number; y: number; role: 'GK' | 'DEF' | 'MID' | 'FWD' }
interface RestartSpec { kind: RestartKind; team: TeamSide; x: number; y: number }
interface OutOfPlay { kind: 'goal' | 'kick-in' | 'corner' | 'goal-clearance'; team: TeamSide; x: number; y: number }
interface BallState { x: number; y: number; z: number; vx: number; vy: number; vz: number; curl: number; vspin: number }
interface SpinSpec { curl?: number; vspin?: number }

interface Kit {
  jersey: number; jerseyDark: number; shorts: number; socks: number; boots: number;
  skin: number; skinShade: number; hair: number; glove: number; longSleeves: boolean;
}
interface Action { type: ActionType; t: number; dur: number; aim?: number }
interface Gait { legAmp: number; armAmp: number; lean: number; elbowIn: number; cycle: number; stance: number }

interface SavePlan {
  type: SaveType;
  dirX: number; dirY: number;
  ext: number;
  zTarget: number;
  startAt: number;
  arrive: number;
  guess: boolean;
  reachable: boolean;
}

interface GkBrain {
  mode: GkMode;
  t: number;
  clock: number;
  plan: SavePlan | null;
  react: number;
  origX: number; origY: number;
  extNow: number; zNow: number;
  result: 'none' | 'catch' | 'parry' | 'block';
  flickT: number;
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
  gk: GkBrain | null;
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

interface TeamStats {
  passes: number; passOk: number; shots: number; onTarget: number; saves: number;
  intercepts: number; tackles: number; fouls: number; corners: number;
  poss: number; lineSum: number; lineN: number;
}

interface CrowdRow {
  g: Phaser.GameObjects.Graphics; side: TeamSide; phase: number; rowY: number;
  fans: { x: number; shirt: number; neutral: number; skin: number }[];
}

interface Entrance {
  t: number; short: boolean; lineT: number; announced: boolean; done: () => void;
  targets: Map<Footballer, { tx: number; ty: number; delay: number }>;
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

// ═══════════════ TACTICS (Phase 4) ═══════════════
interface TacticParams {
  label: string;
  lineShift: number;
  pressRadius: number;
  pressers: number;
  width: number;
  support: number;
  forwardRuns: number;
  shootRange: number;
  shootThr: number;
  riskPass: number;
  holdTime: number;
  tempo: number;
  oneTwo: number;
  shortBias: number;
  markDist: number;
  counterMs: number;
}

const TACTICS: Record<Tactic, TacticParams> = {
  balanced:   { label: 'BALANCED',    lineShift: 0,   pressRadius: 150, pressers: 1, width: 1.0,  support: 95,  forwardRuns: 0.5,  shootRange: 300, shootThr: 0.40, riskPass: 0.4,  holdTime: 0.5,  tempo: 1.0,  oneTwo: 0.3,  shortBias: 0.1,  markDist: 24, counterMs: 0 },
  press:      { label: 'HIGH PRESS',  lineShift: 55,  pressRadius: 280, pressers: 2, width: 0.95, support: 90,  forwardRuns: 0.6,  shootRange: 300, shootThr: 0.42, riskPass: 0.5,  holdTime: 0.35, tempo: 1.1,  oneTwo: 0.3,  shortBias: 0.1,  markDist: 16, counterMs: 0 },
  defensive:  { label: 'DEFENSIVE',   lineShift: -75, pressRadius: 95,  pressers: 1, width: 0.85, support: 100, forwardRuns: 0.15, shootRange: 240, shootThr: 0.50, riskPass: 0.25, holdTime: 0.6,  tempo: 0.95, oneTwo: 0.1,  shortBias: 0.2,  markDist: 30, counterMs: 0 },
  counter:    { label: 'COUNTER',     lineShift: -35, pressRadius: 120, pressers: 1, width: 1.0,  support: 110, forwardRuns: 0.9,  shootRange: 320, shootThr: 0.34, riskPass: 0.85, holdTime: 0.15, tempo: 1.05, oneTwo: 0.15, shortBias: -0.1, markDist: 26, counterMs: 3500 },
  possession: { label: 'POSSESSION',  lineShift: 25,  pressRadius: 150, pressers: 1, width: 1.15, support: 78,  forwardRuns: 0.25, shootRange: 260, shootThr: 0.50, riskPass: 0.15, holdTime: 0.9,  tempo: 0.98, oneTwo: 0.5,  shortBias: 0.5,  markDist: 24, counterMs: 0 },
};
const TACTIC_ORDER: Tactic[] = ['balanced', 'press', 'defensive', 'counter', 'possession'];

// ═══════════════ ANIMATION DATA (Phase 2) ═══════════════

const ACTIONS: Record<ActionType, { dur: number; start: number }> = {
  pass:    { dur: 0.34, start: 0.2 },
  shoot:   { dur: 0.45, start: 0.3 },
  throw:   { dur: 0.40, start: 0.15 },
  tackle:  { dur: 0.40, start: 0 },
  jump:    { dur: 0.50, start: 0 },
  miss:    { dur: 1.20, start: 0 },
  point:   { dur: 1.40, start: 0 },   // referee signals (Phase 6)
  whistle: { dur: 0.70, start: 0 },
  raise:   { dur: 4.50, start: 0 },
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
const NEUTRAL_FANS = [0xffd23f, 0x222222, 0x06d6a0];

function makeKit(side: TeamSide, role: Footballer['role'], number: number): Kit {
  const st = STYLE[side];
  const [skin, skinShade] = SKINS[(number * 3 + (side === 'home' ? 0 : 2)) % SKINS.length];
  const hair = HAIRS[(number + (side === 'home' ? 1 : 3)) % HAIRS.length];
  if (role === 'GK') {
    return {
      jersey: st.gk, jerseyDark: scaleColor(st.gk, 0.65),
      shorts: 0x333333, socks: 0x333333, boots: 0x111111,
      skin, skinShade, hair, glove: 0xffe14d, longSleeves: true,
    };
  }
  return {
    jersey: st.jersey, jerseyDark: st.jerseyDark, shorts: st.shorts, socks: st.socks, boots: 0x161616,
    skin, skinShade, hair, glove: skin, longSleeves: false,
  };
}

const REF_KIT: Kit = {
  jersey: 0xf2d300, jerseyDark: 0xb89c00, shorts: 0x111111, socks: 0x111111, boots: 0x111111,
  skin: 0xd9a066, skinShade: 0xb98048, hair: 0x111111, glove: 0xd9a066, longSleeves: false,
};

// ═══════════════ PURE RULE FUNCTIONS (Phase 1) ═══════════════
const other = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');
const teamName = (s: TeamSide): string => STYLE[s].name;
const dist = Phaser.Math.Distance.Between;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (u: number): number => 1 - (1 - u) * (1 - u);
const clampPt = (x: number, y: number): Pt => ({
  x: Phaser.Math.Clamp(x, 31, FIELD_W - 31),
  y: Phaser.Math.Clamp(y, 31, FIELD_H - 31),
});
const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

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

// ═══════════════ PURE PRESENTATION LOGIC (Phase 6) ═══════════════

/** 125 -> "02:05" */
function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole-number possession percentages that always add up to 100. */
function possessionPct(h: number, a: number): [number, number] {
  const tot = h + a;
  if (tot <= 0) return [50, 50];
  const ph = Math.round((100 * h) / tot);
  return [ph, 100 - ph];
}

function passAccuracy(ok: number, total: number): number {
  return total <= 0 ? 0 : Math.round((100 * ok) / total);
}

/**  excitement relaxes back to its baseline: a spike fades slowly, a lull recovers quickly. */
function nextExcite(cur: number, base: number, dt: number): number {
  return cur > base ? cur - (cur - base) * (1 - Math.exp(-dt * 0.55)) : cur + (base - cur) * (1 - Math.exp(-dt * 2));
}

/** Accumulated-foul pips: five fill up, the 6th and later turn them red (10 m free kick territory). */
function pips(fouls: number): { filled: number; red: boolean } {
  return { filled: Math.min(5, fouls), red: fouls > FOUL_LIMIT };
}

/** Where a player stands in the pre-match line-up (home column left of the halfway line, away right). */
function lineupSpot(side: TeamSide, i: number): Pt {
  return { x: CENTER_X + (side === 'home' ? -62 : 62), y: CENTER_Y + (i - 3) * 50 };
}

/** The referee keeps an arm raised during play after an indirect free kick, until another player touches the ball. */
function refKeepsArmUp(kind: RestartKind): boolean {
  return kind === 'indirect-free-kick';
}

/** A higher-priority banner is never covered by a lower one while it is showing. */
function bannerAllowed(now: number, until: number, curPrio: number, prio: number): boolean {
  return now >= until || prio >= curPrio;
}

// ═══════════════ PURE BALL PHYSICS (Phase 5) ═══════════════

let LAST_IMPACT = 0;

function distToSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-6) return { d: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return { d: Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)), t };
}

function reflect(vx: number, vy: number, nx: number, ny: number, e: number, tf: number): Pt {
  const vn = vx * nx + vy * ny;
  if (vn >= 0) return { x: vx, y: vy };
  const tx = vx - vn * nx;
  const ty = vy - vn * ny;
  return { x: tx * tf - e * vn * nx, y: ty * tf - e * vn * ny };
}

function collideGoal(s: BallState, x0: number, y0: number, z0: number): BallEvent {
  for (const gl of [LINE, FIELD_W - LINE]) {
    const sideIn = gl === LINE ? 1 : -1;
    const cameFromField = (x0 - gl) * sideIn > 0;
    if (cameFromField && (s.x - gl) * sideIn <= 0) {
      const t = (gl - x0) / (s.x - x0 || 1e-9);
      const yc = y0 + (s.y - y0) * t;
      const zc = z0 + (s.z - z0) * t;
      if (Math.abs(yc - CENTER_Y) <= GOAL_HALF && Math.abs(zc - GOAL_HEIGHT) < 5) {
        s.x = gl + sideIn * 3; s.y = yc; s.z = zc;
        s.vx = -s.vx * 0.55; s.vy *= 0.8;
        s.vz = zc >= GOAL_HEIGHT ? Math.abs(s.vz) * 0.5 + 40 : -Math.abs(s.vz) * 0.5 - 30;
        return 'bar';
      }
    }
    if (s.z < GOAL_HEIGHT) {
      for (const py of [CENTER_Y - GOAL_HALF, CENTER_Y + GOAL_HALF]) {
        const sg = distToSegment({ x: gl, y: py }, { x: x0, y: y0 }, { x: s.x, y: s.y });
        if (sg.d < POST_R) {
          const cx = x0 + (s.x - x0) * sg.t;
          const cy = y0 + (s.y - y0) * sg.t;
          let nx = cx - gl; let ny = cy - py;
          const nl = Math.hypot(nx, ny);
          if (nl < 1e-6) { nx = sideIn; ny = 0; } else { nx /= nl; ny /= nl; }
          const r = reflect(s.vx, s.vy, nx, ny, 0.7, 0.9);
          s.vx = r.x; s.vy = r.y;
          s.x = gl + nx * (POST_R + 0.5);
          s.y = py + ny * (POST_R + 0.5);
          return 'post';
        }
      }
    }
  }
  return 'none';
}

function stepBall(s: BallState, dt: number): BallEvent {
  const sp0 = Math.hypot(s.vx, s.vy);
  if (s.curl !== 0 && sp0 > 30) {
    const a = MAGNUS * s.curl * sp0 * (s.z > 0.5 ? 1 : 0.8);
    const px = -s.vy / sp0;
    const py = s.vx / sp0;
    s.vx += px * a * dt;
    s.vy += py * a * dt;
    s.curl *= Math.exp(-0.35 * dt);
    if (Math.abs(s.curl) < 0.02) s.curl = 0;
  }

  const x0 = s.x; const y0 = s.y; const z0 = s.z;
  const airborne = s.z > 0.01 || s.vz > 0;
  const g = airborne ? G * (1 + 0.35 * s.vspin) : G;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;
  s.vz -= g * dt;
  if (airborne) s.vspin *= Math.exp(-0.8 * dt);

  let ev: BallEvent = 'none';
  if (s.z <= 0) {
    s.z = 0;
    if (s.vz < -25) {
      LAST_IMPACT = -s.vz;
      s.vz = -s.vz * 0.45;
      const hf = Phaser.Math.Clamp(0.88 + 0.12 * s.vspin, 0.6, 1.05);
      s.vx *= hf; s.vy *= hf;
      s.vspin *= 0.4;
      ev = 'bounce';
    } else {
      s.vz = 0;
    }
  }

  const sp = Math.hypot(s.vx, s.vy);
  if (s.z > 1) {
    const f = Math.exp(-(0.10 + 0.0002 * sp) * dt);
    s.vx *= f; s.vy *= f;
  } else {
    const f = Math.exp(-0.846 * dt);
    s.vx *= f; s.vy *= f;
    const sp2 = Math.hypot(s.vx, s.vy);
    const ns = Math.max(0, sp2 - 12 * dt);
    const k = sp2 > 0 ? ns / sp2 : 0;
    s.vx *= k; s.vy *= k;
  }

  const gev = collideGoal(s, x0, y0, z0);
  if (gev !== 'none') ev = gev;
  return ev;
}

function simulateToLine(
  from: Pt, angle: number, speed: number, lift: number, curl: number, vspin: number, lineX: number, maxT = 2
): { y: number; z: number; t: number } | null {
  const s: BallState = { x: from.x, y: from.y, z: 0, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, vz: lift, curl, vspin };
  const dirX = lineX > from.x ? 1 : -1;
  const dt = 1 / 60;
  for (let i = 1; i <= Math.round(maxT / dt); i++) {
    const px = s.x; const py = s.y; const pz = s.z;
    stepBall(s, dt);
    if ((s.x - lineX) * dirX >= 0) {
      const k = (lineX - px) / ((s.x - px) || 1e-9);
      return { y: py + (s.y - py) * k, z: pz + (s.z - pz) * k, t: i * dt };
    }
    if (Math.hypot(s.vx, s.vy) < 8) return null;
  }
  return null;
}

function solveAim(from: Pt, target: Pt, speed: number, lift: number, curl: number, vspin: number): number {
  let a = Math.atan2(target.y - from.y, target.x - from.x);
  const dxAbs = Math.abs(target.x - from.x) || 1;
  const dirX = target.x > from.x ? 1 : -1;
  for (let i = 0; i < 5; i++) {
    const r = simulateToLine(from, a, speed, lift, curl, vspin, target.x);
    if (!r) break;
    const err = target.y - r.y;
    if (Math.abs(err) < 2) break;
    a += dirX * Math.atan(err / dxAbs);
  }
  return a;
}

function solveLift(from: Pt, angle: number, speed: number, targetZ: number, lineX: number): number {
  let best = 20;
  let bestErr = Infinity;
  for (let vz = 20; vz <= 320; vz += 10) {
    const r = simulateToLine(from, angle, speed, vz, 0, 0, lineX);
    if (!r) continue;
    const e = Math.abs(r.z - targetZ);
    if (e < bestErr) { bestErr = e; best = vz; }
  }
  return best;
}

function lobLanding(v: number, vz: number, vspin: number): number {
  const s: BallState = { x: 250, y: CENTER_Y, z: 0, vx: v, vy: 0, vz, curl: 0, vspin };
  const x0 = s.x;
  for (let i = 0; i < 240; i++) {
    if (stepBall(s, 1 / 60) === 'bounce') return s.x - x0;
  }
  return s.x - x0;
}

function solveLob(d: number): { speed: number; vz: number; vspin: number } {
  const vspin = -0.6;
  const gEff = G * (1 + 0.35 * vspin);
  const T = Phaser.Math.Clamp(d / 320, 0.5, 0.95);
  const vz = (gEff * T) / 2;
  let v = d / (T * 0.92);
  for (let i = 0; i < 5; i++) {
    const land = lobLanding(v, vz, vspin);
    if (land < 1) break;
    v *= d / land;
  }
  return { speed: v, vz, vspin };
}

// ═══════════════ PURE GOALKEEPER LOGIC (Phase 3) ═══════════════

const DIVE_T: Record<SaveType, number> = { stand: 0, jump: 0.34, 'dive-low': 0.28, 'dive-high': 0.30, stretch: 0.32 };

function shotLiftFor(speed: number, distance: number, high: boolean): number {
  if (!high) return Phaser.Math.Between(10, 40);
  const T = Math.max(0.12, distance / (speed * 0.92));
  const zt = Phaser.Math.Between(24, 34);
  return Phaser.Math.Clamp((zt + 200 * T * T) / T, 40, 300);
}

function keeperDepth(d: number): number {
  if (d >= 420) return 70;
  if (d >= 250) return 82 - ((d - 250) / 170) * 12;
  if (d >= 120) return 56 + ((d - 120) / 130) * 26;
  return 46 + (d / 120) * 10;
}

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
    if (s.t - react < MIN_DIVE_LEAD) continue;
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

function resolveSaveContact(speed: number, quality: number, z: number): 'catch' | 'parry' | 'tip-over' {
  if (speed <= 240) return 'catch';
  if (speed <= 300 && quality >= 0.35) return 'catch';
  return z > 30 ? 'tip-over' : 'parry';
}

// ═══════════════ PURE TEAM-AI LOGIC (Phase 4) ═══════════════

function laneBlocked(a: Pt, b: Pt, opps: Pt[], radius: number): boolean {
  for (const o of opps) {
    const s = distToSegment(o, a, b);
    if (s.d < radius && s.t > 0.05 && s.t < 0.95) return true;
  }
  return false;
}

function scorePass(from: Pt, to: Pt, att: number, opps: Pt[], T: TacticParams, lob = false): number {
  const goalX = att === 1 ? FIELD_W - LINE : LINE;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  let s = att * (to.x - from.x) * (0.08 + T.riskPass * 0.22);
  let minOpp = 90;
  for (const o of opps) minOpp = Math.min(minOpp, Math.hypot(o.x - to.x, o.y - to.y));
  s += (Math.min(minOpp, 90) - 30) * 0.5;
  if (lob) s -= 12;
  else if (laneBlocked(from, to, opps, 15)) s -= 70;
  if (d > 300) s -= (d - 300) * 0.25;
  if (d < 45) s -= 25;
  s -= Math.max(0, d - 150) * T.shortBias * 0.15;
  s += Math.max(0, 300 - Math.abs(goalX - to.x)) * 0.05;
  return s;
} 

function shotQuality(pos: Pt, att: number, opps: Pt[], gk: Pt | null): number {
  const goalX = att === 1 ? FIELD_W - LINE : LINE;
  if (att * (goalX - pos.x) < 25) return 0;
  const d = Math.hypot(goalX - pos.x, CENTER_Y - pos.y);
  const a1 = Math.atan2(CENTER_Y - GOAL_HALF - pos.y, goalX - pos.x);
  const a2 = Math.atan2(CENTER_Y + GOAL_HALF - pos.y, goalX - pos.x);
  const width = Math.abs(a1 - a2);
  let q = (1 - d / 380) * 0.55 + Math.min(1, width / 1.0) * 0.45;
  const goalC: Pt = { x: goalX, y: CENTER_Y };
  for (const o of opps) {
    const s = distToSegment(o, pos, goalC);
    if (s.d < 16 && s.t > 0.05 && s.t < 0.95) q -= 0.25;
  }
  if (gk) q += Phaser.Math.Clamp((Math.abs(gk.y - CENTER_Y) - 10) / 100, 0, 0.1);
  return Phaser.Math.Clamp(q, 0, 1);
}

function assignMarks(defs: Pt[], opps: Pt[], ownGoalX: number): number[] {
  const res = defs.map(() => -1);
  const order = opps
    .map((o, i) => ({ i, danger: 600 - Math.abs(o.x - ownGoalX) - Math.abs(o.y - CENTER_Y) * 0.3 }))
    .sort((a, b) => b.danger - a.danger);
  const used = new Set<number>();
  for (const o of order) {
    let bi = -1;
    let bd = Infinity;
    defs.forEach((d, di) => {
      if (used.has(di)) return;
      const dd = Math.hypot(d.x - opps[o.i].x, d.y - opps[o.i].y);
      if (dd < bd) { bd = dd; bi = di; }
    });
    if (bi < 0) break;
    used.add(bi);
    res[bi] = o.i;
  }
  return res;
}

function shapeTarget(slot: Slot, side: TeamSide, phase: Phase, tactic: Tactic, ball: Pt): Pt {
  const att = side === 'home' ? 1 : -1;
  const T = TACTICS[tactic];
  const ballRel = (ball.x - CENTER_X) * att;
  const shift = Phaser.Math.Clamp(ballRel * 0.45, -90, 140);
  let roleOff = 0;
  if (phase === 'attack') {
    roleOff = (slot.role === 'DEF' ? 25 : slot.role === 'MID' ? 60 : 100) + T.lineShift * 0.4;
  } else if (phase === 'defend') {
    roleOff = (slot.role === 'FWD' ? -20 : slot.role === 'MID' ? -30 : -40) + T.lineShift;
    if (slot.role === 'FWD' && tactic === 'counter') roleOff = 40;
  }
  const x = slot.x + att * (shift + roleOff);
  let y = CENTER_Y + (slot.y - CENTER_Y) * T.width * (phase === 'attack' ? 1.1 : 0.85);
  if (phase !== 'attack') y += (ball.y - y) * 0.25;
  return clampPt(x, y);
}

/** Run with ?selftest in the URL — logs the Phase 1–6 pure-logic tests. */
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
  t('P3 far-corner shot -> full stretch, reach capped', far?.type === 'stretch' && far.ext <= E_MAX && far.reachable === false);
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
  // ── Phase 4
  const mid: Pt = { x: 450, y: 260 };
  const defPress = shapeTarget({ x: 250, y: 145, role: 'DEF' }, 'home', 'defend', 'press', mid);
  const defDeep = shapeTarget({ x: 250, y: 145, role: 'DEF' }, 'home', 'defend', 'defensive', mid);
  t('P4 pressing team defends higher than the defensive team', defPress.x > defDeep.x + 60);
  const fwdAtt = shapeTarget({ x: 490, y: 155, role: 'FWD' }, 'home', 'attack', 'balanced', mid);
  const fwdDef = shapeTarget({ x: 490, y: 155, role: 'FWD' }, 'home', 'defend', 'balanced', mid);
  t('P4 forwards push up when attacking vs defending', fwdAtt.x > fwdDef.x + 50);
  const wPoss = shapeTarget({ x: 490, y: 155, role: 'FWD' }, 'home', 'attack', 'possession', mid);
  const wCtr = shapeTarget({ x: 490, y: 155, role: 'FWD' }, 'home', 'attack', 'counter', mid);
  t('P4 possession shape is wider than counter shape', Math.abs(wPoss.y - CENTER_Y) > Math.abs(wCtr.y - CENTER_Y));
  const yHigh = shapeTarget({ x: 390, y: 205, role: 'MID' }, 'home', 'defend', 'balanced', { x: 450, y: 100 });
  const yLow = shapeTarget({ x: 390, y: 205, role: 'MID' }, 'home', 'defend', 'balanced', { x: 450, y: 420 });
  t('P4 defending team shifts toward the ball side', yHigh.y < yLow.y);
  t('P4 away team mirrors home (attacks toward x=0)', shapeTarget({ x: 410, y: 155, role: 'FWD' }, 'away', 'attack', 'balanced', mid).x < CENTER_X);
  const qClose = shotQuality({ x: 700, y: 260 }, 1, [], null);
  t('P4 close central shot is better than a far wide one', qClose > 0.45 && shotQuality({ x: 300, y: 60 }, 1, [], null) < 0.2);
  t('P4 a blocker in the lane lowers shot quality', shotQuality({ x: 700, y: 260 }, 1, [{ x: 790, y: 260 }], null) < qClose - 0.15);
  t('P4 no shot when level with / behind the goal line', shotQuality({ x: 880, y: 260 }, 1, [], null) === 0);
  const pf = { x: 400, y: 260 };
  const openPass = scorePass(pf, { x: 550, y: 200 }, 1, [{ x: 475, y: 260 }], TACTICS.balanced);
  const blockedPass = scorePass(pf, { x: 550, y: 260 }, 1, [{ x: 475, y: 260 }], TACTICS.balanced);
  t('P4 open pass is valued above a blocked pass', openPass > blockedPass + 40);
  t('P4 forward pass is valued above a backward pass', scorePass(pf, { x: 520, y: 200 }, 1, [], TACTICS.balanced) > scorePass(pf, { x: 280, y: 200 }, 1, [], TACTICS.balanced));
  const shortLong = (T: TacticParams) => scorePass(pf, { x: 500, y: 260 }, 1, [], T) - scorePass(pf, { x: 700, y: 260 }, 1, [], T);
  t('P4 possession prefers short passes more than counter', shortLong(TACTICS.possession) > shortLong(TACTICS.counter));
  const marks = assignMarks([{ x: 200, y: 200 }, { x: 200, y: 320 }], [{ x: 150, y: 260 }, { x: 600, y: 260 }, { x: 300, y: 100 }], LINE);
  t('P4 most dangerous opponent is marked, each defender used once', marks[0] === 0 && marks[1] === 2 && new Set(marks).size === 2);
  t('P4 tactics differ in real parameters',
    TACTICS.press.pressers > TACTICS.balanced.pressers && TACTICS.press.pressRadius > TACTICS.defensive.pressRadius &&
    TACTICS.counter.forwardRuns > TACTICS.possession.forwardRuns && TACTICS.defensive.lineShift < TACTICS.balanced.lineShift &&
    TACTICS.balanced.lineShift < TACTICS.press.lineShift && TACTICS.counter.counterMs > 0);
  // ── Phase 5
  const mkB = (o: Partial<BallState>): BallState => ({ x: 450, y: 260, z: 0, vx: 0, vy: 0, vz: 0, curl: 0, vspin: 0, ...o });
  const spd = (s: BallState) => Math.hypot(s.vx, s.vy);
  const stepFor = (s: BallState, secs: number): void => { for (let n = 0; n < Math.round(secs * 60); n++) stepBall(s, 1 / 60); };
  const air = mkB({ vx: 300, vz: 300 }); stepFor(air, 0.5);
  const gnd = mkB({ vx: 300 }); stepFor(gnd, 0.5);
  t('P5 an airborne ball decelerates less than a rolling ball', spd(air) > spd(gnd) + 50);
  const drop = mkB({ z: 30 });
  let bounced = false; let maxAfter = 0;
  for (let n = 0; n < 240; n++) {
    const ev = stepBall(drop, 1 / 60);
    if (ev === 'bounce') bounced = true; else if (bounced) maxAfter = Math.max(maxAfter, drop.z);
  }
  t('P5 a dropped ball bounces low and comes to rest', bounced && maxAfter < 10 && drop.z === 0 && drop.vz === 0);
  const roll = mkB({ vx: 200 }); stepFor(roll, 5);
  t('P5 a rolling ball decelerates to a stop', spd(roll) < 1);
  const sa = simulateToLine({ x: 681, y: 260 }, 0, 300, 20, 0, 0, 881);
  const sb = simulateToLine({ x: 681, y: 260 }, 0, 520, 20, 0, 0, 881);
  t('P5 shot strength changes the outcome (a hard shot arrives much sooner)', !!sa && !!sb && sa.t - sb.t > 0.2);
  const lob = solveLob(260);
  const lobB = mkB({ x: 250, vx: lob.speed, vz: lob.vz, vspin: lob.vspin });
  let lobMax = 0;
  for (let n = 0; n < 60; n++) { stepBall(lobB, 1 / 60); lobMax = Math.max(lobMax, lobB.z); }
  const driveB = mkB({ x: 250, vx: 300, vz: 8 });
  let driveMax = 0;
  for (let n = 0; n < 60; n++) { stepBall(driveB, 1 / 60); driveMax = Math.max(driveMax, driveB.z); }
  t('P5 a lofted pass flies much higher than a driven pass', lobMax > 10 && driveMax < 3);
  t('P5 a lofted pass lands where it was aimed', Math.abs(lobLanding(lob.speed, lob.vz, lob.vspin) - 260) < 12);
  const cu = mkB({ vx: 400, vz: 120, curl: 0.9 }); stepFor(cu, 0.6);
  const st = mkB({ vx: 400, vz: 120 }); stepFor(st, 0.6);
  const cn = mkB({ vx: 400, vz: 120, curl: -0.9 }); stepFor(cn, 0.6);
  t('P5 curl bends the ball sideways, opposite curls go opposite ways', cu.y > st.y + 15 && cn.y < st.y - 15);
  const from: Pt = { x: 700, y: 110 };
  const aim = solveAim(from, { x: 881, y: 290 }, 420, 20, 0.9, 0);
  const rc = simulateToLine(from, aim, 420, 20, 0.9, 0, 881);
  const rs = simulateToLine(from, aim, 420, 20, 0, 0, 881);
  t('P5 a curled shot can be aimed to hit its target', !!rc && Math.abs(rc.y - 290) < 8);
  t('P5 the same aim without curl misses (curl really matters)', !!rs && Math.abs(rs.y - 290) > 6);
  const firstEvent = (s: BallState, steps: number): BallEvent => {
    for (let n = 0; n < steps; n++) { const ev = stepBall(s, 1 / 60); if (ev === 'post' || ev === 'bar') return ev; }
    return 'none';
  };
  const postB = mkB({ x: 100, y: CENTER_Y - GOAL_HALF, z: 5, vx: -400 });
  t('P5 the ball hits the post and comes back into play', firstEvent(postB, 60) === 'post' && postB.vx > 0);
  const barB = mkB({ x: 100, y: CENTER_Y, z: 40, vx: -400, vz: 40 });
  t('P5 the ball hits the crossbar and comes back into play', firstEvent(barB, 60) === 'bar' && barB.vx > 0);
  const thr = mkB({ x: 100, y: CENTER_Y, z: 15, vx: -400 });
  let anyEv = false;
  for (let n = 0; n < 90; n++) { const ev = stepBall(thr, 1 / 60); if (ev === 'post' || ev === 'bar') anyEv = true; }
  t('P5 a shot through the goal mouth under the bar is not stopped', !anyEv && thr.x < LINE);
  const rA = reflect(-300, 0, 0.9, 0.436, 0.5, 0.85);
  const rB = reflect(-300, 0, 0.9, -0.436, 0.5, 0.85);
  t('P5 deflection direction depends on the contact side', rA.y > 20 && rB.y < -20 && rA.x > 0 && rB.x > 0);
  const landTime = (spin: number): number => {
    const s = mkB({ vz: 150, vspin: spin });
    for (let n = 1; n < 300; n++) if (stepBall(s, 1 / 60) === 'bounce') return n / 60;
    return 99;
  };
  t('P5 topspin dips (lands sooner), backspin floats', landTime(1) < landTime(0) && landTime(0) < landTime(-1));
  const lobScore = scorePass({ x: 400, y: 260 }, { x: 600, y: 260 }, 1, [{ x: 500, y: 260 }], TACTICS.balanced, true);
  const driveScore = scorePass({ x: 400, y: 260 }, { x: 600, y: 260 }, 1, [{ x: 500, y: 260 }], TACTICS.balanced, false);
  t('P5 a lofted pass is valued over a blocked driven pass', lobScore > driveScore + 30);
  // ── Phase 6
  t('P6 match clock formats minutes and seconds', formatClock(125) === '02:05' && formatClock(0) === '00:00' && formatClock(60) === '01:00');
  const pp = possessionPct(3, 1);
  t('P6 possession percentages add up to 100', pp[0] + pp[1] === 100 && pp[0] === 75 && possessionPct(0, 0)[0] === 50);
  t('P6 pass accuracy handles zero passes', passAccuracy(0, 0) === 0 && passAccuracy(3, 4) === 75);
  let ex = 1.2;
  for (let n = 0; n < 180; n++) ex = nextExcite(ex, 0.3, 1 / 60);
  t('P6  excitement fades after a spike but never below its baseline', ex < 0.75 && ex >= 0.3);
  let lull = 0.0;
  for (let n = 0; n < 120; n++) lull = nextExcite(lull, 0.4, 1 / 60);
  t('P6  excitement rises quickly to a new baseline', lull > 0.3 && lull <= 0.4);
  t('P6 foul pips fill up to five, then turn red', pips(3).filled === 3 && !pips(3).red && pips(5).filled === 5 && !pips(5).red && pips(6).red);
  const hs = lineupSpot('home', 2); const as = lineupSpot('away', 2);
  t('P6 line-up puts the teams on opposite sides of the halfway line', hs.x < CENTER_X && as.x > CENTER_X && hs.y === as.y);
  const ys = new Set([0, 1, 2, 3, 4, 5, 6].map((n) => lineupSpot('home', n).y));
  t('P6 line-up spots are distinct and on the pitch', ys.size === 7 && [...ys].every((y) => y > 31 && y < FIELD_H - 31));
  t('P6 the referee keeps an arm up only for indirect free kicks', refKeepsArmUp('indirect-free-kick') && !refKeepsArmUp('free-kick') && !refKeepsArmUp('corner'));
  t('P6 a lower-priority banner cannot cover a goal banner', !bannerAllowed(100, 500, 5, 1) && bannerAllowed(600, 500, 5, 1) && bannerAllowed(100, 500, 1, 5));
  const au = new GameAudio(false);
  au.setVolume(2);
  const v1 = au.volume;
  au.setVolume(-1);
  const v0 = au.volume;
  au.toggleMute();
  t('P6 audio volume is clamped and mute is reported', v1 === 1 && v0 === 0 && au.muted && au.status().includes('MUTED'));
  au.toggleMute();
  au.setVolume(0.5);
  t('P6 audio status shows the volume once unmuted', !au.muted && au.status().includes('VOL 50%'));

  // ── Phase 7 (part 1)
  const kinds = ['info', 'action', 'spacer', 'option', 'action'];
  t('P7 menu navigation skips headings and spacers', nextSelectable(kinds, -1, 1) === 1 && nextSelectable(kinds, 1, 1) === 3 && nextSelectable(kinds, 3, 1) === 4);
  t('P7 menu navigation wraps around both ways', nextSelectable(kinds, 4, 1) === 1 && nextSelectable(kinds, 1, -1) === 4);
  t('P7 option cycling wraps', cycleIndex(0, -1, 7) === 6 && cycleIndex(6, 1, 7) === 0 && cycleIndex(2, 1, 7) === 3);
  t('P7 difficulty scales the CPU',
    DIFFS.easy.cpuSpeed < DIFFS.normal.cpuSpeed && DIFFS.normal.cpuSpeed < DIFFS.hard.cpuSpeed &&
    DIFFS.easy.gkReact[0] > DIFFS.hard.gkReact[1] && DIFFS.easy.gkErr > DIFFS.normal.gkErr && DIFFS.normal.gkErr > DIFFS.hard.gkErr &&
    DIFFS.easy.tackleWin < DIFFS.normal.tackleWin && DIFFS.normal.tackleWin < DIFFS.hard.tackleWin && DIFFS.easy.think > DIFFS.hard.think);
  const ds = defaultSettings();
  t('P7 default settings are valid', ds.homeTeam < TEAMS.length && ds.awayTeam < TEAMS.length && HALF_OPTIONS[ds.halfIdx] === 120 && !!DIFFS[ds.difficulty]);
  t('P7 corrupt saved settings fall back to defaults',
    JSON.stringify(sanitizeSettings({ homeTeam: 99, difficulty: 'insane', halfIdx: -3 })) === JSON.stringify(ds) &&
    JSON.stringify(sanitizeSettings(null)) === JSON.stringify(ds));
  const kept = sanitizeSettings({ homeTeam: 3, awayTeam: 2, difficulty: 'hard', halfIdx: 3, extraTime: false, homeTactic: 'press', awayTactic: 'counter' });
  t('P7 valid saved settings are kept',
    kept.homeTeam === 3 && kept.awayTeam === 2 && kept.difficulty === 'hard' && kept.halfIdx === 3 &&
    !kept.extraTime && kept.homeTactic === 'press' && kept.awayTactic === 'counter');
  const q1 = settingsFromQuery(new URLSearchParams('team=3&opp=2&level=hard&half=60&extra=0&tactic=press&home=counter'), defaultSettings());
  t('P7 URL options set teams, level, half length, extra time and tactics',
    q1.homeTeam === 3 && q1.awayTeam === 2 && q1.difficulty === 'hard' && q1.halfIdx === 0 &&
    !q1.extraTime && q1.awayTactic === 'press' && q1.homeTactic === 'counter');
  t('P7 invalid URL options are ignored',
    JSON.stringify(settingsFromQuery(new URLSearchParams('team=99&level=insane&half=77&tactic=bogus'), defaultSettings())) === JSON.stringify(ds));
  t('P7 identical teams get distinguishable kits',
    TEAMS.every((_, i) => { const r = resolveStyles(i, i); return colorDistance(r.home.jersey, r.away.jersey) >= 120; }));
  const gkOk = (r: ReturnType<typeof resolveStyles>): boolean =>
    colorDistance(r.home.gk, r.home.jersey) >= 70 && colorDistance(r.home.gk, r.away.jersey) >= 70 &&
    colorDistance(r.away.gk, r.away.jersey) >= 70 && colorDistance(r.away.gk, r.home.jersey) >= 70 && r.home.gk !== r.away.gk;
  t('P7 keepers stand out from both teams and from each other (default and identical teams)',
    gkOk(resolveStyles(0, 1)) && TEAMS.every((_, i) => gkOk(resolveStyles(i, i))));
  
  const failed = results.filter((r) => !r[1]);
  results.forEach(([n, ok]) => console.log(`${ok ? '✅' : '❌'} ${n}`));
  console.log(failed.length === 0 ? `SELF-TEST: all ${results.length} passed` : `SELF-TEST: ${failed.length} FAILED`);
}

interface GkPose {
  fLx: number; fLy: number; fRx: number; fRy: number;
  hLx: number; hLy: number; hRx: number; hRy: number;
  lean: number; scale: number; shadow: number; handR: number; elbowOut: number;
  liftL: number; liftR: number; free: boolean;
  capsule?: { dx: number; dy: number; half: number };
  head?: Pt;
}

const freshStats = (): TeamStats => ({
  passes: 0, passOk: 0, shots: 0, onTarget: 0, saves: 0, intercepts: 0, tackles: 0,
  fouls: 0, corners: 0, poss: 0, lineSum: 0, lineN: 0,
});

// ═══════════════ SCENE ═══════════════
class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private referee!: Footballer;
  private audio!: GameAudio;
  private ball!: Phaser.GameObjects.Arc;
  private ballVis!: Phaser.GameObjects.Arc;
  private ballInner!: Phaser.GameObjects.Arc;
  private ballInner2!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private trailGfx!: Phaser.GameObjects.Graphics;
  private trail: Pt[] = [];
  private ballHeight = 0;
  private ballVz = 0;
  private ballVx = 0;
  private ballVy = 0;
  private ballCurl = 0;
  private ballVSpin = 0;
  private ballSquash = 0;
  private ballSpin = 0;
  private possession: TeamSide | null = 'home';
  private lastTouch: TeamSide = 'home';
  private lastToucher: Footballer | null = null;
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
  private menu!: MenuUI;
  private pauseMenu = false;
  private hintText!: Phaser.GameObjects.Text;
  private hintLast = '';
  private ctrlGfx!: Phaser.GameObjects.Graphics;
  private floaters: Phaser.GameObjects.Text[] = [];
  private ended = false;
  private kickoffLock = 0;
  private state: GameState = 'intro';
  private goalScored = false;
  private message = 'Ready for kick-off';
  private openingKickoff: TeamSide = 'home';

  private restart: Restart | null = null;
  private indirectPending: { team: TeamSide; taker: Footballer; kind: RestartKind } | null = null;
  private foulCount: Record<TeamSide, number> = { home: 0, away: 0 };
  private gkHolder: Footballer | null = null;
  private gkHoldTimer = 0;
  private goalTimer?: Phaser.Time.TimerEvent;
  private restartLabel!: Phaser.GameObjects.Text;
  private aimGfx!: Phaser.GameObjects.Graphics;
  private markerGfx!: Phaser.GameObjects.Graphics;

  private shooter: Footballer | null = null;
  private shooterUntil = 0;
  private shotCharging = false;
  private shotPower = 0.5;
  private pendingPass: { side: TeamSide; kicker: Footballer } | null = null;

  private tactics: Record<TeamSide, Tactic> = { home: 'balanced', away: 'balanced' };
  private carrier: Footballer | null = null;
  private carrierSince = 0;
  private thinkTimer = 0;
  private passTarget: Footballer | null = null;
  private oneTwo: { passer: Footballer; receiver: Footballer; until: number } | null = null;
  private aiHold = new Map<Footballer, { x: number; y: number; until: number }>();
  private interceptors: Record<TeamSide, { p: Footballer; x: number; y: number; until: number } | null> = { home: null, away: null };
  private counterUntil: Record<TeamSide, number> = { home: 0, away: 0 };
  private predCache: Sample[] = [];
  private predAt = -1000;
  private stats: Record<TeamSide, TeamStats> = { home: freshStats(), away: freshStats() };
  private tacticText!: Phaser.GameObjects.Text;
  private audioText!: Phaser.GameObjects.Text;

  // Phase 6: arena, , presentation
    private crowdRows: CrowdRow[] = [];
  private flagSpots: { x: number; y: number; side: TeamSide; ph: number }[] = [];
  private flagGfx!: Phaser.GameObjects.Graphics;
  private flashGfx!: Phaser.GameObjects.Graphics;
  private flashes: { x: number; y: number; life: number }[] = [];
  private excite: Record<TeamSide, number> = { home: 0.2, away: 0.2 };
  private crowdAudioT = 0;
  private entrance: Entrance | null = null;
  private settings: MatchSettings = defaultSettings();
  private halfSeconds = HALF_SECONDS;
  private sbTabH!: Phaser.GameObjects.Rectangle;
  private sbTabA!: Phaser.GameObjects.Rectangle;
  private panelHN!: Phaser.GameObjects.Text;
  private panelAN!: Phaser.GameObjects.Text;
  private halftimeT = 0;
  private sbHomeName!: Phaser.GameObjects.Text;
  private sbAwayName!: Phaser.GameObjects.Text;
  private sbHomeScore!: Phaser.GameObjects.Text;
  private sbAwayScore!: Phaser.GameObjects.Text;
  private sbClock!: Phaser.GameObjects.Text;
  private sbPeriod!: Phaser.GameObjects.Text;
  private sbLive!: Phaser.GameObjects.Text;
  private sbPips!: Phaser.GameObjects.Graphics;
  private sbPipsKey = '';
  private bannerBg!: Phaser.GameObjects.Rectangle;
  private bannerTitle!: Phaser.GameObjects.Text;
  private bannerSub!: Phaser.GameObjects.Text;
  private bannerUntil = 0;
  private bannerPrio = 0;
  private bannerToken = 0;
  private panelItems: Phaser.GameObjects.GameObject[] = [];
  private panelTitle!: Phaser.GameObjects.Text;
  private panelScore!: Phaser.GameObjects.Text;
  private panelSub!: Phaser.GameObjects.Text;
  private panelHint!: Phaser.GameObjects.Text;
  private panelRows: { label: Phaser.GameObjects.Text; h: Phaser.GameObjects.Text; a: Phaser.GameObjects.Text }[] = [];

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

  constructor() {
    super('RetroKickScene');
  }

  create(): void {
    this.cameras.main.setScroll(0, -STAND);            // world y=0 is the top touchline; the stands sit above and below
    this.audio = new GameAudio();
    this.drawPitch();
    this.createArena();
    this.createTeams();
    this.createReferee();
    this.createBall();
    this.createOverlays();
    this.createScoreboard();
    this.createBanner();
    this.createPanel();
    this.keys = this.input.keyboard!.addKeys(
      'W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,C,V,SPACE,SHIFT,P,ENTER,T,G,M,N,OPEN_BRACKET,CLOSED_BRACKET,ESC,H,F'
    ) as Record<string, Phaser.Input.Keyboard.Key>;
    this.homeScoreEl = document.getElementById('home-score');
    this.awayScoreEl = document.getElementById('away-score');
    this.clockEl = document.getElementById('clock');
    this.periodEl = document.getElementById('period');
    this.statusEl = document.getElementById('status-message');
    this.hint = document.getElementById('canvas-hint');
    this.menu = new MenuUI(this, CENTER_X, CENTER_Y, 580);
    this.input.keyboard!.on('keydown', () => this.audio.unlock());    // browsers need a key press or click before audio can start
    this.input.on('pointerdown', () => {
      this.audio.unlock();
      if (this.menu.isOpen() || this.time.now - this.menu.lastPointerAt < 150) return;   // the menu handles its own clicks
      if (this.ended) { this.resetMatch(false); return; }
      if (!this.paused) this.skipPresentation();
    });
    document.getElementById('restart-button')?.addEventListener('click', () => this.requestRestart());
    if (this.hint) this.hint.style.display = 'none';
    document.getElementById('restart-button')?.addEventListener('click', () => this.resetMatch());

    const qs = new URLSearchParams(window.location.search);
    this.settings = settingsFromQuery(qs, loadSettings());
    this.applySettings();
    this.audioText.setText(this.audio.status());
    
    // Debug hooks (only with ?selftest)
    //   retroKickDebug.react('goal'|'save'|'post'|'foul'|'penalty'|'miss'|'applause')  -> hear and see a crowd reaction
    //   retroKickDebug.demo('post'|'bar'|...) · shot('away',230,4) · tactic('away','press') · stats() · act(5,'shoot')
    if (qs.has('selftest')) {
      (window as any).retroKickDebug = {
        players: this.players,
        act: (i: number, type: ActionType) => this.playAction(this.players[i], type, undefined, true),
        shot: (side: TeamSide, y: number, z: number, speed = 380) => this.fireTestShot(side, y, z, speed),
        tactic: (side: TeamSide, name: Tactic) => this.cycleTactic(side, name),
        stats: () => this.statsSummary(),
        demo: (kind: string) => this.fireDemo(kind),
        react: (kind: string) => this.debugReact(kind),
      };
    }
    

    this.selectControlled();
    this.startEntrance(false, () => this.startKickoff(this.openingKickoff));
    this.openTitle();
    this.updateHud();
  }

  // ═══════════════ ARENA ═══════════════

  private drawPitch(): void {
    const g = this.add.graphics();
    g.setDepth(0);

    // dark surround (also the back of the stands)
    g.fillStyle(0x0b0f15, 1).fillRect(0, -STAND, FIELD_W, GAME_H);

    // parquet floor
    const woods = [0xc68b4f, 0xbd8147, 0xca9156, 0xc1864b];
    for (let i = 0; i < 30; i++) {
      g.fillStyle(woods[i % 4], 1).fillRect(i * 30, 0, 30, FIELD_H);
      g.fillStyle(0x8a5a2b, 0.35).fillRect(i * 30, 0, 1.5, FIELD_H);
      for (let y = (i % 3) * 60; y < FIELD_H; y += 180) g.fillStyle(0x8a5a2b, 0.25).fillRect(i * 30, y, 30, 1.5);
    }
    // soft floor reflections of the arena lights
    g.fillStyle(0xffffff, 0.035);
    [[150, 130], [450, 130], [750, 130], [150, 390], [450, 390], [750, 390]].forEach(([x, y]) => g.fillEllipse(x, y, 260, 120));

    // painted futsal areas
    g.fillStyle(0x2f6fb8, 0.5);
    g.fillRect(19, 135, 118, 250);
    g.fillRect(FIELD_W - 137, 135, 118, 250);
    g.fillStyle(0x2f6fb8, 0.22).fillCircle(FIELD_W / 2, FIELD_H / 2, 67);

    // lines
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

    // LED advertising boards along both touchlines
    const adColors = [0x1f6feb, 0xd23f31, 0xe2b007, 0x0a9d6b];
    const adText = ["RETRO KICK '97", 'FUTSAL LEAGUE', 'GOAL!', 'LAGOS ARENA'];
    for (const top of [true, false]) {
      const by = top ? 0 : FIELD_H - 12;
      g.fillStyle(0x0d1218, 1).fillRect(0, by, FIELD_W, 12);
      for (let i = 0; i < 8; i++) {
        g.fillStyle(adColors[i % 4], 1).fillRect(i * 112 + 3, by + 2, 106, 8);
        this.add.text(i * 112 + 56, by + 6, adText[i % 4], {
          fontFamily: 'Arial Black, sans-serif', fontSize: '7px', color: '#ffffff',
        }).setOrigin(0.5).setDepth(4);
      }
    }

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

  /** Two stands of about 400 spectators each. Home fans (blue) left, away fans (red) right. */
    /** Two stands of about 400 spectators each. Each side's fans wear their team's colours. */
  private createArena(): void {
    for (const top of [true, false]) {
      const y0 = top ? -STAND : FIELD_H;
      const wall = this.add.graphics().setDepth(1);
      wall.fillStyle(0x0b0f15, 1).fillRect(0, y0, FIELD_W, STAND);
      for (let r = 0; r < 4; r++) {
        const yy = top ? -STAND + 6 + r * 11 : FIELD_H + 6 + r * 11;
        wall.fillStyle(0x151c27 + r * 0x050607, 1).fillRect(0, yy, FIELD_W, 10);
        wall.fillStyle(0x0b0f15, 1).fillRect(0, yy + 10, FIELD_W, 1);
      }
      for (let x = 90; x < FIELD_W; x += 180) wall.fillStyle(0x0b0f15, 1).fillRect(x, y0, 3, STAND);

      for (let r = 0; r < 4; r++) {
        const rowY = top ? -STAND + 14 + r * 11 : FIELD_H + 14 + r * 11;
        const depth = top ? 2 + r * 0.1 : 2 + (3 - r) * 0.1;
        const front = top ? r === 3 : r === 0;
        for (const side of ['home', 'away'] as TeamSide[]) {
          const g = this.add.graphics().setDepth(depth);
          const x0 = side === 'home' ? 5 : CENTER_X + 5;
          const x1 = side === 'home' ? CENTER_X - 5 : FIELD_W - 5;
          const fans: CrowdRow['fans'] = [];
          for (let x = x0; x < x1; x += 9) {
            fans.push({
              x: x + Phaser.Math.FloatBetween(-1.2, 1.2),
              shirt: Phaser.Math.Between(0, 3),
              neutral: Math.random() < 0.14 ? Phaser.Math.Between(0, NEUTRAL_FANS.length - 1) : -1,
              skin: Phaser.Math.Between(0, SKINS.length - 1),
            });
          }
          const row: CrowdRow = { g, side, phase: r * 0.9 + (top ? 0 : 1.7) + (side === 'home' ? 0 : 0.4), rowY, fans };
          this.crowdRows.push(row);
          this.drawCrowdRow(row);
          if (front) {
            for (let k = 0; k < 5; k++) {
              this.flagSpots.push({ x: Phaser.Math.Between(x0 + 10, x1 - 10), y: rowY - 5, side, ph: Math.random() * 6 });
            }
          }
        }
      }
    }
    this.flagGfx = this.add.graphics().setDepth(3);
    this.flashGfx = this.add.graphics().setDepth(3.5);
  }

  private drawCrowdRow(row: CrowdRow): void {
    const g = row.g;
    g.clear();
    const shirts = STYLE[row.side].fans;
    for (const f of row.fans) {
      const shirt = f.neutral >= 0 ? NEUTRAL_FANS[f.neutral] : shirts[f.shirt % shirts.length];
      g.fillStyle(shirt, 1).fillRect(f.x - 2.6, row.rowY, 5.2, 7);
      g.fillStyle(SKINS[f.skin][0], 1).fillCircle(f.x, row.rowY - 2.6, 2.5);
    }
  }

  private recolorCrowd(): void {
    this.crowdRows.forEach((r) => this.drawCrowdRow(r));
  }

  // ═══════════════ CROWD ═══════════════

  private bumpCrowd(side: TeamSide | 'both', amount: number): void {
    if (side === 'both' || side === 'home') this.excite.home = Math.min(1.4, this.excite.home + amount);
    if (side === 'both' || side === 'away') this.excite.away = Math.min(1.4, this.excite.away + amount);
  }

  private flashBurst(n: number): void {
    for (let i = 0; i < n; i++) {
      const top = Math.random() < 0.5;
      this.flashes.push({
        x: Phaser.Math.Between(10, FIELD_W - 10),
        y: top ? Phaser.Math.Between(-STAND + 8, -8) : Phaser.Math.Between(FIELD_H + 8, FIELD_H + STAND - 8),
        life: Phaser.Math.FloatBetween(0.1, 0.35),
      });
    }
  }

  private updateCrowd(dt: number): void {
    const t = this.time.now / 1000;
    // baseline excitement: attacks near a goal raise the noise
    let base = 0.2;
    if (this.state === 'playing') {
      const dl = Math.hypot(this.ball.x - LINE, this.ball.y - CENTER_Y);
      const dr = Math.hypot(FIELD_W - LINE - this.ball.x, this.ball.y - CENTER_Y);
      base += Math.max(0, 1 - Math.min(dl, dr) / 320) * 0.35;
    }
    this.excite.home = nextExcite(this.excite.home, base, dt);
    this.excite.away = nextExcite(this.excite.away, base, dt);

    for (const row of this.crowdRows) {
      const e = this.excite[row.side];
      const amp = 0.3 + 3.4 * e;
      row.g.y = -Math.abs(Math.sin(t * (2.2 + e * 4) + row.phase)) * amp;   // fans bob; at high excitement they jump
    }

    // waving flags
    const fg = this.flagGfx;
    fg.clear();
    for (const f of this.flagSpots) {
      const e = this.excite[f.side];
      const wave = Math.sin(t * (3 + e * 6) + f.ph) * (2 + e * 4);
      const col = STYLE[f.side].jersey;
      fg.lineStyle(1, 0xdddddd, 1).lineBetween(f.x, f.y, f.x, f.y - 12 - e * 3);
      fg.fillStyle(col, 1).fillTriangle(f.x, f.y - 12 - e * 3, f.x + 9 + wave, f.y - 9 - e * 3, f.x, f.y - 6 - e * 3);
    }

    // camera flashes
    const fl = this.flashGfx;
    fl.clear();
    if (this.excite.home + this.excite.away > 1.4 && Math.random() < 0.05) this.flashBurst(1);
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) { this.flashes.splice(i, 1); continue; }
      fl.fillStyle(0xffffff, Math.min(1, f.life * 6)).fillCircle(f.x, f.y, 2.2);
    }

    this.crowdAudioT -= dt;
    if (this.crowdAudioT <= 0) {
      this.crowdAudioT = 0.25;
      this.audio.setExcitement((this.excite.home + this.excite.away) / 2);
    }
  }

  // ═══════════════ REACTIONS (one place for sound + crowd + banner + referee) ═══════════════

  private reactGoal(side: TeamSide): void {
    const scorer = this.lastToucher;
    const own = !!scorer && scorer.side !== side;
    const num = scorer ? scorer.number : 0;
    this.bumpCrowd(side, 1.2);
    this.bumpCrowd(other(side), 0.25);
    this.audio.sfx('horn');
    this.audio.sfx('net');
    this.audio.crowd('cheer', 1);
    this.time.delayedCall(450, () => this.audio.crowd('groan', 0.3));
    this.time.delayedCall(350, () => { this.audio.sfx('whistleLong'); this.playAction(this.referee, 'whistle'); });
    this.time.delayedCall(900, () => this.playAction(this.referee, 'point', Math.atan2(CENTER_Y - this.referee.sprite.y, CENTER_X - this.referee.sprite.x)));
    this.flashBurst(30);
    const home = this.homeScore; const away = this.awayScore;
    this.banner('GOAL!', own ? `OWN GOAL · ${teamName(side)} ${home}–${away}` : `${teamName(side)} · #${num} · ${home}–${away}`,
            STYLE[side].accent, 2400, 5);
    this.audio.speak(own ? `Own goal. ${teamName(side)} score.` : `Goal! ${teamName(side)}, number ${num}.`);
    const t = side === 'home' ? this.sbHomeScore : this.sbAwayScore;
    this.tweens.add({ targets: t, scale: { from: 1.7, to: 1 }, duration: 450, ease: 'Back.easeOut' });
  }

  private reactSave(gk: Footballer): void {
    this.bumpCrowd(gk.side, 0.5);
    this.bumpCrowd(other(gk.side), 0.3);
    this.audio.sfx('glove');
    this.audio.crowd('gasp', 0.6);
    this.time.delayedCall(350, () => this.audio.crowd('applause', 0.7));
    this.banner('SAVE!', `${teamName(gk.side)} keeper`, 0x06d6a0, 1000, 2);
  }

  private reactPost(ev: 'post' | 'bar'): void {
    this.bumpCrowd('both', 0.5);
    this.audio.crowd('ooh', 1);
    this.banner(ev === 'post' ? 'OFF THE POST!' : 'OFF THE BAR!', 'So close!', 0xffd23f, 1100, 3);
  }

  private reactNearMiss(over: boolean): void {
    this.bumpCrowd('both', 0.3);
    this.audio.crowd('ooh', 0.6);
    if (over) this.audio.crowd('groan', 0.25);
  }

  private reactFoul(fouler: TeamSide, spec: RestartSpec): void {
    this.audio.sfx('whistleShort');
    this.playAction(this.referee, 'whistle');
    this.audio.crowd('boo', fouler === 'away' ? 0.6 : 0.3);
    this.bumpCrowd('both', 0.2);
    const n = this.foulCount[fouler];
    if (spec.kind === 'penalty') {
      this.bumpCrowd('both', 0.6);
      this.audio.crowd('gasp', 1);
      this.banner('PENALTY!', `${teamName(spec.team)} · foul by ${teamName(fouler)}`, 0xef476f, 2200, 4);
      this.audio.speak(`Penalty to ${teamName(spec.team)}.`);
    } else if (spec.kind === 'second-penalty') {
      this.banner('10 m FREE KICK', `${teamName(fouler)} foul #${n} — accumulated fouls`, 0xef476f, 2000, 3);
    } else {
      this.banner('FOUL', `${teamName(fouler)} (#${n}) · free kick ${teamName(spec.team)}`, 0xffd23f, 1400, 1);
    }
  }

  /** The referee points the way for a restart (the whistle is separate: only fouls, goals and kick-offs are whistled). */
  private refSignalRestart(spec: RestartSpec): void {
    if (spec.kind === 'kickoff') return;
    const r = this.referee;
    const dirA = spec.team === 'home' ? 1 : -1;
    let aim = dirA === 1 ? 0 : Math.PI;
    if (spec.kind === 'corner' || spec.kind === 'goal-clearance' || spec.kind === 'penalty' || spec.kind === 'second-penalty') {
      aim = Math.atan2(spec.y - r.sprite.y, spec.x - r.sprite.x);
    }
    this.time.delayedCall(450, () => { if (this.state === 'restart') this.playAction(r, 'point', aim); });
  }

  private debugReact(kind: string): void {
    this.audio.unlock();
    switch (kind) {
      case 'goal': this.reactGoal('home'); break;
      case 'save': this.reactSave(this.keeperOf('away')); break;
      case 'post': this.reactPost('post'); this.audio.sfx('post'); break;
      case 'foul': this.reactFoul('away', { kind: 'free-kick', team: 'home', x: 400, y: 260 }); break;
      case 'penalty': this.reactFoul('away', { kind: 'penalty', team: 'home', x: 788, y: 260 }); break;
      case 'miss': this.reactNearMiss(true); break;
      case 'applause': this.audio.crowd('applause', 1); break;
      default: this.setMessage('react: goal | save | post | foul | penalty | miss | applause');
    }
  }

  // ═══════════════ REFEREE ═══════════════

  private createReferee(): void {
    this.referee = this.makeFootballer('home', CENTER_X, FIELD_H - 70, 'MID', 0, REF_KIT);
    this.referee.label.setVisible(false);
  }

  private updateReferee(dt: number): void {
    const r = this.referee;
    const st = this.state;
    let tx = CENTER_X;
    let ty = FIELD_H - 70;
    if (st === 'restart' && this.restart) {
      const rs = this.restart;
      const dx = CENTER_X - rs.x; const dy = CENTER_Y - rs.y;
      const l = Math.hypot(dx, dy) || 1;
      tx = rs.x + (dx / l) * 80;
      ty = rs.y + (dy / l) * 80;
    } else if (st === 'playing') {
      ty = this.ball.y < CENTER_Y ? this.ball.y + 105 : this.ball.y - 105;   // stays off the line of play
      tx = this.ball.x - Math.sign(this.ballVx || 1) * 45;
    } else if (st === 'goal') {
      ty = CENTER_Y + 100;
    }
    tx = Phaser.Math.Clamp(tx, 45, FIELD_W - 45);
    ty = Phaser.Math.Clamp(ty, 45, FIELD_H - 45);
    const d = dist(r.sprite.x, r.sprite.y, tx, ty);
    if (d > 6) {
      const s = Math.min(150, d * 2.2);
      const nx = r.sprite.x + ((tx - r.sprite.x) / d) * s * dt;
      const ny = r.sprite.y + ((ty - r.sprite.y) / d) * s * dt;
      r.sprite.setPosition(nx, ny);
      r.shadow.setPosition(nx + 2, ny + SHADOW_DY);
    }

    // Arm raised while the 4-second count runs, and during play after an indirect free kick (until another player touches the ball)
    const wantRaise =
      (st === 'playing' && !!this.indirectPending && refKeepsArmUp(this.indirectPending.kind)) ||
      (st === 'restart' && !!this.restart && this.restart.ready && RESTART_INFO[this.restart.kind].limit !== null);
    const raising = r.act !== null && r.act.type === 'raise';
    if (wantRaise && !r.act) this.playAction(r, 'raise');
    else if (!wantRaise && raising) r.act = null;
  }

  // ═══════════════ PRESENTATION: scoreboard, banner, panels ═══════════════

  private createScoreboard(): void {
    const cx = CENTER_X;
    const y0 = -52;
    const g = this.add.graphics().setDepth(6);
    g.fillStyle(0x05080c, 0.94).fillRoundedRect(cx - 215, y0, 430, 46, 8);
    g.lineStyle(2, 0x3b4a5e, 1).strokeRoundedRect(cx - 215, y0, 430, 46, 8);
    this.sbTabH = this.add.rectangle(cx - 206.5, y0 + 17, 5, 22, 0x2d7fff).setDepth(7);
    this.sbTabA = this.add.rectangle(cx + 206.5, y0 + 17, 5, 22, 0xff3b47).setDepth(7);
    const font = 'Barlow Condensed, Arial Black, sans-serif';
    const mk = (x: number, y: number, size: string, color: string, ox: number): Phaser.GameObjects.Text =>
      this.add.text(x, y, '', { fontFamily: font, fontSize: size, color, stroke: '#000000', strokeThickness: 2 }).setOrigin(ox, 0.5).setDepth(7);
    this.sbHomeName = mk(cx - 198, y0 + 17, '17px', '#8ec5ff', 0);
    this.sbAwayName = mk(cx + 198, y0 + 17, '17px', '#ff9aa2', 1);
    this.sbHomeScore = mk(cx - 100, y0 + 17, '30px', '#ffffff', 0.5);
    this.sbAwayScore = mk(cx + 100, y0 + 17, '30px', '#ffffff', 0.5);
    this.sbClock = mk(cx, y0 + 17, '26px', '#ffd23f', 0.5);
    this.sbPeriod = mk(cx, y0 + 38, '11px', '#cfd8e3', 0.5);
    this.sbLive = mk(cx + 74, y0 + 38, '10px', '#06d6a0', 0.5);
    this.sbHomeName.setText('ROCKETS');
    this.sbAwayName.setText('COMETS');
    this.sbPips = this.add.graphics().setDepth(7);
  }

  private updateScoreboard(): void {
    if (!this.sbClock) return;
    const set = (tx: Phaser.GameObjects.Text, s: string): void => { if (tx.text !== s) tx.setText(s); };
    set(this.sbHomeScore, String(this.homeScore));
    set(this.sbHomeName, STYLE.home.short);
    set(this.sbAwayName, STYLE.away.short);
    set(this.sbAwayScore, String(this.awayScore));
    set(this.sbClock, formatClock(this.remaining));
    const per = this.state === 'halftime' ? 'HALF-TIME'
      : this.state === 'fulltime' ? 'FULL-TIME'
        : this.half === 1 ? '1ST HALF' : this.half === 2 ? '2ND HALF' : 'EXTRA TIME';
    set(this.sbPeriod, per);
    const live = this.state === 'playing';
    set(this.sbLive, live ? '● LIVE' : '❚❚ STOPPED');
    this.sbLive.setColor(live ? '#06d6a0' : '#ef476f');

    const key = `${this.foulCount.home}-${this.foulCount.away}`;
    if (key !== this.sbPipsKey) {
      this.sbPipsKey = key;
      const g = this.sbPips;
      g.clear();
      const draw = (fouls: number, x0: number, dir: number): void => {
        const p = pips(fouls);
        for (let i = 0; i < 5; i++) {
          const on = i < p.filled;
          g.fillStyle(on ? (p.red ? 0xef476f : 0xffd23f) : 0x2a3340, 1).fillCircle(x0 + dir * i * 11, -52 + 38, 3.6);
        }
      };
      draw(this.foulCount.home, CENTER_X - 190, 1);
      draw(this.foulCount.away, CENTER_X + 190, -1);
    }
  }

  private createBanner(): void {
    const font = 'Barlow Condensed, Arial Black, sans-serif';
    this.bannerBg = this.add.rectangle(CENTER_X, 80, 400, 56, 0x0b1b2b, 0.9).setStrokeStyle(2, 0xffd23f).setDepth(60).setVisible(false);
    this.bannerTitle = this.add.text(CENTER_X, 68, '', { fontFamily: font, fontSize: '26px', color: '#ffd23f', stroke: '#000000', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(61).setVisible(false);
    this.bannerSub = this.add.text(CENTER_X, 92, '', { fontFamily: font, fontSize: '15px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5).setDepth(61).setVisible(false);
  }

  /** Match announcement strip. Higher-priority banners are never covered by lower ones. */
  private banner(title: string, sub: string, color: number, ms: number, prio: number): void {
    const now = this.time.now;
    if (!bannerAllowed(now, this.bannerUntil, this.bannerPrio, prio)) return;
    this.bannerPrio = prio;
    this.bannerUntil = now + ms;
    const token = ++this.bannerToken;
    this.bannerBg.setStrokeStyle(2, color).setVisible(true);
    this.bannerTitle.setText(title).setColor(hex(color)).setVisible(true);
    this.bannerSub.setText(sub).setVisible(true);
    const items = [this.bannerBg, this.bannerTitle, this.bannerSub];
    this.tweens.killTweensOf(items);
    items.forEach((o) => o.setAlpha(0));
    this.tweens.add({ targets: items, alpha: 1, duration: 150 });
    this.time.delayedCall(ms, () => {
      if (token !== this.bannerToken) return;
      this.tweens.add({ targets: items, alpha: 0, duration: 250, onComplete: () => items.forEach((o) => o.setVisible(false)) });
    });
  }

  private createPanel(): void {
    const font = 'Barlow Condensed, Arial Black, sans-serif';
    const cx = CENTER_X;
    const top = 70;
    const bg = this.add.rectangle(cx, CENTER_Y, 520, 390, 0x0b1b2b, 0.92).setStrokeStyle(3, 0xffd23f).setDepth(70);
    this.panelTitle = this.add.text(cx, top + 8, '', { fontFamily: font, fontSize: '30px', color: '#ffd23f', stroke: '#000000', strokeThickness: 4 }).setOrigin(0.5, 0).setDepth(71);
    this.panelScore = this.add.text(cx, top + 48, '', { fontFamily: font, fontSize: '48px', color: '#ffffff', stroke: '#000000', strokeThickness: 5 }).setOrigin(0.5, 0).setDepth(71);
    this.panelSub = this.add.text(cx, top + 108, '', { fontFamily: font, fontSize: '18px', color: '#cfd8e3', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(71);
    const hn = this.add.text(cx - 150, top + 136, 'ROCKETS', { fontFamily: font, fontSize: '16px', color: '#8ec5ff' }).setOrigin(0.5, 0).setDepth(71);
    const an = this.add.text(cx + 150, top + 136, 'COMETS', { fontFamily: font, fontSize: '16px', color: '#ff9aa2' }).setOrigin(0.5, 0).setDepth(71);
    this.panelItems = [bg, this.panelTitle, this.panelScore, this.panelSub, hn, an];
    this.panelHN = hn;
    this.panelAN = an;
    for (let i = 0; i < 9; i++) {
      const y = top + 160 + i * 22;
      const label = this.add.text(cx, y, '', { fontFamily: font, fontSize: '15px', color: '#ffd23f' }).setOrigin(0.5, 0).setDepth(71);
      const h = this.add.text(cx - 150, y, '', { fontFamily: font, fontSize: '17px', color: '#ffffff' }).setOrigin(0.5, 0).setDepth(71);
      const a = this.add.text(cx + 150, y, '', { fontFamily: font, fontSize: '17px', color: '#ffffff' }).setOrigin(0.5, 0).setDepth(71);
      this.panelRows.push({ label, h, a });
      this.panelItems.push(label, h, a);
    }
    this.panelHint = this.add.text(cx, top + 365, '', { fontFamily: font, fontSize: '15px', color: '#06d6a0', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(71);
    this.panelItems.push(this.panelHint);
    this.panelItems.forEach((o) => (o as Phaser.GameObjects.Components.Visible & Phaser.GameObjects.GameObject).setVisible(false));
    this.panelRowsVisible(false);
  }

  private panelRowsVisible(v: boolean): void {
    this.panelRows.forEach((r) => { r.label.setVisible(v); r.h.setVisible(v); r.a.setVisible(v); });
  }

  private statRows(): [string, string, string][] {
    const h = this.stats.home; const a = this.stats.away;
    const [ph, pa] = possessionPct(h.poss, a.poss);
    return [
      ['POSSESSION', `${ph}%`, `${pa}%`],
      ['SHOTS', String(h.shots), String(a.shots)],
      ['ON TARGET', String(h.onTarget), String(a.onTarget)],
      ['PASSES', String(h.passes), String(a.passes)],
      ['PASS ACCURACY', `${passAccuracy(h.passOk, h.passes)}%`, `${passAccuracy(a.passOk, a.passes)}%`],
      ['TACKLES WON', String(h.tackles), String(a.tackles)],
      ['SAVES', String(h.saves), String(a.saves)],
      ['FOULS', String(h.fouls), String(a.fouls)],
      ['CORNERS', String(h.corners), String(a.corners)],
    ];
  }

  private showPanel(title: string, sub: string, hint: string, withStats: boolean): void {
    this.panelItems.forEach((o) => (o as Phaser.GameObjects.Components.Visible & Phaser.GameObjects.GameObject).setVisible(true));
    this.panelTitle.setText(title);
    this.panelHN.setText(STYLE.home.short).setColor(hex(STYLE.home.accent));
    this.panelAN.setText(STYLE.away.short).setColor(hex(STYLE.away.accent));
    this.panelScore.setText(withStats ? `${this.homeScore} – ${this.awayScore}` : '');
    this.panelSub.setText(sub);
    this.panelHint.setText(hint);
    this.panelRowsVisible(withStats);
    if (withStats) {
      const rows = this.statRows();
      this.panelRows.forEach((r, i) => { r.label.setText(rows[i][0]); r.h.setText(rows[i][1]); r.a.setText(rows[i][2]); });
    }
  }

  private hidePanel(): void {
    this.panelItems.forEach((o) => (o as Phaser.GameObjects.Components.Visible & Phaser.GameObjects.GameObject).setVisible(false));
    this.panelRowsVisible(false);
  }

  // ═══════════════ ENTRANCES, HALF-TIME ═══════════════

  /** Players walk out of the tunnel, line up, and the match starts. Short = the second-half re-entry. */
  private startEntrance(short: boolean, done: () => void): void {
    this.state = 'intro';
    this.restart = null; this.gkHolder = null; this.carrier = null; this.passTarget = null; this.oneTwo = null;
    this.possession = null;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0; this.ballCurl = 0; this.ballVSpin = 0;
    this.ball.setPosition(CENTER_X, CENTER_Y);
    const targets = new Map<Footballer, { tx: number; ty: number; delay: number }>();
    for (const side of ['home', 'away'] as TeamSide[]) {
      this.players.filter((p) => p.side === side).forEach((p, i) => {
        const spot = lineupSpot(side, i);
        targets.set(p, { tx: spot.x, ty: spot.y, delay: i * (short ? 0.12 : 0.45) });
        p.vx = 0; p.vy = 0; p.act = null; p.celebrating = false; p.cooldown = 0;
        const sx = CENTER_X + (side === 'home' ? -40 : 40);
        p.sprite.setPosition(sx, TUNNEL_Y);
        p.shadow.setPosition(sx + 2, TUNNEL_Y + SHADOW_DY);
        p.lastX = sx; p.lastY = TUNNEL_Y;
        if (p.gk) this.resetKeeper(p.gk);
      });
    }
    this.entrance = { t: 0, short, lineT: 0, announced: false, done, targets };
  }

  /** Straight walk without the pitch clamp (players come from outside the field). Returns true on arrival. */
  private walkPlayer(p: Footballer, tx: number, ty: number, speed: number, dt: number): boolean {
    const dx = tx - p.sprite.x;
    const dy = ty - p.sprite.y;
    const d = Math.hypot(dx, dy);
    if (d <= 3) return true;
    const s = Math.min(speed, d * 4);
    const nx = p.sprite.x + (dx / d) * s * dt;
    const ny = p.sprite.y + (dy / d) * s * dt;
    p.sprite.setPosition(nx, ny);
    p.shadow.setPosition(nx + 2, ny + SHADOW_DY);
    p.facing = Math.atan2(dy, dx);
    return d - s * dt <= 3;
  }

  private updateEntrance(dt: number): void {
    const e = this.entrance;
    if (!e) { this.startKickoff(this.openingKickoff); return; }
    e.t += dt;
    let allIn = true;
    for (const p of this.players) {
      const info = e.targets.get(p)!;
      if (e.t < info.delay) { allIn = false; continue; }
      if (!this.walkPlayer(p, info.tx, info.ty, 125, dt)) allIn = false;
    }
    if (!allIn) return;
    e.lineT += dt;
    if (!e.announced) {
      e.announced = true;
      if (!e.short) {
        this.banner('TONIGHT', 'Rockets vs Comets', 0xffd23f, 2400, 2);
        this.audio.crowd('cheer', 0.6);
        this.bumpCrowd('both', 0.5);
        this.audio.speak('Ladies and gentlemen, welcome to Retro Kick Futsal. Rockets versus Comets.');
      }
    }
    if (e.lineT > (e.short ? 0.4 : 2.2)) this.finishEntrance();
  }

  private finishEntrance(): void {
    const e = this.entrance;
    if (!e) return;
    this.entrance = null;
    this.hidePanel();
    e.done();
  }

  private beginHalftime(): void {
    this.state = 'halftime';
    this.halftimeT = 0;
    this.restart = null; this.gkHolder = null; this.carrier = null; this.possession = null;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0; this.ballCurl = 0; this.ballVSpin = 0;
    this.ball.setPosition(CENTER_X, CENTER_Y);
    this.players.forEach((p) => { p.vx = 0; p.vy = 0; p.act = null; p.celebrating = false; });
    this.audio.sfx('whistleLong');
    this.playAction(this.referee, 'whistle');
    this.audio.crowd('applause', 1);
    this.bumpCrowd('both', 0.5);
    this.banner('HALF-TIME', `${teamName('home')} ${this.homeScore}–${this.awayScore} ${teamName('away')}`, 0xffd23f, 3000, 6);
    this.showPanel('HALF-TIME', 'The second half starts shortly', 'ENTER or click to continue', true);
    this.audio.speak(`Half-time. Rockets ${this.homeScore}, Comets ${this.awayScore}.`);
  }

  private updateHalftime(dt: number): void {
    this.halftimeT += dt;
    // both teams walk off down the tunnel
    this.players.forEach((p, i) => {
      const idx = i % 7;
      if (this.halftimeT < idx * 0.2) return;
      this.walkPlayer(p, CENTER_X + (p.side === 'home' ? -40 : 40), TUNNEL_Y, 130, dt);
    });
    if (this.halftimeT > 7.5) this.endHalftime();
  }

  private endHalftime(): void {
    this.hidePanel();
    this.startEntrance(true, () => this.startKickoff(other(this.openingKickoff)));
  }

  private skipPresentation(): void {
    if (this.state === 'intro' && this.entrance && this.entrance.t > 0.6) this.finishEntrance();
    else if (this.state === 'halftime' && this.halftimeT > 1.0) this.endHalftime();
  }

  // ═══════════════ OVERLAYS ═══════════════

  private createOverlays(): void {
    this.goalFlash = this.add
      .rectangle(FIELD_W / 2, CENTER_Y, FIELD_W, GAME_H, 0xffffff, 0)
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
    this.markerGfx = this.add.graphics().setDepth(13);

    // tactics + audio status live in the bottom stand
    this.tacticText = this.add
      .text(CENTER_X - 200, FIELD_H + STAND - 6, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif', fontSize: '12px', color: '#ffffff',
        stroke: '#000000', strokeThickness: 3, align: 'center',
      })
      .setOrigin(0.5, 1).setDepth(47);
    this.audioText = this.add
      .text(FIELD_W - 8, FIELD_H + STAND - 6, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif', fontSize: '12px', color: '#9fd0ff',
        stroke: '#000000', strokeThickness: 3, align: 'right',
      })
      .setOrigin(1, 1).setDepth(47);
  }

    this.hintText = this.add
      .text(CENTER_X, FIELD_H + 18, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif', fontSize: '13px', color: '#e8eef5',
        stroke: '#000000', strokeThickness: 3, align: 'center',
      })
      .setOrigin(0.5, 0).setDepth(47);
    this.ctrlGfx = this.add.graphics().setDepth(48);

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

  private makeFootballer(side: TeamSide, x: number, y: number, role: Footballer['role'], number: number, kit?: Kit): Footballer {
    const k = kit ?? makeKit(side, role, number);
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
    return {
      sprite: container, ring, rig, shadow, label, side, role,
      homeX: x, homeY: y, vx: 0, vy: 0, number, cooldown: 0,
      celebrating: false, celebrateUntil: 0,
      facing: side === 'home' ? 0 : Math.PI,
      kit: k, vis: side === 'home' ? 0 : Math.PI, stride: Math.random() * Math.PI * 2,
      speed: 0, lastX: x, lastY: y, anim: 'idle', act: null,
      gk: role === 'GK' ? this.makeBrain() : null,
    };
  }

  private addPlayer(side: TeamSide, x: number, y: number, role: Footballer['role'], number: number): void {
    this.players.push(this.makeFootballer(side, x, y, role, number));
  }

  private createBall(): void {
    this.ballShadow = this.add.ellipse(FIELD_W / 2 + 2, FIELD_H / 2 + 6, 14, 6, 0x000000, 0.4).setDepth(12);
    this.trailGfx = this.add.graphics().setDepth(29);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 0).setVisible(false);
    this.ballVis = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 1).setStrokeStyle(1.5, 0x111111).setDepth(30);
    this.ballInner = this.add.circle(FIELD_W / 2, FIELD_H / 2, 2, 0x111111).setDepth(31);
    this.ballInner2 = this.add.circle(FIELD_W / 2, FIELD_H / 2, 1.6, 0x555555).setDepth(31);
  }

  // ═══════════════ PLAYER ANIMATION ═══════════════

  private playAction(p: Footballer, type: ActionType, aim?: number, fromStart = false): void {
    const def = ACTIONS[type];
    p.act = { type, t: fromStart ? 0 : def.start, dur: def.dur, aim };
  }

  private animateAll(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.players) this.animatePlayer(p, dt);
    this.animatePlayer(this.referee, dt);
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

    let target: number;
    if (p.act && p.act.aim !== undefined) target = p.act.aim;
    else if (p.celebrating) target = Math.PI / 2;
    else if (p.gk && this.state !== 'intro' && this.state !== 'halftime') target = Math.atan2(this.ball.y - y, this.ball.x - x);
    else if (moving) target = Math.atan2(dy, dx);
    else target = Math.atan2(this.ball.y - y, this.ball.x - x);

    const maxTurn = (moving ? 12 : 9) * dt;
    const diff = Phaser.Math.Angle.Wrap(target - p.vis);
    p.vis = Phaser.Math.Angle.Wrap(p.vis + Phaser.Math.Clamp(diff, -maxTurn, maxTurn));
    const remaining = Phaser.Math.Angle.Wrap(target - p.vis);

    const G2 = gaitFor(p.speed, GAIT_TMP);
    p.stride += (p.speed * dt / G2.cycle) * Math.PI * 2;

    if (p.act) p.anim = p.act.type;
    else if (p.celebrating) p.anim = 'celebrate';
    else if (p.gk) p.anim = this.gkAnimName(p.gk, moving);
    else if (moving && Math.abs(remaining) > 0.7) p.anim = 'turn';
    else p.anim = classifyLocomotion(p.speed);

    this.drawPlayer(p, G2, remaining, moving);
    p.sprite.setDepth(20 + y / FIELD_H);
  }

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
        if (p.speed > 25) {
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

  private drawPlayer(p: Footballer, G2: Gait, rem: number, moving: boolean): void {
    const g = p.rig;
    g.clear();
    const k = p.kit;
    const now = this.time.now;
    const a = p.act;
    const t = a ? a.t : 0;

    const ph = p.stride;
    const sL = Math.sin(ph);
    const sR = Math.sin(ph + Math.PI);
    const liftAmt = Math.min(1, G2.legAmp / 8);
    let stance = G2.stance;
    let fLx = G2.legAmp * sL;
    let fRx = G2.legAmp * sR;
    let fLy = -stance;
    let fRy = stance;
    let liftL = Math.max(0, Math.cos(ph)) * liftAmt;
    let liftR = Math.max(0, Math.cos(ph + Math.PI)) * liftAmt;
    let hLx = G2.armAmp * sR;
    let hRx = G2.armAmp * sL;
    let hLy = -(9.2 - G2.elbowIn);
    let hRy = 9.2 - G2.elbowIn;
    let lean = G2.lean + Math.sin(now * 0.002 + p.number) * 0.25 * (1 - liftAmt);
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

    if (p.gk && !a && !p.celebrating && this.state !== 'intro' && this.state !== 'halftime') {
      const q = this.gkPose(p, p.gk, ph);
      fLx = q.fLx; fLy = q.fLy; fRx = q.fRx; fRy = q.fRy;
      hLx = q.hLx; hLy = q.hLy; hRx = q.hRx; hRy = q.hRy;
      lean = q.lean; sx = sy = q.scale; shadowS = q.shadow; handR = q.handR; elbowOut = q.elbowOut;
      liftL = q.liftL; liftR = q.liftR; free = q.free;
      capsule = q.capsule ?? null; headPos = q.head ?? null; headYaw = 0; stance = 5.5;
    }

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
        case 'point':            // referee: arm straight out toward the restart
          hRx = 18; hRy = 2; hLx = -1; hLy = -9; lean = 0.5; free = true;
          break;
        case 'whistle':          // referee: hand to the mouth
          hRx = 5; hRy = 3; hLx = -1; hLy = -9.5; lean = 0.5;
          break;
        case 'raise':            // referee: arm raised (4-second count, indirect free kick)
          hRx = 3; hRy = 5.5; handR = 3.3; hLx = -1; hLy = -9.5; lean = 0; sx = sy = 1.04;
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

  private handleAudioKeys(): void {
    const k = this.keys;
    let changed = false;
    if (Phaser.Input.Keyboard.JustDown(k.M)) { this.audio.unlock(); this.audio.toggleMute(); changed = true; }
    if (Phaser.Input.Keyboard.JustDown(k.N)) { this.audio.toggleVoice(); changed = true; }
    if (Phaser.Input.Keyboard.JustDown(k.OPEN_BRACKET)) { this.audio.changeVolume(-0.1); changed = true; }
    if (Phaser.Input.Keyboard.JustDown(k.CLOSED_BRACKET)) { this.audio.changeVolume(0.1); changed = true; }
    if (changed) this.audioText.setText(this.audio.status());
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.035);
    const J = Phaser.Input.Keyboard.JustDown;
    this.handleAudioKeys();
    if (J(this.keys.F)) this.scale.toggleFullscreen();

    // a menu is open: only the menu reacts (the world stays frozen, apart from the crowd behind the start screen)
    if (this.menu.isOpen()) {
      this.handleMenuInput();
      if (this.state === 'intro') { this.updateCrowd(dt); this.syncBallVisuals(); this.updateScoreboard(); }
      this.hintText.setText('');
      this.hintLast = '';
      this.ctrlGfx.clear();
      return;
    }

    if (J(this.keys.T)) this.cycleTactic('away');
    if (J(this.keys.G)) this.cycleTactic('home');
    const pressP = J(this.keys.P);
    const pressEsc = J(this.keys.ESC);
    if (this.ended) {
      if (pressEsc) { this.quitToTitle(); return; }
    } else if (pressP || pressEsc) {
      this.openPause();
      return;
    }
    if (J(this.keys.H)) { this.paused = true; this.openControls(() => this.resumeFromMenu()); return; }
    if (this.paused) return;
    this.updateGuides();

    if (J(this.keys.ENTER)) {
      if (this.ended) { this.resetMatch(false); return; }
      this.skipPresentation();
    }

    if (this.ended) {
      // full-time: the match is over but the arena keeps living (crowd, winners celebrating, referee)
      this.updateCrowd(dt);
      this.updateReferee(dt);
      this.updateParticles(dt);
      this.updateCamera(dt);
      this.syncBallVisuals();
      this.updateScoreboard();
      this.animateAll(dt);
      return;
    }

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

    if (this.state === 'intro') {
      this.updateEntrance(dt);
    } else if (this.state === 'halftime') {
      this.updateHalftime(dt);
    } else if (this.state === 'restart') {
      this.updateRestart(dt);
    } else if (this.state === 'playing') {
      if (this.possession) this.stats[this.possession].poss += dt;
      this.updateUser(dt);
      if (this.state === 'playing') this.updateTeamAI('home', dt);
      if (this.state === 'playing') this.updateTeamAI('away', dt);
      if (this.state === 'playing') {
        this.updateGkHold(dt);
        this.updateGoalkeepers(dt);
        this.updateBall(dt);
        this.updatePossession();
      }
    } else if (this.state === 'goal') {
      this.tickConcede(dt);
    }
    if (this.state !== 'restart') this.markerGfx.clear();
    this.updateCrowd(dt);
    this.updateReferee(dt);
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.syncBallVisuals();
    this.updateScoreboard();
    this.animateAll(dt);
  }

  private syncBallVisuals(): void {
    const h = this.ballHeight;
    const vx = this.ball.x;
    const vy = this.ball.y - h * 0.9;
    const base = 1 + h * 0.012;
    const sq = this.ballSquash;
    this.ballVis.setPosition(vx, vy).setScale(base * (1 + 0.2 * sq), base * (1 - 0.2 * sq));
    const a = this.ballSpin;
    this.ballInner.setPosition(vx + Math.cos(a) * 2.4, vy + Math.sin(a) * 2.4);
    this.ballInner2.setPosition(vx - Math.cos(a) * 2.4, vy - Math.sin(a) * 2.4);
    this.ballShadow.setPosition(this.ball.x + 2 + h * 0.15, this.ball.y + 6 + h * 0.1);
    this.ballShadow.setScale(1 - Math.min(0.5, h * 0.015));
    this.ballShadow.setAlpha(0.4 - Math.min(0.22, h * 0.007));

    this.trail.push({ x: vx, y: vy });
    if (this.trail.length > 5) this.trail.shift();
    this.trailGfx.clear();
    if (Math.hypot(this.ballVx, this.ballVy) > 330) {
      this.trail.forEach((q, i) => {
        this.trailGfx.fillStyle(0xffffff, 0.06 + 0.05 * i).fillCircle(q.x, q.y, 3.2 + i * 0.5);
      });
    }
  }

  private handlePeriodEnd(): void {
    this.foulCount = { home: 0, away: 0 };
    this.clockAcc = 0;
    if (this.half === 1) {
      this.half = 2;
      this.remaining = this.halfSeconds;
      this.beginHalftime();
    } else if (this.half === 2 && this.homeScore === this.awayScore && this.settings.extraTime) {
      this.half = 3;
      this.remaining = EXTRA_TIME_SECONDS;
      this.startKickoff(this.openingKickoff);
      this.flashScreen(0xffd23f, 0.3);
      this.audio.sfx('whistleLong');
      this.banner('EXTRA TIME', 'Golden goal wins it', 0xffd23f, 2400, 6);
      this.audio.speak('Extra time. The next goal wins.');
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
    this.markerGfx.clear();
    const hs = this.homeScore; const as = this.awayScore;
    const result = hs === as ? 'IT ENDS LEVEL' : hs > as ? 'ROCKETS WIN!' : 'COMETS WIN!';
    this.setMessage(hs === as ? '🤝 Full-time — it ends level!' : `🏆 FULL-TIME — ${hs > as ? 'Rockets' : 'Comets'} win!`);

    // winners celebrate until the next match; the arena erupts
    const now = this.time.now;
    this.players.forEach((p) => {
      p.vx = 0; p.vy = 0; p.act = null;
      p.celebrating = hs !== as && p.side === (hs > as ? 'home' : 'away');
      p.celebrateUntil = now + 1e9;
    });
    this.audio.sfx('whistleTriple');
    this.playAction(this.referee, 'whistle');
    this.time.delayedCall(700, () => this.audio.crowd('applause', 1));
    this.bumpCrowd(hs >= as ? 'home' : 'away', 1);
    this.bumpCrowd(hs > as ? 'away' : 'home', 0.4);
    this.flashBurst(24);
    this.banner('FULL-TIME', `${teamName('home')} ${hs}–${as} ${teamName('away')}`, 0xffd23f, 3500, 6);
    this.showPanel('FULL-TIME', result, 'CLICK or press ENTER to play again', true);
    this.audio.speak(hs === as
      ? `Full-time. It finishes ${hs}, ${as}.`
      : `Full-time. ${hs > as ? 'Rockets' : 'Comets'} win, ${Math.max(hs, as)} ${Math.min(hs, as)}.`);
    if (this.hint) {
      this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN';
      this.hint.style.display = 'block';
    }
  }

  // ═══════════════ TACTICS UI ═══════════════

  private cycleTactic(side: TeamSide, set?: Tactic): void {
    const cur = TACTIC_ORDER.indexOf(this.tactics[side]);
    this.tactics[side] = set ?? TACTIC_ORDER[(cur + 1) % TACTIC_ORDER.length];
    this.updateTacticLabel();
    this.setMessage(`${teamName(side)} tactic: ${TACTICS[this.tactics[side]].label}`);
  }

  private updateTacticLabel(): void {
    this.tacticText.setText(
      `Rockets: ${TACTICS[this.tactics.home].label} [G]   ·   Comets: ${TACTICS[this.tactics.away].label} [T]`
    );
  }

  private statsSummary(): Record<TeamSide, Record<string, number | string>> {
    const [ph, pa] = possessionPct(this.stats.home.poss, this.stats.away.poss);
    const f = (s: TeamSide, pc: number): Record<string, number | string> => {
      const st = this.stats[s];
      return {
        tactic: TACTICS[this.tactics[s]].label,
        possession: pc + '%',
        avgDefLine: st.lineN ? Math.round(st.lineSum / st.lineN) : 0,
        passes: st.passes, passAccuracy: passAccuracy(st.passOk, st.passes) + '%',
        shots: st.shots, onTarget: st.onTarget, saves: st.saves,
        intercepts: st.intercepts, tackles: st.tackles, fouls: st.fouls, corners: st.corners,
      };
    };
    return { home: f('home', ph), away: f('away', pa) };
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

    if (Phaser.Input.Keyboard.JustDown(this.keys.X)) {
      const distance = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
      if (this.possession === 'home' && distance < 48) this.passBall();
      else this.selectControlled();
    }

    const kz = this.keys.Z;
    if (Phaser.Input.Keyboard.JustDown(kz)) {
      const d = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
      if (this.gkHolder || (this.possession !== 'home' && d > 42)) {
        if (!this.gkHolder) this.setMessage('⚠ Get closer to shoot');
      } else {
        this.shotCharging = true;
        this.shotPower = 0.5;
      }
    }
    if (this.shotCharging) {
      this.shotPower = Math.min(1, this.shotPower + dt * 0.85);
      this.drawShotBar();
      if (Phaser.Input.Keyboard.JustUp(kz) || !kz.isDown) {
        this.shotCharging = false;
        this.aimGfx.clear();
        this.shootBall(this.shotPower);
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) this.tackle();
  }

  private drawShotBar(): void {
    const g = this.aimGfx;
    g.clear();
    const x = this.controlled.sprite.x - 20;
    const y = this.controlled.sprite.y - 32;
    g.fillStyle(0x000000, 0.6).fillRect(x, y, 40, 6);
    g.fillStyle(this.shotPower > 0.85 ? 0xef476f : this.shotPower > 0.65 ? 0xffd23f : 0x06d6a0, 1).fillRect(x, y, 40 * this.shotPower, 6);
  }

  // ═══════════════ TEAM AI (Phase 4) ═══════════════

  private phaseFor(side: TeamSide): Phase {
    if (this.possession !== null) return this.possession === side ? 'attack' : 'defend';
    if (Math.hypot(this.ballVx, this.ballVy) > 110) return this.lastTouch === side ? 'attack' : 'defend';
    return 'loose';
  }

  private getCarrier(side: TeamSide): Footballer | null {
    if (this.possession !== side || this.gkHolder) return null;
    if (side === 'home') return this.controlled;
    if (!this.carrier || this.carrier.side !== side) {
      this.carrier = this.nearestPlayer(side, this.ball.x, this.ball.y);
      this.carrierSince = this.time.now;
    }
    return this.carrier;
  }

  private getBallPrediction(): Sample[] {
    const now = this.time.now;
    if (now - this.predAt > 100) {
      this.predCache = this.predictBall(1.2);
      this.predAt = now;
    }
    return this.predCache;
  }

  private getInterceptor(side: TeamSide, mates: Footballer[], now: number): { p: Footballer; x: number; y: number } | null {
    const cur = this.interceptors[side];
    if (cur && now < cur.until && mates.includes(cur.p)) return cur;
    if (Math.hypot(this.ballVx, this.ballVy) < 110) { this.interceptors[side] = null; return null; }
    const samples = this.getBallPrediction();
    let best: { p: Footballer; x: number; y: number; t: number } | null = null;
    for (let i = 3; i < samples.length; i += 3) {
      const s = samples[i];
      if (s.z > 10) continue;
      for (const p of mates) {
        const reach = dist(p.sprite.x, p.sprite.y, s.x, s.y) / 175;
        if (reach <= s.t - 0.05 && (!best || s.t < best.t)) best = { p, x: s.x, y: s.y, t: s.t };
      }
    }
    this.interceptors[side] = best ? { p: best.p, x: best.x, y: best.y, until: now + 250 } : null;
    return this.interceptors[side];
  }

  private supportOrder(p: Footballer, cpos: Pt, att: number, foePts: Pt[], T: TacticParams, taken: Pt[], now: number, speed: number): Order {
    let h = this.aiHold.get(p);
    if (!h || now > h.until) {
      const base = att === 1 ? 0 : Math.PI;
      let best: Pt = { x: cpos.x, y: cpos.y };
      let bestS = -1e9;
      for (const a of [-1.25, -0.65, 0.65, 1.25]) {
        const c = clampPt(cpos.x + Math.cos(base + a) * T.support, cpos.y + Math.sin(base + a) * T.support);
        let minOpp = 90;
        for (const f of foePts) minOpp = Math.min(minOpp, Math.hypot(f.x - c.x, f.y - c.y));
        let s = Math.min(minOpp, 90) * 0.6;
        s += laneBlocked(cpos, c, foePts, 14) ? -45 : 25;
        s -= dist(p.sprite.x, p.sprite.y, c.x, c.y) * 0.05;
        for (const tk of taken) if (Math.hypot(tk.x - c.x, tk.y - c.y) < 50) s -= 40;
        if (s > bestS) { bestS = s; best = c; }
      }
      h = { x: best.x, y: best.y, until: now + 450 };
      this.aiHold.set(p, h);
    }
    taken.push({ x: h.x, y: h.y });
    return { x: h.x, y: h.y, speed };
  }

  private runnerOrder(p: Footballer, cpos: Pt, att: number, foePts: Pt[], T: TacticParams, taken: Pt[], now: number, speed: number, counter: boolean): Order {
    let h = this.aiHold.get(p);
    if (!h || now > h.until) {
      const goalX = att === 1 ? FIELD_W - LINE : LINE;
      if (counter || Math.random() < T.forwardRuns) {
        let x = cpos.x + att * Phaser.Math.Between(110, 190);
        x = att === 1 ? Math.min(x, goalX - 70) : Math.max(x, goalX + 70);
        let best: Pt = clampPt(x, CENTER_Y);
        let bestS = -1e9;
        for (const y of [CENTER_Y - 85, CENTER_Y, CENTER_Y + 85, cpos.y - 100, cpos.y + 100]) {
          const c = clampPt(x, y);
          let minOpp = 90;
          for (const f of foePts) minOpp = Math.min(minOpp, Math.hypot(f.x - c.x, f.y - c.y));
          let s = Math.min(minOpp, 90) * 0.6;
          s += laneBlocked(cpos, c, foePts, 14) ? -35 : 25;
          for (const tk of taken) if (Math.hypot(tk.x - c.x, tk.y - c.y) < 60) s -= 40;
          if (s > bestS) { bestS = s; best = c; }
        }
        h = { x: best.x, y: best.y, until: now + 1200 };
      } else {
        const wide = p.homeY < CENTER_Y ? -1 : 1;
        const c = clampPt(cpos.x + att * 30, CENTER_Y + wide * 100 * T.width);
        h = { x: c.x, y: c.y, until: now + 600 };
      }
      this.aiHold.set(p, h);
    }
    taken.push({ x: h.x, y: h.y });
    return { x: h.x, y: h.y, speed };
  }

  private updateTeamAI(side: TeamSide, dt: number): void {
    const now = this.time.now;
    const tac = this.tactics[side];
    const T = TACTICS[tac];
    const att = side === 'home' ? 1 : -1;
    const ownGoal: Pt = { x: side === 'home' ? LINE : FIELD_W - LINE, y: CENTER_Y };
    const phase = this.phaseFor(side);
    const mates = this.players.filter((p) =>
      p.side === side && p.role !== 'GK' && !p.celebrating && !(side === 'home' && p === this.controlled));
    const foes = this.players.filter((p) => p.side !== side && p.role !== 'GK');
    const foePts: Pt[] = foes.map((f) => ({ x: f.sprite.x, y: f.sprite.y }));
    const ball: Pt = { x: this.ball.x, y: this.ball.y };
    const counter = now < this.counterUntil[side];
    const spd = side === 'away' ? this.diff.cpuSpeed : 1;
    const SPR = 175 * T.tempo * (counter ? 1.08 : 1) * spd;
    const RUN = 150 * T.tempo * spd;
    const JOG = 105 * T.tempo * spd;
    const orders = new Map<Footballer, Order>();
    const shape = (p: Footballer, ph: Phase): Order => {
      const tg = shapeTarget({ x: p.homeX, y: p.homeY, role: p.role }, side, ph, tac, ball);
      return { x: tg.x, y: tg.y, speed: JOG };
    };
    let tackler: Footballer | null = null;
    let carrierAway: Footballer | null = null;
    let chaser: Footballer | null = null;

    if (phase === 'attack') {
      const carrier = this.getCarrier(side);
      const cpos: Pt = carrier ? { x: carrier.sprite.x, y: carrier.sprite.y } : ball;
      const taken: Pt[] = [];
      for (const p of mates) {
        if (p === carrier) continue;
        const ot = this.oneTwo;
        if (ot && ot.passer === p && ot.passer.side === side && now < ot.until) {
          const r = ot.receiver;
          const sy = r.sprite.y < CENTER_Y ? 1 : -1;
          const c = clampPt(r.sprite.x + att * 95, r.sprite.y + sy * 45);
          orders.set(p, { x: c.x, y: c.y, speed: SPR });
          continue;
        }
        if (this.passTarget === p) {
          const pred = this.getBallPrediction();
          const landing = pred.find((s) => s.t > 0.2 && s.z < 1.5);
          const e = landing ?? (pred.length ? pred[Math.min(pred.length - 1, 36)] : ball);
          orders.set(p, { x: e.x, y: e.y, speed: SPR });
          continue;
        }
        if (p.role === 'MID') orders.set(p, this.supportOrder(p, cpos, att, foePts, T, taken, now, RUN));
        else if (p.role === 'FWD') orders.set(p, this.runnerOrder(p, cpos, att, foePts, T, taken, now, SPR, counter));
        else orders.set(p, shape(p, 'attack'));
      }
      if (carrier && side === 'away') {
        orders.set(carrier, this.cpuCarrierThink(carrier, foes, dt, counter));
        carrierAway = carrier;
      }
    } else if (phase === 'defend') {
      const carrier = this.getCarrier(other(side));
      const cpos: Pt = carrier ? { x: carrier.sprite.x, y: carrier.sprite.y } : ball;
      const gx = ownGoal.x - cpos.x;
      const gy = ownGoal.y - cpos.y;
      const gl = Math.hypot(gx, gy) || 1;
      const dirG: Pt = { x: gx / gl, y: gy / gl };
      const icpt = !carrier && this.possession === null ? this.getInterceptor(side, mates, now) : null;
      if (icpt) orders.set(icpt.p, { x: icpt.x, y: icpt.y, speed: SPR + 10 });
      const free = mates.filter((p) => !icpt || p !== icpt.p);
      const byDist = [...free].sort((a, b) =>
        dist(a.sprite.x, a.sprite.y, cpos.x, cpos.y) - dist(b.sprite.x, b.sprite.y, cpos.x, cpos.y));
      const pressers: Footballer[] = [];
      let coverBase: Pt = cpos;
      if (carrier && byDist.length) {
        const p1 = byDist[0];
        const d1 = dist(p1.sprite.x, p1.sprite.y, cpos.x, cpos.y);
        if (d1 <= T.pressRadius) {
          orders.set(p1, { x: cpos.x + dirG.x * 20, y: cpos.y + dirG.y * 20, speed: SPR });
          tackler = p1;
        } else {
          orders.set(p1, { x: cpos.x + dirG.x * 55, y: cpos.y + dirG.y * 55, speed: RUN });
        }
        pressers.push(p1);
        coverBase = { x: cpos.x + dirG.x * 20, y: cpos.y + dirG.y * 20 };
        const p2 = byDist[1];
        if (T.pressers >= 2 && p2 && dist(p2.sprite.x, p2.sprite.y, cpos.x, cpos.y) < T.pressRadius) {
          orders.set(p2, { x: cpos.x - dirG.y * 38 + dirG.x * 30, y: cpos.y + dirG.x * 38 + dirG.y * 30, speed: SPR });
          pressers.push(p2);
        }
      }
      let pool = free.filter((p) => !pressers.includes(p));
      if (carrier && pool.length) {
        const cp: Pt = { x: coverBase.x + dirG.x * 55, y: coverBase.y + dirG.y * 55 };
        const cand = pool.filter((p) => p.role !== 'FWD');
        if (cand.length) {
          const cov = cand.reduce((b, p) =>
            dist(p.sprite.x, p.sprite.y, cp.x, cp.y) < dist(b.sprite.x, b.sprite.y, cp.x, cp.y) ? p : b);
          orders.set(cov, { x: cp.x, y: cp.y, speed: RUN });
          pool = pool.filter((p) => p !== cov);
        }
      }
      if (dist(cpos.x, cpos.y, ownGoal.x, ownGoal.y) < 230 && pool.length) {
        const cand = pool.filter((p) => p.role !== 'FWD');
        if (cand.length) {
          const last = cand.reduce((b, p) =>
            Math.abs(p.sprite.x - ownGoal.x) < Math.abs(b.sprite.x - ownGoal.x) ? p : b);
          const ux = cpos.x - ownGoal.x;
          const uy = cpos.y - ownGoal.y;
          const ul = Math.hypot(ux, uy) || 1;
          orders.set(last, { x: ownGoal.x + (ux / ul) * 78, y: ownGoal.y + (uy / ul) * 78, speed: SPR });
          pool = pool.filter((p) => p !== last);
        }
      }
      const markers = pool.filter((p) => p.role !== 'FWD' || tac === 'press');
      const markFoes = foes.filter((f) => f !== carrier);
      if (markers.length && markFoes.length) {
        const idx = assignMarks(
          markers.map((m) => ({ x: m.sprite.x, y: m.sprite.y })),
          markFoes.map((f) => ({ x: f.sprite.x, y: f.sprite.y })),
          ownGoal.x
        );
        markers.forEach((m, i) => {
          const oi = idx[i];
          if (oi < 0) return;
          const f = markFoes[oi];
          const fx = f.sprite.x;
          const fy = f.sprite.y;
          if (Math.hypot(fx - ownGoal.x, fy - ownGoal.y) > 520) return;
          const ux = ownGoal.x - fx; const uy = ownGoal.y - fy;
          const ul = Math.hypot(ux, uy) || 1;
          const bx = ball.x - fx; const by = ball.y - fy;
          const bl = Math.hypot(bx, by) || 1;
          orders.set(m, {
            x: fx + (ux / ul) * T.markDist + (bx / bl) * 10,
            y: fy + (uy / ul) * T.markDist + (by / bl) * 10,
            speed: RUN,
          });
        });
      }
      let sum = 0;
      for (const p of mates) sum += Math.abs(p.sprite.x - ownGoal.x);
      if (mates.length) { this.stats[side].lineSum += sum / mates.length; this.stats[side].lineN++; }
    } else {
      const sorted = [...mates].sort((a, b) =>
        dist(a.sprite.x, a.sprite.y, ball.x, ball.y) - dist(b.sprite.x, b.sprite.y, ball.x, ball.y));
      const n = tac === 'press' ? 2 : 1;
      const bp: Pt = { x: ball.x + this.ballVx * 0.25, y: ball.y + this.ballVy * 0.25 };
      sorted.slice(0, n).forEach((p) => orders.set(p, { x: bp.x, y: bp.y, speed: SPR }));
      chaser = sorted[0] ?? null;
    }

    const shapePhase: Phase = phase !== 'loose' ? phase : ((ball.x - CENTER_X) * att < 0 ? 'defend' : 'attack');
    for (const p of mates) {
      const o = orders.get(p) ?? shape(p, shapePhase);
      this.steerTo(p, o.x, o.y, o.speed, dt);
    }

    if (carrierAway && this.carrier === carrierAway) this.carryBallAI(carrierAway);
    if (tackler && this.aiTackle(tackler)) return;
    if (chaser && this.possession === null && Math.hypot(this.ballVx, this.ballVy) < 150 &&
        dist(chaser.sprite.x, chaser.sprite.y, ball.x, ball.y) < 20 && this.ballHeight < 6) {
      this.controlBall(chaser);
    }
  }

  private cpuCarrierThink(c: Footballer, foes: Footballer[], dt: number, counter: boolean): Order {
    const side = c.side;
    const T = TACTICS[this.tactics[side]];
    const att = side === 'home' ? 1 : -1;
    const now = this.time.now;
    const pos: Pt = { x: c.sprite.x, y: c.sprite.y };
    const hold: Order = { x: pos.x, y: pos.y, speed: 0 };
    if (this.kickoffLock > 0 || this.gkHolder) return hold;

    if (dist(pos.x, pos.y, this.ball.x, this.ball.y) > 34) {
      this.carrier = null;
      return { x: this.ball.x, y: this.ball.y, speed: 165 };
    }

    const foePts: Pt[] = foes.map((f) => ({ x: f.sprite.x, y: f.sprite.y }));
    const goalX = att === 1 ? FIELD_W - LINE : LINE;
    let pressure = 999;
    for (const f of foePts) pressure = Math.min(pressure, Math.hypot(f.x - pos.x, f.y - pos.y));

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0 || pressure < 38) {
      this.thinkTimer = 0.28;
      const held = (now - this.carrierSince) / 1000;

      const gk = this.keeperOf(other(side)).sprite;
      const q = shotQuality(pos, att, foePts, { x: gk.x, y: gk.y });
      const dGoal = Math.hypot(goalX - pos.x, CENTER_Y - pos.y);
      if (q >= T.shootThr && dGoal <= T.shootRange) {
        this.cpuShoot(c, q, dGoal);
        return hold;
      }

      let best: { m: Footballer; lead: Pt; score: number; through: boolean; lob: boolean } | null = null;
      for (const m of this.players) {
        if (m.side !== side || m === c || m.role === 'GK') continue;
        const lead: Pt = { x: m.sprite.x + m.vx * 0.3, y: m.sprite.y + m.vy * 0.3 };
        const dd = Math.hypot(lead.x - pos.x, lead.y - pos.y);
        const sDrive = scorePass(pos, lead, att, foePts, T);
        const sLob = dd >= 90 && dd <= 330 ? scorePass(pos, lead, att, foePts, T, true) : -1e9;
        const lob = sLob > sDrive;
        let s = Math.max(sDrive, sLob);
        if (this.oneTwo && now < this.oneTwo.until && this.oneTwo.receiver === c && this.oneTwo.passer === m) s += 45;
        const through = !lob && m.role === 'FWD' && att * (lead.x - pos.x) > 60;
        if (through) s += 15 * T.riskPass;
        if (!best || s > best.score) best = { m, lead, score: s, through, lob };
      }
      const wantsPass = best !== null && (
        (pressure < 45 && best.score > -20) ||
        (held >= T.holdTime && best.score > 12) ||
        held > 2.5);
      if (wantsPass && best) {
        this.cpuPass(c, best.m, best.lead, best.through, best.lob);
        return hold;
      }
    }

    let dx = goalX - att * 70 - pos.x;
    let dy = CENTER_Y - pos.y;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    for (const f of foePts) {
      const d = Math.hypot(pos.x - f.x, pos.y - f.y);
      if (d < 80 && d > 1) {
        const w = (80 - d) / 80;
        dx += ((pos.x - f.x) / d) * w * 1.6;
        dy += ((pos.y - f.y) / d) * w * 1.6;
      }
    }
    const nl = Math.hypot(dx, dy) || 1;
    return { x: pos.x + (dx / nl) * 80, y: pos.y + (dy / nl) * 80, speed: 150 * T.tempo * (counter ? 1.12 : 1) * this.diff.cpuSpeed };

  private carryBallAI(c: Footballer): void {
    if (this.possession !== c.side || this.gkHolder || c.cooldown > 0) return;
    if (dist(c.sprite.x, c.sprite.y, this.ball.x, this.ball.y) < 26) {
      this.ball.x = c.sprite.x + Math.cos(c.facing) * 15;
      this.ball.y = c.sprite.y + Math.sin(c.facing) * 15;
      this.ballVx = c.vx * 0.25;
      this.ballVy = c.vy * 0.25;
      this.ballCurl = 0; this.ballVSpin = 0;
      this.registerTouch(c);
    }
  }

  private cpuShoot(c: Footballer, q: number, dGoal: number): void {
    const side = c.side;
    const gk = this.keeperOf(other(side)).sprite;
    const ty = (gk.y >= CENTER_Y ? CENTER_Y - (GOAL_HALF - 14) : CENTER_Y + (GOAL_HALF - 14)) + Phaser.Math.Between(-8, 8);
    const wide = Math.abs(c.sprite.y - CENTER_Y) > 70;
    const power = dGoal > 200 ? Phaser.Math.FloatBetween(0.85, 1) : Phaser.Math.Clamp(0.45 + q * 0.3 + Phaser.Math.FloatBetween(0, 0.15), 0.45, 0.9);
    const curlOn = wide && dGoal < 280 && Math.random() < 0.4;
    this.takeShot(c, ty, power, Math.random() < 0.3, curlOn);
    this.playSound('shoot', 0.5 + power * 0.6);
    this.setMessage(`${power > 0.85 ? 'Power shot' : curlOn ? 'Curled shot' : 'Shot'} from ${teamName(side)}!`);
  }

  private cpuPass(c: Footballer, target: Footballer, lead: Pt, through: boolean, lob: boolean): void {
    const T = TACTICS[this.tactics[c.side]];
    const att = c.side === 'home' ? 1 : -1;
    const now = this.time.now;
    const isReturn = this.oneTwo !== null && this.oneTwo.receiver === c;
    this.playPass(c, lead, lob, through);
    this.passTarget = target;
    if (isReturn) this.oneTwo = null;
    else if (!lob && dist(c.sprite.x, c.sprite.y, target.sprite.x, target.sprite.y) < 170 &&
             att * (target.sprite.x - c.sprite.x) > -20 && Math.random() < T.oneTwo) {
      this.oneTwo = { passer: c, receiver: target, until: now + 1600 };
    }
    this.playSound('pass');
  }

  private aiTackle(p: Footballer): boolean {
    if (p.cooldown > 0 || this.gkHolder) return false;
    if (dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) >= 23) return false;
    p.cooldown = 0.4;
    this.playAction(p, 'tackle', Math.atan2(this.ball.y - p.sprite.y, this.ball.x - p.sprite.x));
    const roll = Phaser.Math.Between(0, 100);
    const isHome = p.side === 'home';
    const foulT = isHome ? 10 : this.diff.foul;
    const winT = isHome ? 60 : this.diff.tackleWin;
    if (roll < foulT) {
      this.awardFoul(p.side, this.ball.x, this.ball.y);
      return true;
    }
    if (roll < winT) {
      this.stats[p.side].tackles++;
      const loser = p.side === 'home' ? this.carrier : this.controlled;
      this.playSound('tackle');
      this.knockLoose(p, loser);
      this.spawnDustParticles(this.ball.x, this.ball.y);
      this.setMessage(`${teamName(p.side)} win the tackle — loose ball!`);
    }
    return false;
  }

  private knockLoose(tackler: Footballer, loser: Footballer | null): void {
    const ang = tackler.facing + Phaser.Math.FloatBetween(-0.5, 0.5);
    this.ballVx = Math.cos(ang) * 140 + (loser ? loser.vx * 0.3 : 0);
    this.ballVy = Math.sin(ang) * 140 + (loser ? loser.vy * 0.3 : 0);
    this.ballVz = 18;
    this.ballCurl = Phaser.Math.FloatBetween(-0.3, 0.3);
    this.ballVSpin = 0;
    this.possession = null;
    this.carrier = null;
    this.registerTouch(tackler);
    tackler.cooldown = 0;
    if (loser) loser.cooldown = 0.45;
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
        this.ballCurl = 0; this.ballVSpin = 0;
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

  private predictBall(maxT = 1.6): Sample[] {
    const s: BallState = {
      x: this.ball.x, y: this.ball.y, z: this.ballHeight,
      vx: this.ballVx, vy: this.ballVy, vz: this.ballVz, curl: this.ballCurl, vspin: this.ballVSpin,
    };
    const out: Sample[] = [];
    const dt = 1 / 60;
    for (let i = 1; i <= Math.round(maxT * 60); i++) {
      stepBall(s, dt);
      out.push({ t: i * dt, x: s.x, y: s.y, z: s.z });
      if (s.x < LINE || s.x > FIELD_W - LINE || s.y < LINE || s.y > FIELD_H - LINE) break;
      if (Math.hypot(s.vx, s.vy) < 15) break;
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
    if (this.possession === null && speed < 120 && dBall < 120 && inBox) {
      const oppNear = this.players.some((o) =>
        o.side !== p.side && o.role !== 'GK' && dist(o.sprite.x, o.sprite.y, this.ball.x, this.ball.y) < dBall * 0.8);
      if (!oppNear) return { x: this.ball.x, y: this.ball.y };
    }
    return keeperTarget(p.side, this.ball.x, this.ball.y);
  }

  private gkReady(p: Footballer, b: GkBrain, dt: number): void {
    if (this.gkHolder === p) { p.vx = 0; p.vy = 0; return; }

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
      p.vx = 0; p.vy = 0;
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
    if (this.ballVx * dirIn >= -30) return;
    const samples = this.predictBall();
    if (!samples.length) return;
    const last = samples[samples.length - 1];
    const reachesLine = p.side === 'home' ? last.x < goalLine + 1 : last.x > goalLine - 1;
    if (!reachesLine) return;
    if (Math.abs(last.y - CENTER_Y) > GOAL_HALF + 10) return;
    if (last.z > GOAL_HEIGHT + 8) return;

    const dp = p.side === 'away' ? this.diff : DIFFS.normal;      // difficulty only changes the CPU keeper
    const react = Phaser.Math.FloatBetween(dp.gkReact[0], dp.gkReact[1]);
    const err = {
      y: Phaser.Math.FloatBetween(-dp.gkErr, dp.gkErr),
      z: Phaser.Math.FloatBetween(-5, 5),
    };
    const plan = chooseSave(p.sprite.x, p.sprite.y, dirIn, samples, react, err);
    if (!plan) return;
    b.plan = plan; b.react = react; b.clock = 0; b.result = 'none';
  }

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
      const nx = Phaser.Math.Clamp(b.origX + pl.dirX * 0.6 * b.extNow, 24, FIELD_W - 24);
      const ny = Phaser.Math.Clamp(b.origY + pl.dirY * 0.6 * b.extNow, 24, FIELD_H - 24);
      p.sprite.setPosition(nx, ny);
      p.shadow.setPosition(nx + 2, ny + SHADOW_DY);
    }
    p.vx = 0; p.vy = 0;
    if (b.t >= T + HOLD_T) { b.mode = 'fallen'; b.t = 0; }
  }

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
    if (speed <= 150) return;
    for (const gk of this.players) {
      const b = gk.gk;
      if (!b || gk.cooldown > 0 || b.contactCool > 0 || b.mode === 'concede') continue;
      const dirIn = gk.side === 'home' ? 1 : -1;
      if (this.lastTouch === gk.side && this.ballVx * dirIn > -20) continue;
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
    // a recorded shot that reaches the keeper was on target
    if (this.shooter && this.shooter.side !== gk.side) this.stats[this.shooter.side].onTarget++;

    if (hit.kind === 'body') {
      b.result = 'block';
      this.deflect(gk, speed, 0.35, false);
      return;
    }

    this.shotMissed();
    this.stats[gk.side].saves++;
    const res = resolveSaveContact(speed, hit.quality, this.ballHeight);
    this.reactSave(gk);
    if (res === 'catch') {
      b.result = 'catch';
      this.registerTouch(gk);
      this.possession = gk.side;
      this.ballVx = 0; this.ballVy = 0;
      this.gkCatch(gk);
      this.setMessage('🧤 Saved! Keeper holds it');
      return;
    }

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
    this.ballCurl = Phaser.Math.FloatBetween(-0.4, 0.4);
    this.ballVSpin = 0;
    this.registerTouch(gk);
    this.possession = null;
    this.playSound('tackle');
    this.spawnDustParticles(this.ball.x, this.ball.y);
    this.setMessage(res === 'tip-over' ? '🧤 Tipped over the bar!' : '🧤 Parried!');
  }

  // ═══════════════ BALL PHYSICS & TOUCH TRACKING ═══════════════

  private updateBall(dt: number): void {
    this.ballSquash = Math.max(0, this.ballSquash - dt * 8);

    if (this.gkHolder) {
      const gk = this.gkHolder;
      this.ball.setPosition(gk.sprite.x + (gk.side === 'home' ? 10 : -10), gk.sprite.y);
      this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
      this.ballCurl = 0; this.ballVSpin = 0;
      return;
    }

    const s: BallState = {
      x: this.ball.x, y: this.ball.y, z: this.ballHeight,
      vx: this.ballVx, vy: this.ballVy, vz: this.ballVz, curl: this.ballCurl, vspin: this.ballVSpin,
    };
    const ev = stepBall(s, dt);
    this.ball.x = s.x; this.ball.y = s.y; this.ballHeight = s.z;
    this.ballVx = s.vx; this.ballVy = s.vy; this.ballVz = s.vz;
    this.ballCurl = s.curl; this.ballVSpin = s.vspin;
    this.ballSpin += (Math.hypot(s.vx, s.vy) * 0.05 + Math.abs(s.curl) * 6) * dt;
    this.handleBallEvent(ev);

    this.keeperContacts();
    if (this.gkHolder) return;
    if (this.checkBoundaries()) return;

    this.ball.x = Phaser.Math.Clamp(this.ball.x, 5, FIELD_W - 5);
    this.ball.y = Phaser.Math.Clamp(this.ball.y, 5, FIELD_H - 5);

    this.handleBallContacts();
  }

  private handleBallEvent(ev: BallEvent): void {
    if (ev === 'bounce') {
      this.ballSquash = 1;
      if (LAST_IMPACT > 90) this.playSound('bounce', Math.min(1, LAST_IMPACT / 250));
    } else if (ev === 'post' || ev === 'bar') {
      this.playSound('post');
      this.cameraShake = Math.max(this.cameraShake, 0.12);
      this.touchId++;
      if (this.shooter && this.shooter.side !== this.lastTouch) { /* not a shot at his goal */ } else if (this.shooter) this.stats[this.shooter.side].onTarget++;
      this.shotMissed();
      this.reactPost(ev);
      this.setMessage(ev === 'post' ? '🥅 OFF THE POST!' : '🥅 OFF THE BAR!');
    }
  }

  private checkBoundaries(): boolean {
    if (this.state !== 'playing' || this.goalScored || this.kickoffLock > 0) return false;
    const decision = decideOutOfPlay(this.ball.x, this.ball.y, this.lastTouch, this.ballHeight);
    if (!decision) return false;
    const z = this.ballHeight;
    // a shot that just misses the goal is a near miss: the crowd reacts
    if (decision.kind === 'goal-clearance' && this.shooter && this.time.now <= this.shooterUntil && decision.team !== this.shooter.side) {
      if (Math.abs(this.ball.y - CENTER_Y) < GOAL_HALF + 40 || z > GOAL_HEIGHT) this.reactNearMiss(z > GOAL_HEIGHT);
    }
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ballCurl = 0; this.ballVSpin = 0;
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
    this.lastToucher = p;
    this.touchId++;
    this.passTarget = null;
    // pass accuracy: a pass counts as completed when a team-mate touches the ball next
    if (this.pendingPass) {
      if (p.side === this.pendingPass.side && p !== this.pendingPass.kicker) this.stats[p.side].passOk++;
      this.pendingPass = null;
    }
    if (this.indirectPending && p !== this.indirectPending.taker) this.indirectPending = null;
    if (this.shooter && p.side === this.shooter.side && p !== this.shooter) this.shooter = null;
  }

  private controlBall(p: Footballer): void {
    const prev = this.possession;
    this.registerTouch(p);
    this.possession = p.side;
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballCurl = 0; this.ballVSpin = 0;
    if (p.role === 'GK') { this.gkCatch(p); return; }
    this.carrier = p;
    this.carrierSince = this.time.now;
    this.thinkTimer = 0;
    if (prev !== p.side) {
      const T = TACTICS[this.tactics[p.side]];
      if (T.counterMs > 0) this.counterUntil[p.side] = this.time.now + T.counterMs;
    }
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
      this.stats[best.side].intercepts++;
      this.controlBall(best);
      this.setMessage(`Intercepted by ${teamName(best.side)}`);
    } else {
      this.deflect(best, speed, 0.5, false);
    }
  }

  private deflect(p: Footballer, speed: number, keep: number, save: boolean): void {
    this.shotMissed();
    this.carrier = null;
    let nx = this.ball.x - p.sprite.x;
    let ny = this.ball.y - p.sprite.y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const inVx = this.ballVx; const inVy = this.ballVy;
    const r = reflect(inVx, inVy, nx, ny, keep, 0.85);
    let ox = r.x; let oy = r.y;
    if (Math.hypot(ox, oy) < 60) { ox += nx * 60; oy += ny * 60; }
    this.ballVx = ox; this.ballVy = oy;
    const vt = (inVx * -ny + inVy * nx) / (speed || 1);
    this.ballCurl = Phaser.Math.Clamp(vt * 0.7, -0.6, 0.6);
    this.ballVSpin = 0;
    this.ballVz = 20;
    this.ball.x = p.sprite.x + nx * (CONTACT_RADIUS + 2);
    this.ball.y = p.sprite.y + ny * (CONTACT_RADIUS + 2);
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
    this.carrier = null;
    this.gkHoldTimer = 1.5 + Math.random() * 0.5;
    this.possession = gk.side;
    this.ballVx = 0; this.ballVy = 0;
    this.ballCurl = 0; this.ballVSpin = 0;
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
    this.passTarget = mate;
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
        this.ballCurl = 0; this.ballVSpin = 0;
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

  private playPass(c: Footballer, lead: Pt, lob: boolean, fast = false): void {
    const d = dist(this.ball.x, this.ball.y, lead.x, lead.y);
    const ang = Math.atan2(lead.y - this.ball.y, lead.x - this.ball.x);
    if (lob) {
      const l = solveLob(Phaser.Math.Clamp(d, 60, 380));
      this.kickBall(Math.cos(ang) * l.speed, Math.sin(ang) * l.speed, c, l.vz, 'pass', { vspin: l.vspin });
    } else {
      const speed = Phaser.Math.Clamp(d * 1.35, 180, fast ? 360 : 330);
      this.kickBall(Math.cos(ang) * speed, Math.sin(ang) * speed, c, 8, 'pass');
    }
  }

  private passBall(): void {
    if (this.gkHolder) return;
    const lob = this.keys.C.isDown;
    const me = this.controlled;
    const mpos: Pt = { x: me.sprite.x, y: me.sprite.y };
    const T = TACTICS[this.tactics.home];
    const foePts: Pt[] = this.players.filter((p) => p.side === 'away' && p.role !== 'GK').map((p) => ({ x: p.sprite.x, y: p.sprite.y }));
    const moving = Math.hypot(me.vx, me.vy) > 20;
    let best: { m: Footballer; lead: Pt; score: number } | null = null;
    for (const m of this.players) {
      if (m.side !== 'home' || m === me || m.role === 'GK') continue;
      const lead: Pt = { x: m.sprite.x + m.vx * 0.3, y: m.sprite.y + m.vy * 0.3 };
      let s = scorePass(mpos, lead, 1, foePts, T, lob);
      if (moving) s += 25 * Math.cos(Phaser.Math.Angle.Wrap(Math.atan2(lead.y - mpos.y, lead.x - mpos.x) - me.facing));
      if (!best || s > best.score) best = { m, lead, score: s };
    }
    if (!best) return;
    this.playPass(me, best.lead, lob);
    this.passTarget = best.m;
    this.playSound('pass');
    this.setMessage(lob ? '↗ Lofted pass' : '→ Pass played');
  }

  private takeShot(c: Footballer, targetY: number, power: number, high: boolean, curlOn: boolean): void {
    const att = c.side === 'home' ? 1 : -1;
    const goalX = att === 1 ? FIELD_W - LINE : LINE;
    const p = Phaser.Math.Clamp(power, 0, 1);
    const speed = lerp(260, 520, p);
    const from: Pt = { x: this.ball.x, y: this.ball.y };
    const lift = shotLiftFor(speed, Math.abs(goalX - from.x), high);
    let aim = Math.atan2(targetY - from.y, goalX - from.x);
    let curl = 0;
    if (curlOn) {
      curl = 0.9 * (targetY >= from.y ? 1 : -1) * att;
      aim = solveAim(from, { x: goalX, y: targetY }, speed, lift, curl, 0);
    }
    aim += (Math.random() - 0.5) * 2 * (0.01 + Math.max(0, p - 0.6) * 0.14 + (c.side === 'away' ? this.diff.shotErr : 0));
    this.kickBall(Math.cos(aim) * speed, Math.sin(aim) * speed, c, lift, 'shoot', { curl });
  }

  private shootBall(power: number): void {
    if (this.gkHolder) return;
    const me = this.controlled;
    const d = dist(me.sprite.x, me.sprite.y, this.ball.x, this.ball.y);
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('⚠ Get closer to shoot');
      return;
    }
    const high = this.keys.C.isDown;
    const curl = this.keys.V.isDown;
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const vIn = Number(down) - Number(up);
    const targetY = CENTER_Y + (vIn !== 0 ? vIn * (GOAL_HALF - 12) + Phaser.Math.Between(-6, 6) : Phaser.Math.Between(-30, 30));
    this.takeShot(me, targetY, power, high, curl);
    this.playSound('shoot', 0.5 + power * 0.6);
    this.setMessage(
      (power > 0.85 ? '💥 POWER SHOT!' : power < 0.6 ? '⚽ Soft shot' : '💥 SHOT!') + (high ? ' (high)' : '') + (curl ? ' (curled)' : '')
    );
    this.cameraShake = 0.06 + 0.1 * power;
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
      this.stats.home.tackles++;
      this.knockLoose(me, opponent);
      this.selectControlled();
      this.setMessage('✓ Clean tackle — the ball runs loose!');
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

  private kickBall(vx: number, vy: number, kicker: Footballer, lift = 10, action?: ActionType, spin?: SpinSpec): void {
    this.gkHolder = null;
    this.carrier = null;
    this.ballVx = vx;
    this.ballVy = vy;
    this.ballVz = lift;
    this.ballCurl = spin?.curl ?? 0;
    this.ballVSpin = spin?.vspin ?? 0;
    this.ballSquash = 0;
    this.possession = null;
    this.registerTouch(kicker);
    kicker.cooldown = 0.25;
    if (action) this.playAction(kicker, action, Math.atan2(vy, vx));
    if (action === 'pass') {
      this.stats[kicker.side].passes++;
      this.pendingPass = { side: kicker.side, kicker };
    }
    if (action === 'shoot') {
      this.stats[kicker.side].shots++;
      this.shooter = kicker;
      this.shooterUntil = this.time.now + 3000;
    }
  }

  private fireTestShot(targetSide: TeamSide, targetY: number, z: number, speed: number): void {
    const attacker = other(targetSide);
    const dirIn = targetSide === 'home' ? 1 : -1;
    const goalX = targetSide === 'home' ? LINE : FIELD_W - LINE;
    const sx = goalX + dirIn * 300;
    this.prepDemo();
    this.ball.setPosition(sx, CENTER_Y);
    const shooter = this.players.find((p) => p.side === attacker && p.role === 'FWD')!;
    const ang = Math.atan2(targetY - CENTER_Y, goalX - sx);
    const lift = z > 15 ? shotLiftFor(speed, 300, true) : 20;
    this.kickBall(Math.cos(ang) * speed, Math.sin(ang) * speed, shooter, lift, 'shoot');
    this.kickoffLock = 0.1;
    this.setMessage(`Test shot at ${teamName(targetSide)} goal`);
  }

  private prepDemo(): void {
    this.audio.unlock();
    this.paused = false;
    this.entrance = null;
    this.hidePanel();
    this.restart = null;
    this.state = 'playing';
    this.gkHolder = null;
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.players.forEach((p) => { if (p.gk) this.resetKeeper(p.gk); });
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ballCurl = 0; this.ballVSpin = 0;
  }

  private fireDemo(kind: string): void {
    this.prepDemo();
    const shooter = this.players.find((p) => p.side === 'home' && p.role === 'FWD')!;
    const goalX = FIELD_W - LINE;
    const place = (x: number, y: number): void => this.ball.setPosition(x, y);
    switch (kind) {
      case 'drivenPass': place(300, CENTER_Y); this.kickBall(330, 0, shooter, 8, 'pass'); break;
      case 'lobPass': {
        place(300, CENTER_Y);
        const l = solveLob(400);
        this.kickBall(l.speed, 0, shooter, l.vz, 'pass', { vspin: l.vspin });
        break;
      }
      case 'weakShot': place(580, CENTER_Y); this.takeShot(shooter, CENTER_Y + 25, 0.0, false, false); break;
      case 'strongShot': place(580, CENTER_Y); this.takeShot(shooter, CENTER_Y + 25, 0.5, false, false); break;
      case 'powerShot': place(580, CENTER_Y); this.takeShot(shooter, CENTER_Y + 25, 1.0, false, false); break;
      case 'curlShot': place(640, 110); this.takeShot(shooter, CENTER_Y + 34, 0.7, false, true); break;
      case 'post': {
        place(600, CENTER_Y);
        const ang = Math.atan2(CENTER_Y - GOAL_HALF - CENTER_Y, goalX - 600);
        this.kickBall(Math.cos(ang) * 400, Math.sin(ang) * 400, shooter, 10, 'shoot');
        break;
      }
      case 'bar': {
        place(600, CENTER_Y);
        const lift = solveLift({ x: 600, y: CENTER_Y }, 0, 420, GOAL_HEIGHT, goalX);
        this.kickBall(420, 0, shooter, lift, 'shoot');
        break;
      }
      default: this.setMessage('demo: drivenPass | lobPass | weakShot | strongShot | powerShot | curlShot | post | bar'); return;
    }
    this.kickoffLock = 0.1;
    this.setMessage(`Demo: ${kind}`);
  }

  // ═══════════════ FOULS ═══════════════

  private awardFoul(fouler: TeamSide, x: number, y: number): void {
    this.foulCount[fouler]++;
    this.stats[fouler].fouls++;
    const n = this.foulCount[fouler];
    const spec = decideFoul(fouler, x, y, n);
    this.startRestart(spec);
    this.reactFoul(fouler, spec);
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
    this.shotCharging = false;
    this.pendingPass = null;
    this.carrier = null;
    this.passTarget = null;
    this.oneTwo = null;
    this.aiHold.clear();
    this.interceptors = { home: null, away: null };
    this.thinkTimer = 0;
    this.possession = spec.team;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ballCurl = 0; this.ballVSpin = 0; this.ballSquash = 0;
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
    this.refSignalRestart(spec);
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

  /** A pulsing ring marks the restart spot so both teams' restarts are clearly visible. */
  private drawRestartMarker(r: Restart): void {
    const g = this.markerGfx;
    g.clear();
    const pulse = 0.5 + 0.5 * Math.sin(this.time.now * 0.008);
    g.lineStyle(2, r.team === 'home' ? 0x4da3ff : 0xff6b6b, 0.5 + 0.4 * pulse).strokeCircle(r.x, r.y, 11 + 2 * pulse);
  }

  private updateRestart(dt: number): void {
    const r = this.restart;
    if (!r) { this.state = 'playing'; return; }
    r.elapsed += dt;
    this.drawRestartMarker(r);

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
    let mate: Footballer | null = null;
    const toGoal = Math.abs(goalX - r.x);

    if (r.kind === 'penalty' || r.kind === 'second-penalty' || (r.kind === 'free-kick' && toGoal < 320)) {
      tx = goalX; ty = CENTER_Y + Phaser.Math.Between(-40, 40); shot = true;
    } else if (r.kind === 'corner') {
      tx = goalX - dirA * Phaser.Math.Between(90, 120); ty = CENTER_Y + Phaser.Math.Between(-45, 45);
    } else {
      mate = this.findOpenTeammate(r.team, r.x, r.y, r.taker);
      if (mate) { tx = mate.sprite.x; ty = mate.sprite.y; }
      else { tx = r.x + dirA * 200; ty = CENTER_Y; }
    }
    if (shot) r.lofted = Math.random() < 0.35;
    const aim = Math.atan2(ty - r.y, tx - r.x);
    const speed = Phaser.Math.Clamp(Math.hypot(tx - r.x, ty - r.y) * 1.3, info.min, info.max);
    const power = shot ? Phaser.Math.FloatBetween(0.8, 1) : (speed - info.min) / (info.max - info.min);
    this.takeRestart(r, aim, power);
    if (mate) this.passTarget = mate;
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

    const goalX = r.team === 'home' ? FIELD_W - LINE : LINE;
    let lift = info.lift + (r.lofted ? 100 : 0);
    if (r.kind === 'penalty' || r.kind === 'second-penalty' || (r.kind === 'free-kick' && action === 'shoot')) {
      lift = shotLiftFor(speed, Math.abs(goalX - r.x), r.lofted);
    }

    let spin: SpinSpec | undefined;
    if (r.kind === 'corner') {
      const ux = Math.cos(aim); const uy = Math.sin(aim);
      const toGx = goalX - r.x; const toGy = CENTER_Y - r.y;
      const sgn = Math.sign(-uy * toGx + ux * toGy) || 1;
      spin = { curl: 0.45 * sgn };
      this.stats[r.team].corners++;
    }

    this.restart = null;
    this.state = 'playing';
    this.kickoffLock = 0.25;
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.markerGfx.clear();

    this.kickBall(vx, vy, r.taker, lift, action, spin);
    r.taker.cooldown = 1.0;
    this.indirectPending = info.indirect ? { team: r.team, taker: r.taker, kind: r.kind } : null;
    if (r.kind === 'penalty') this.keeperAnticipate(other(r.team));

    if (r.kind === 'kickoff') {                      // the referee starts the match / restarts it after a goal
      this.audio.sfx('whistleShort');
      this.playAction(this.referee, 'whistle');
      this.audio.crowd('chant', 0.5);
    }
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
    this.audio.sfx('whistleShort');
    this.playAction(this.referee, 'whistle');
    this.banner('4-SECOND RULE', msg.replace('⏱ 4-SECOND RULE! ', ''), 0xffd23f, 1800, 3);
    this.setMessage(`${msg} · ${this.restart!.baseMsg}`);
  }

  // ═══════════════ GOAL ═══════════════

  private scoreGoal(side: TeamSide): void {
    if (this.goalScored) return;

    if (this.indirectPending) {
      const pend = this.indirectPending;
      this.indirectPending = null;
      this.shotMissed();
      this.audio.sfx('whistleShort');
      if (side === pend.team) {
        this.startRestart(clearanceSpec(other(side)));
        this.banner('NO GOAL', 'Direct from an indirect restart', 0xffd23f, 1800, 4);
        this.setMessage('No goal — direct from an indirect restart · ' + this.restart!.baseMsg);
      } else {
        this.startRestart(cornerSpec(side, this.ball.y));
        this.banner('NO GOAL', 'Own goal direct from restart — corner', 0xffd23f, 1800, 4);
        this.setMessage('Own goal direct from restart — corner · ' + this.restart!.baseMsg);
      }
      return;
    }

    this.goalScored = true;
    if (this.shooter && this.shooter.side === side) this.stats[side].onTarget++;
    this.shooter = null;
    this.carrier = null;
    this.shotCharging = false;
    if (side === 'home') this.homeScore++; else this.awayScore++;

    this.state = 'goal';
    this.restart = null;
    this.gkHolder = null;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ballCurl = 0; this.ballVSpin = 0;
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.updateHud();

    const teamLabel = side === 'home' ? 'ROCKETS' : 'COMETS';
    this.showGoalCelebration('GOAL!!!', `${teamLabel} SCORE!`);
    this.flashScreen(0xffffff, 0.7);
    this.cameraShake = 0.4;
    this.reactGoal(side);

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
      this.cameras.main.setScroll(Phaser.Math.Between(-intensity, intensity), -STAND + Phaser.Math.Between(-intensity, intensity));
      this.cameraShake -= dt;
      if (this.cameraShake <= 0) { this.cameraShake = 0; this.cameras.main.setScroll(0, -STAND); }
    }
  }

  // ═══════════════ SOUND ═══════════════

  private playSound(type: 'kick' | 'pass' | 'shoot' | 'tackle' | 'post' | 'bounce', intensity = 1): void {
    this.audio.sfx(type, intensity);
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
    this.cameras.main.setScroll(0, -STAND);
    this.cameraShake = 0;
    this.restartLabel.setText('');
    this.aimGfx.clear();
    this.markerGfx.clear();
    this.trail = [];
    this.hidePanel();
    this.bannerToken++;
    this.bannerBg.setVisible(false); this.bannerTitle.setVisible(false); this.bannerSub.setVisible(false);
    this.bannerUntil = 0; this.bannerPrio = 0;
    this.entrance = null;
    this.excite = { home: 0.2, away: 0.2 };

    this.homeScore = 0;
    this.awayScore = 0;
    this.remaining = this.halfSeconds;
    this.half = 1;
    this.paused = false;
    this.ended = false;
    this.clockAcc = 0;
    this.goalScored = false;
    this.restart = null;
    this.indirectPending = null;
    this.gkHolder = null;
    this.shooter = null;
    this.shotCharging = false;
    this.pendingPass = null;
    this.counterUntil = { home: 0, away: 0 };
    this.stats = { home: freshStats(), away: freshStats() };
    this.foulCount = { home: 0, away: 0 };
    if (this.hint) this.hint.style.display = 'none';
    this.startKickoff(this.openingKickoff);
    this.updateHud();
    this.setMessage('New match — ' + this.restart!.baseMsg);
  }

  private get diff(): DiffParams {
    return DIFFS[this.settings.difficulty];
  }

  /** Applies the current settings: kits, fans, scoreboard colours, tactics and half length. */
  private applySettings(): void {
    const s = this.settings;
    setStyles(s.homeTeam, s.awayTeam);
    for (const p of this.players) p.kit = makeKit(p.side, p.role, p.number);
    this.recolorCrowd();
    this.sbTabH.setFillStyle(STYLE.home.jersey);
    this.sbTabA.setFillStyle(STYLE.away.jersey);
    this.sbHomeName.setColor(hex(STYLE.home.accent));
    this.sbAwayName.setColor(hex(STYLE.away.accent));
    this.tactics = { home: s.homeTactic, away: s.awayTactic };
    this.halfSeconds = HALF_OPTIONS[s.halfIdx];
    this.remaining = this.halfSeconds;
    this.updateTacticLabel();
    this.updateHud();
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
    if (this.clockEl) this.clockEl.textContent = formatClock(this.remaining);
    if (this.periodEl) {
      this.periodEl.textContent = this.half === 1 ? 'FIRST HALF' : this.half === 2 ? 'SECOND HALF' : 'EXTRA TIME';
    }
    if (this.statusEl && this.message) {
      this.statusEl.innerHTML = `<span class="status-icon">▶</span> ${this.message}`;
    }
    this.updateScoreboard();
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
  height: GAME_H,
  backgroundColor: '#0b0f15',
  antialias: false,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: FIELD_W, height: GAME_H },
  render: { pixelArt: true, roundPixels: true },
  scene: [RetroKickScene],
});

(window as Window & { retroKickGame?: Phaser.Game }).retroKickGame = game;
