import Phaser from 'phaser';
import './style.css';

// ═══════════════ CONSTANTS ═══════════════
const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_TIME_SECONDS = 60;
const CENTER_X = FIELD_W / 2;
const CENTER_Y = FIELD_H / 2;
const LINE = 19;                 // touchline / goal-line inset
const GOAL_HALF = 52;            // half goal mouth
const BOX_DEPTH = 137;           // penalty area depth from goal line
const BOX_HALF_H = 125;          // penalty area half-height
const PENALTY_SPOT_X = 112;      // distance of 1st penalty spot from edge
const SECOND_SPOT_X = 235;       // 10 m (second penalty) spot
const FOUL_LIMIT = 5;            // 6th+ accumulated foul -> 10 m free kick
const FOUR_SECONDS = 4;
const CONTACT_RADIUS = 15;

type TeamSide = 'home' | 'away';
type GameState = 'playing' | 'restart' | 'goal' | 'fulltime';
type RestartKind =
  | 'kickoff' | 'kick-in' | 'corner' | 'goal-clearance'
  | 'free-kick' | 'indirect-free-kick' | 'penalty' | 'second-penalty';

interface Pt { x: number; y: number }
interface RestartSpec { kind: RestartKind; team: TeamSide; x: number; y: number }
interface OutOfPlay { kind: 'goal' | 'kick-in' | 'corner' | 'goal-clearance'; team: TeamSide; x: number; y: number }

interface Footballer {
  sprite: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  head: Phaser.GameObjects.Arc;
  shorts: Phaser.GameObjects.Rectangle;
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
  tackling: number;
  facing: number;
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
  timer: number;        // seconds left (4 s rule, or 8 s auto-take for kick-off/penalties)
  cpuDelay: number;
  aim: number;
  power: number;
  charging: boolean;
  baseMsg: string;
}

// Per-restart parameters. indirect = cannot score until another player touches.
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

// ═══════════════ PURE RULE FUNCTIONS (no Phaser — unit-testable) ═══════════════
const other = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');
const teamName = (s: TeamSide): string => (s === 'home' ? 'Rockets' : 'Comets');
const dist = Phaser.Math.Distance.Between;
const clampPt = (x: number, y: number): Pt => ({
  x: Phaser.Math.Clamp(x, 31, FIELD_W - 31),
  y: Phaser.Math.Clamp(y, 31, FIELD_H - 31),
});

function cornerSpec(attacker: TeamSide, ballY: number): RestartSpec {
  return {
    kind: 'corner', team: attacker,
    x: attacker === 'home' ? FIELD_W - 22 : 22,           // home attacks right
    y: ballY < CENTER_Y ? 22 : FIELD_H - 22,
  };
}

function clearanceSpec(defender: TeamSide): RestartSpec {
  return { kind: 'goal-clearance', team: defender, x: defender === 'home' ? 55 : FIELD_W - 55, y: CENTER_Y };
}

/** Decides what happens when the ball is outside the lines. Home defends the LEFT goal. */
function decideOutOfPlay(x: number, y: number, lastTouch: TeamSide): OutOfPlay | null {
  const onLeft = x < LINE;
  const onRight = x > FIELD_W - LINE;
  if (onLeft || onRight) {
    const defender: TeamSide = onLeft ? 'home' : 'away';
    const attacker = other(defender);
    if (Math.abs(y - CENTER_Y) <= GOAL_HALF) return { kind: 'goal', team: attacker, x, y };
    if (lastTouch === defender) {                      // defender last touch -> corner
      const c = cornerSpec(attacker, y);
      return { kind: 'corner', team: attacker, x: c.x, y: c.y };
    }
    const g = clearanceSpec(defender);                 // attacker last touch -> GK clearance
    return { kind: 'goal-clearance', team: defender, x: g.x, y: g.y };
  }
  if (y < LINE || y > FIELD_H - LINE) {                // touchline -> kick-in to the other team
    return {
      kind: 'kick-in', team: other(lastTouch),
      x: Phaser.Math.Clamp(x, 40, FIELD_W - 40),
      y: y < LINE ? 24 : FIELD_H - 24,
    };
  }
  return null;
}

/** Foul -> restart for the FOULED team. foulNumber includes this foul. */
function decideFoul(fouler: TeamSide, victimX: number, victimY: number, foulNumber: number): RestartSpec {
  const fouled = other(fouler);
  const inOwnBox =
    (fouler === 'home' ? victimX < BOX_DEPTH : victimX > FIELD_W - BOX_DEPTH) &&
    Math.abs(victimY - CENTER_Y) < BOX_HALF_H;
  if (inOwnBox) {
    return { kind: 'penalty', team: fouled, x: fouled === 'home' ? FIELD_W - PENALTY_SPOT_X : PENALTY_SPOT_X, y: CENTER_Y };
  }
  if (foulNumber > FOUL_LIMIT) {
    // Foul spot farther from goal than the 10 m spot -> take it from the 10 m spot.
    const fartherThanSpot = fouler === 'home' ? victimX > SECOND_SPOT_X : victimX < FIELD_W - SECOND_SPOT_X;
    if (fartherThanSpot) {
      return { kind: 'second-penalty', team: fouled, x: fouled === 'home' ? FIELD_W - SECOND_SPOT_X : SECOND_SPOT_X, y: CENTER_Y };
    }
  }
  const p = clampPt(victimX, victimY);
  return { kind: 'free-kick', team: fouled, x: p.x, y: p.y };
}

/** Run with ?selftest in the URL — logs the Phase 1 acceptance tests to the console. */
function runPhase1SelfTests(): void {
  const results: [string, boolean][] = [];
  const t = (name: string, ok: boolean) => results.push([name, ok]);
  const a = decideOutOfPlay(450, 10, 'home');
  t('Home last touch over touchline -> AWAY kick-in', a?.kind === 'kick-in' && a.team === 'away');
  const b = decideOutOfPlay(450, 510, 'away');
  t('Away last touch over touchline -> HOME kick-in', b?.kind === 'kick-in' && b.team === 'home');
  const c = decideOutOfPlay(10, 100, 'home');
  t('Home defender last touch, own goal line -> AWAY corner (left, top)', c?.kind === 'corner' && c.team === 'away' && c.x < 100 && c.y < CENTER_Y);
  const d = decideOutOfPlay(10, 100, 'away');
  t('Away attacker last touch, home goal line -> HOME GK clearance', d?.kind === 'goal-clearance' && d.team === 'home');
  const e = decideOutOfPlay(890, 400, 'away');
  t('Away defender last touch, own goal line -> HOME corner (right, bottom)', e?.kind === 'corner' && e.team === 'home' && e.x > 800 && e.y > CENTER_Y);
  const f = decideOutOfPlay(890, 400, 'home');
  t('Home attacker last touch, away goal line -> AWAY GK clearance', f?.kind === 'goal-clearance' && f.team === 'away');
  t('Ball in left goal mouth -> goal for AWAY', decideOutOfPlay(10, 260, 'home')?.team === 'away');
  t('Ball in right goal mouth -> goal for HOME', decideOutOfPlay(890, 260, 'away')?.team === 'home');
  t('Ball in play -> no decision', decideOutOfPlay(450, 260, 'home') === null);
  const g = decideFoul('home', 500, 260, 1);
  t('Home foul midfield -> AWAY free kick', g.kind === 'free-kick' && g.team === 'away');
  const h = decideFoul('home', 60, 260, 1);
  t('Home foul in own box -> AWAY penalty', h.kind === 'penalty' && h.team === 'away' && h.x === PENALTY_SPOT_X);
  const i = decideFoul('away', 800, 260, 1);
  t('Away foul in own box -> HOME penalty', i.kind === 'penalty' && i.team === 'home' && i.x === FIELD_W - PENALTY_SPOT_X);
  const j = decideFoul('home', 500, 260, 6);
  t('6th accumulated foul -> 10m free kick to AWAY', j.kind === 'second-penalty' && j.team === 'away' && j.x === SECOND_SPOT_X);
  const k = decideFoul('away', 400, 260, 3);
  t('Away foul -> restart always for HOME (fouled team)', k.team === 'home');
  const failed = results.filter((r) => !r[1]);
  results.forEach(([n, ok]) => console.log(`${ok ? '✅' : '❌'} ${n}`));
  console.log(failed.length === 0 ? `PHASE 1 SELF-TEST: all ${results.length} passed` : `PHASE 1 SELF-TEST: ${failed.length} FAILED`);
}

// ═══════════════ SCENE ═══════════════
class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ball!: Phaser.GameObjects.Arc;
  private ballInner!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private ballHeight = 0;
  private ballVz = 0;
  private ballVx = 0;
  private ballVy = 0;
  private ballSpin = 0;
  private possession: TeamSide | null = 'home';
  private lastTouch: TeamSide = 'home';
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
  private goalScored = false; // prevents double-scoring
  private message = 'Ready for kick-off';
  private openingKickoff: TeamSide = 'home';

  // Phase 1 state
  private restart: Restart | null = null;
  private indirectPending: { team: TeamSide; taker: Footballer } | null = null;
  private foulCount: Record<TeamSide, number> = { home: 0, away: 0 };
  private gkHolder: Footballer | null = null;
  private gkHoldTimer = 0;
  private goalTimer?: Phaser.Time.TimerEvent;
  private restartLabel!: Phaser.GameObjects.Text;
  private aimGfx!: Phaser.GameObjects.Graphics;

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

    // Penalty spots + futsal 10 m (second penalty) spots
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

    // Restart UI: label + 4-second countdown above the ball, aim line + power bar
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

  private addPlayer(side: TeamSide, x: number, y: number, role: Footballer['role'], number: number): void {
    const isGK = role === 'GK';
    const bodyColor = isGK ? (side === 'home' ? 0x9b59b6 : 0xff9800) : side === 'home' ? 0x2d7fff : 0xff3b47;
    const shortsColor = isGK ? 0x333333 : side === 'home' ? 0x0a4fb5 : 0xb01822;
    const skinColor = 0xf4c892;

    const container = this.add.container(x, y).setDepth(20);
    const shadow = this.add
      .ellipse(x + 2, y + 10, isGK ? 22 : 20, isGK ? 10 : 9, 0x000000, 0.3)
      .setDepth(15);

    const shorts = this.add.rectangle(0, 6, isGK ? 14 : 12, 5, shortsColor).setOrigin(0.5);
    const body = this.add.circle(0, 0, isGK ? 11 : 10, bodyColor, 1).setStrokeStyle(2, 0xffffff);
    const head = this.add.circle(0, -8, 5, skinColor, 1).setStrokeStyle(1, 0x2a1810);
    const hair = this.add.arc(0, -10, 5, 180, 360, false, 0x3a2418);

    container.add([shorts, body, head, hair]);

    const label = this.add
      .text(0, 0, String(number), {
        fontFamily: 'Arial Black, sans-serif', fontSize: '9px', color: '#ffffff',
        stroke: '#000', strokeThickness: 2,
      })
      .setOrigin(0.5);
    container.add(label);

    this.players.push({
      sprite: container, body, head, shorts, shadow, label, side, role,
      homeX: x, homeY: y, vx: 0, vy: 0, number, cooldown: 0,
      celebrating: false, celebrateUntil: 0, tackling: 0,
      facing: side === 'home' ? 0 : Math.PI,
    });
  }

  private createBall(): void {
    this.ballShadow = this.add.ellipse(FIELD_W / 2 + 2, FIELD_H / 2 + 6, 14, 6, 0x000000, 0.4).setDepth(12);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 1).setStrokeStyle(1.5, 0x111111).setDepth(30);
    this.ballInner = this.add.circle(FIELD_W / 2, FIELD_H / 2, 2, 0x111111).setDepth(31);
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

    // Futsal stopped time: the clock only runs while the ball is live.
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
        this.updateBall(dt);
        this.updatePossession();
      }
    }
    // 'goal' and 'fulltime' only animate
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.syncBallVisuals();
  }

  private syncBallVisuals(): void {
    this.ballInner.setPosition(
      this.ball.x + Math.cos(this.ballSpin) * 2,
      this.ball.y - this.ballHeight + Math.sin(this.ballSpin) * 2
    );
    this.ball.setScale(1 + this.ballHeight * 0.01);
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
      .filter((p) => p.side === 'home' && p !== this.controlled && !p.celebrating)
      .forEach((p) => {
        if (p.role === 'GK') {
          this.steerTo(p, 67, Phaser.Math.Clamp(this.ball.y, FIELD_H / 2 - 36, FIELD_H / 2 + 36), 115, dt);
        } else {
          const supportX = p.homeX + Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.14, -45, 45);
          const supportY = p.homeY + Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.1, -35, 35);
          this.steerTo(p, supportX, supportY, 110, dt);
        }
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
      if (p.role === 'GK') {
        this.steerTo(p, FIELD_W - 67, Phaser.Math.Clamp(this.ball.y, FIELD_H / 2 - 36, FIELD_H / 2 + 36), 115, dt);
      } else if (p === nearest) {
        this.steerTo(p, this.ball.x + (this.ball.x < FIELD_W * 0.62 ? 8 : -12), this.ball.y, 150, dt);
        const d = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
        const ballSpeed = Math.hypot(this.ballVx, this.ballVy);
        if (d < 23 && this.possession !== 'away' && p.cooldown <= 0 && !this.gkHolder) {
          if (this.possession === 'home') {
            // One challenge attempt per 0.4 s. The CPU follows the same foul rules as the human.
            p.cooldown = 0.4;
            const roll = Phaser.Math.Between(0, 100);
            if (roll < 10) {
              this.awardFoul('away', this.ball.x, this.ball.y);
              return;
            }
            if (roll < 55) {
              p.tackling = 0.3;
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
          const angle = Math.atan2(FIELD_H / 2 - this.ball.y, 18 - this.ball.x);
          this.kickBall(Math.cos(angle) * 340, Math.sin(angle) * 340, carrier, 40);
          this.playSound('shoot');
          this.setMessage('Shot from Comets!');
        } else if (Phaser.Math.Between(0, 100) < 2) {
          const teammate = awayPlayers.find((p) => p !== carrier && p.role !== 'GK');
          if (teammate) {
            this.kickBall((teammate.sprite.x - this.ball.x) * 1.7, (teammate.sprite.y - this.ball.y) * 1.7, carrier, 15);
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
    p.shadow.setPosition(newX + 2, newY + 10);

    if (p.tackling > 0) {
      p.tackling -= dt;
      p.sprite.setRotation(p.facing + Math.PI / 4);
      p.sprite.setScale(1.1, 0.9);
    } else if (p.celebrating) {
      const bounce = Math.sin(this.time.now * 0.015) * 2;
      p.sprite.setY(newY + bounce);
    } else {
      p.sprite.setRotation(0);
      p.sprite.setScale(1, 1);
      if (Math.abs(p.vx) > 5 || Math.abs(p.vy) > 5) {
        p.sprite.setY(newY + Math.sin(this.time.now * 0.02) * 0.4);
      }
    }

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

  // ═══════════════ BALL PHYSICS & TOUCH TRACKING ═══════════════

  private updateBall(dt: number): void {
    // Keeper holding the ball: pin it to his hands
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

    if (this.checkBoundaries()) return;

    this.ball.x = Phaser.Math.Clamp(this.ball.x, 5, FIELD_W - 5);
    this.ball.y = Phaser.Math.Clamp(this.ball.y, 5, FIELD_H - 5);

    this.handleBallContacts();
  }

  /** Single entry point for out-of-play decisions (uses the pure rule function). */
  private checkBoundaries(): boolean {
    if (this.state !== 'playing' || this.goalScored || this.kickoffLock > 0) return false;
    const decision = decideOutOfPlay(this.ball.x, this.ball.y, this.lastTouch);
    if (!decision) return false;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    if (decision.kind === 'goal') {
      this.scoreGoal(decision.team);
    } else {
      this.startRestart({ kind: decision.kind, team: decision.team, x: decision.x, y: decision.y });
    }
    return true;
  }

  /** Every touch of the ball goes through here: keeps last-touch accurate and clears indirect restrictions. */
  private registerTouch(p: Footballer): void {
    this.lastTouch = p.side;
    if (this.indirectPending && p !== this.indirectPending.taker) this.indirectPending = null;
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
    let best: Footballer | null = null;
    let bestD = Infinity;
    for (const p of this.players) {
      if (p.celebrating || p.cooldown > 0) continue;
      const d = dist(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y);
      if (d < CONTACT_RADIUS && d < bestD) { best = p; bestD = d; }
    }
    if (!best) return;

    const speed = Math.hypot(this.ballVx, this.ballVy);
    const own = best.side === this.lastTouch;
    if (best.role === 'GK' && !own && speed > 150) {
      if (speed <= 300) { this.registerTouch(best); this.possession = best.side; this.gkCatch(best); }
      else this.deflect(best, speed, 0.35, true);
    } else if (own || speed < 150) {
      this.controlBall(best);                      // trap / receive a pass / loose ball
    } else if (speed < 260) {
      this.controlBall(best);                      // interception of a pass
      this.setMessage(`Intercepted by ${teamName(best.side)}`);
    } else {
      this.deflect(best, speed, 0.5, false);       // block / deflection
    }
  }

  private deflect(p: Footballer, speed: number, keep: number, save: boolean): void {
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
    this.setMessage(save ? '🧤 Parried!' : 'Blocked!');
  }

  // ─── Goalkeeper possession (4-second rule: keeper must release the ball) ───
  private gkCatch(gk: Footballer): void {
    this.gkHolder = gk;
    this.gkHoldTimer = 1.0 + Math.random() * 0.8;
    this.possession = gk.side;
    this.ballVx = 0; this.ballVy = 0;
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
    this.kickBall(Math.cos(ang) * speed, Math.sin(ang) * speed, gk, 25);
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

  /** Best-placed teammate (forward, unmarked, in range). Used by CPU restarts and keeper distribution. */
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
    this.kickBall(Math.cos(angle) * 260, Math.sin(angle) * 260, this.controlled, 10);
    this.playSound('pass');
    this.setMessage('→ Pass played');
  }

  private shootBall(): void {
    if (this.gkHolder) return;
    const d = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('⚠ Get closer to shoot');
      return;
    }
    const targetY = FIELD_H / 2 + Phaser.Math.Between(-30, 30);
    const angle = Math.atan2(targetY - this.ball.y, FIELD_W - 8 - this.ball.x);
    const power = this.ball.x > FIELD_W * 0.65 ? 430 : 350;
    this.kickBall(Math.cos(angle) * power, Math.sin(angle) * power, this.controlled, 50);
    this.playSound('shoot');
    this.setMessage('💥 SHOT!');
    this.cameraShake = 0.12;
  }

  private tackle(): void {
    if (this.gkHolder) { this.setMessage('Keeper has the ball'); return; }
    this.controlled.tackling = 0.3;
    const opponent = this.nearestPlayer('away', this.controlled.sprite.x, this.controlled.sprite.y);
    const d = dist(this.controlled.sprite.x, this.controlled.sprite.y, opponent.sprite.x, opponent.sprite.y);
    const ballDist = dist(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);

    this.playSound('tackle');
    this.spawnDustParticles(this.controlled.sprite.x, this.controlled.sprite.y + 8);

    if (ballDist < 35 && this.possession === 'away') {
      this.registerTouch(this.controlled);
      this.possession = 'home';
      this.selectControlled();
      this.ballVx *= -0.3;
      this.ballVy *= -0.3;
      this.setMessage('✓ Clean tackle!');
    } else if (d < 37) {
      if (Phaser.Math.Between(0, 100) < 35) {
        this.awardFoul('home', opponent.sprite.x, opponent.sprite.y);   // fouled team = away
      } else {
        this.setMessage('Challenge missed!');
      }
    } else {
      this.setMessage('Missed tackle');
    }
  }

  private kickBall(vx: number, vy: number, kicker: Footballer, lift = 10): void {
    this.gkHolder = null;
    this.ballVx = vx;
    this.ballVy = vy;
    this.ballVz = lift;
    this.possession = null;
    this.registerTouch(kicker);
    kicker.cooldown = 0.25;
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
      p.vx = 0; p.vy = 0; p.celebrating = false; p.tackling = 0; p.cooldown = 0;
      p.sprite.setRotation(0).setScale(1, 1);
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
    this.possession = spec.team;
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;
    this.ball.setPosition(spec.x, spec.y);

    const taker = this.pickTaker(spec);
    const r: Restart = {
      ...spec, taker, targets: new Map(), elapsed: 0, ready: false,
      timer: info.limit ?? 8, cpuDelay: Phaser.Math.FloatBetween(1.0, 2.4),
      aim: 0, power: 0, charging: false, baseMsg: '',
    };
    r.aim = this.defaultAim(r);
    r.baseMsg = `${info.label}: ${teamName(spec.team)}` + (spec.team === 'home' ? ' — aim with arrows, hold C, release to kick' : '');
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
      default: return { x: r.x - dirA * 13, y: r.y };   // behind the ball, facing the goal being attacked
    }
  }

  private defaultAim(r: RestartSpec): number {
    const dirA = r.team === 'home' ? 1 : -1;
    const goalX = dirA === 1 ? FIELD_W - 8 : 8;
    let tx = goalX; let ty = CENTER_Y;
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

  /** Futsal restart restrictions on the defending team's positions. */
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
      // opponents stay outside the clearing team's penalty area
      out.x = r.team === 'home' ? Math.max(out.x, BOX_DEPTH + 25) : Math.min(out.x, FIELD_W - BOX_DEPTH - 25);
      return clampPt(out.x, out.y);
    }
    const minDist = 110;                                   // ~5 m
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
      const gx = gk.side === 'home' ? 67 : FIELD_W - 67;
      const gy = penaltyLike && gk.side !== r.team ? CENTER_Y : Phaser.Math.Clamp(r.y, CENTER_Y - 36, CENTER_Y + 36);
      r.targets.set(gk, { x: gx, y: gy });
    });

    const field = others.filter((p) => p.role !== 'GK');
    if (penaltyLike) {
      // everyone except taker and keepers stands behind the ball (and outside the area)
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
      p.shadow.setPosition(t.x + 2, t.y + 10);
      p.vx = 0; p.vy = 0;
    });
  }

  private updateRestart(dt: number): void {
    const r = this.restart;
    if (!r) { this.state = 'playing'; return; }
    r.elapsed += dt;

    // hold the ball on its spot
    this.ball.setPosition(r.x, r.y);
    this.ballVx = 0; this.ballVy = 0; this.ballVz = 0; this.ballHeight = 0;

    // players walk to their positions
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
        this.snapToLayout(r);          // guarantees the distance/position rules at the moment of the restart
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
    if (this.restart !== r) return;     // restart was taken or replaced this frame

    if (r.timer <= 0) {
      if (info.limit !== null) this.fourSecondViolation(r);
      else this.takeRestart(r, r.aim, r.charging ? r.power : 0.7);   // kick-off / penalty auto-take
      return;
    }
    this.updateRestartLabel(r);
  }

  private updateRestartLabel(r: Restart): void {
    const info = RESTART_INFO[r.kind];
    const s = info.label + (r.ready && info.limit !== null ? ` · ${Math.ceil(Math.max(0, r.timer))}s` : '');
    if (this.restartLabel.text !== s) this.restartLabel.setText(s);
    this.restartLabel.setPosition(r.x, Math.max(16, r.y - 16));
  }

  private humanRestartInput(r: Restart, dt: number): void {
    const k = this.keys;
    const ax = Number(k.D.isDown || k.RIGHT.isDown) - Number(k.A.isDown || k.LEFT.isDown);
    const ay = Number(k.S.isDown || k.DOWN.isDown) - Number(k.W.isDown || k.UP.isDown);
    if (ax || ay) r.aim = Math.atan2(ay, ax);
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
    g.lineStyle(3, 0xffd23f, 0.9).lineBetween(r.x, r.y, ex, ey);
    g.fillStyle(0xffd23f, 1).fillCircle(ex, ey, 3);
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
      tx = goalX; ty = CENTER_Y + Phaser.Math.Between(-36, 36); shot = true;
    } else if (r.kind === 'corner') {
      tx = goalX - dirA * Phaser.Math.Between(90, 120); ty = CENTER_Y + Phaser.Math.Between(-45, 45);
    } else {
      const mate = this.findOpenTeammate(r.team, r.x, r.y, r.taker);
      if (mate) { tx = mate.sprite.x; ty = mate.sprite.y; }
      else { tx = r.x + dirA * 200; ty = CENTER_Y; }
    }
    const aim = Math.atan2(ty - r.y, tx - r.x);
    const speed = Phaser.Math.Clamp(Math.hypot(tx - r.x, ty - r.y) * 1.3, info.min, info.max);
    const power = shot ? Phaser.Math.FloatBetween(0.8, 1) : (speed - info.min) / (info.max - info.min);
    this.takeRestart(r, aim, power);
  }

  private takeRestart(r: Restart, aim: number, power: number): void {
    if (this.restart !== r) return;                    // prevents duplicate triggers
    const info = RESTART_INFO[r.kind];
    const speed = info.min + (info.max - info.min) * Phaser.Math.Clamp(power, 0, 1);
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    // kick-ins and corners must be played into the field
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

    this.restart = null;
    this.state = 'playing';
    this.kickoffLock = 0.25;
    this.restartLabel.setText('');
    this.aimGfx.clear();

    this.kickBall(vx, vy, r.taker, info.lift);
    r.taker.cooldown = 1.0;                            // taker may not touch it again until it has been played
    this.indirectPending = info.indirect ? { team: r.team, taker: r.taker } : null;

    if (r.kind === 'penalty' || r.kind === 'second-penalty') { this.playSound('shoot'); this.cameraShake = 0.2; }
    else this.playSound('kick');
    if (r.team === 'home') this.selectControlled();
    this.setMessage(`${info.label} taken — play on!`);
  }

  /** Four-second rule: the restart goes to the opponents in the futsal-correct form. */
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

    // A goal cannot be scored directly from an indirect restart (kick-in, clearance, indirect FK).
    if (this.indirectPending) {
      const pend = this.indirectPending;
      this.indirectPending = null;
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
    this.players.filter((p) => p.side === side).forEach((p) => {
      p.celebrating = true;
      p.celebrateUntil = now + 2500;
      p.vx = 0; p.vy = 0;
      this.tweens.add({ targets: p.sprite, y: p.sprite.y - 12, yoyo: true, repeat: 4, duration: 180, ease: 'Sine.easeInOut' });
    });

    this.setMessage(`⚽ GOAL! ${teamName(side)} score!`);

    this.goalTimer = this.time.delayedCall(2800, () => {
      this.goalScored = false;
      this.players.forEach((p) => { p.celebrating = false; });
      this.goalText.setAlpha(0);
      this.goalSubText.setAlpha(0);
      if (this.half === 3) { this.endMatch(); return; }     // golden goal in extra time
      this.startKickoff(other(side));                        // the team that conceded restarts
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
    this.players.filter((p) => p.side === 'home').forEach((p) => {
      p.body.setStrokeStyle(p === this.controlled ? 3 : 2, p === this.controlled ? 0xffd23f : 0xffffff);
    });
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

if (new URLSearchParams(window.location.search).has('selftest')) runPhase1SelfTests();

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
