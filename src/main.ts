import Phaser from 'phaser';
import './style.css';

/* ------------------------------------------------------------------ *
 *  RETRO KICK '97 — v2
 *  Better graphics, crowd + goal screams, celebrations, slide tackles
 *  & fouls, throw-ins, corners, goal kicks, free kicks, penalties,
 *  extra time and a penalty shoot-out.
 *
 *  Controls
 *   Move: WASD / arrows   Sprint: SHIFT   Pass: X   Shoot: Z (hold to charge)
 *   Slide tackle: SPACE   Switch player: X (when not on the ball)
 *   Set pieces: arrows aim, X pass/cross/throw, Z shoot/long
 *   Defending a penalty: ↑ / ↓ to dive      P pause · M mute
 * ------------------------------------------------------------------ */

const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_SECONDS = 45;
const EXTRA_TIME_ON_DRAW = true; // draw after 2 halves -> extra time -> shoot-out

const L = 19, R = FIELD_W - 19, T = 19, B = FIELD_H - 19, CY = FIELD_H / 2;
const GOAL_HALF = 52, BAR_H = 36, GRAVITY = 520;
const BOX_W = 118, BOX_TOP = 135, BOX_BOT = 385, SPOT_X = 112;
const SLIDE_TIME = 0.32;

type TeamSide = 'home' | 'away';
type Role = 'GK' | 'DEF' | 'MID' | 'FWD';
type PieceKind = 'throw' | 'corner' | 'goalkick' | 'freekick' | 'penalty';
type Mode = 'play' | 'setpiece' | 'celebrate' | 'ended';

const NAMES: Record<TeamSide, string> = { home: 'Rockets', away: 'Comets' };
const TEAM_HEX: Record<TeamSide, string> = { home: '#3aa9ff', away: '#ff5a5f' };

const clamp = Phaser.Math.Clamp;
const dirOf = (s: TeamSide): number => (s === 'home' ? 1 : -1);
const other = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');
const attackX = (s: TeamSide): number => (s === 'home' ? R : L);
const ownX = (s: TeamSide): number => (s === 'home' ? L : R);
const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const inBox = (defending: TeamSide, x: number, y: number): boolean =>
  y > BOX_TOP && y < BOX_BOT && (defending === 'home' ? x < L + BOX_W : x > R - BOX_W);

interface Footballer {
  side: TeamSide; role: Role; number: number;
  x: number; y: number; vx: number; vy: number; homeX: number; homeY: number;
  facing: number; run: number;
  cooldown: number; stun: number; slide: number; slideAng: number; slideCool: number; slideHit: boolean;
  think: number; diveT: number; diveTy: number;
  shadow: Phaser.GameObjects.Ellipse;
  body: Phaser.GameObjects.Container;
  feet: [Phaser.GameObjects.Arc, Phaser.GameObjects.Arc];
  tag: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Arc;
}

interface SetPiece {
  kind: PieceKind; side: TeamSide; x: number; y: number; taker: Footballer;
  timer: number; wait: number; ready: boolean; readyT: number;
  aimX: number; aimY: number; aimPx: number; prompted: boolean;
  targets: Map<Footballer, { x: number; y: number }>;
}
interface Celebration { side: TeamSide; scorer: Footballer; t: number; fx: number; fy: number; slid: boolean }
interface Confetti { x: number; y: number; vx: number; vy: number; w: number; h: number; c: number; life: number; ph: number }
interface Shootout { home: number; away: number; taken: Record<TeamSide, number>; hist: Record<TeamSide, string[]>; turn: TeamSide }

/* ============================== AUDIO ============================== */
class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private crowd!: GainNode;
  private muted = false;

  init(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 650; f.Q.value = 0.4;
      this.crowd = this.ctx.createGain();
      this.crowd.gain.value = 0.045;
      src.connect(f); f.connect(this.crowd); this.crowd.connect(this.master);
      src.start();
    } catch { this.ctx = null; }
  }
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
    if (this.muted) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
    return this.muted;
  }
  roar(level: number, secs: number): void {
    if (!this.ctx) return;
    const g = this.crowd.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.045 + level * 0.28, t + 0.3);
    g.linearRampToValueAtTime(0.045, t + secs);
  }
  tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  kick(power: number): void { this.tone(170, 55, 0.1, 'sine', 0.25 + power * 0.35); }
  thud(): void { this.tone(110, 40, 0.18, 'sine', 0.5); }
  post(): void { this.tone(900, 700, 0.35, 'triangle', 0.35); }
  save(): void { this.tone(260, 90, 0.12, 'square', 0.18); }
  whistle(long = false): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, dur = long ? 0.9 : 0.35;
    const o = this.ctx.createOscillator(), l = this.ctx.createOscillator();
    const lg = this.ctx.createGain(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 2900;
    l.frequency.value = 32; lg.gain.value = 140;
    l.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.setValueAtTime(0.22, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); l.start(t); o.stop(t + dur); l.stop(t + dur);
  }
  speak(text: string, rate: number, pitch: number): void {
    if (this.muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.pitch = pitch; u.volume = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* speech not available */ }
  }
}

/* ============================== SCENE ============================== */
class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ballC!: Phaser.GameObjects.Container;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private bx = FIELD_W / 2; private by = CY; private bz = 0;
  private bvx = 0; private bvy = 0; private bvz = 0; private spin = 0; private roll = 0;
  private carrier: Footballer | null = null;
  private lastTouch: Footballer | null = null;
  private controlled!: Footballer;
  private mode: Mode = 'play';
  private sp: SetPiece | null = null;
  private celeb: Celebration | null = null;
  private shootout: Shootout | null = null;
  private penTimer = -1;
  private penGoal = false;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private homeScore = 0; private awayScore = 0;
  private remaining = HALF_SECONDS; private clockAcc = 0; private half = 1;
  private paused = true; private pauseHeld = false; private muteHeld = false;
  private kickoffLock = 0; private switchT = 0; private trailT = 0;
  private charging = false; private charge = 0;
  private message = 'Ready for kick-off';
  private sfx = new Sfx();
  private fx!: Phaser.GameObjects.Graphics;
  private confettiG!: Phaser.GameObjects.Graphics;
  private crowdG!: Phaser.GameObjects.Graphics;
  private netL!: Phaser.GameObjects.Graphics;
  private netR!: Phaser.GameObjects.Graphics;
  private crowd: { x: number; y: number; c: number }[] = [];
  private excited = 0;
  private confetti: Confetti[] = [];
  private hint!: HTMLElement | null;
  private homeScoreEl!: HTMLElement | null;
  private awayScoreEl!: HTMLElement | null;
  private clockEl!: HTMLElement | null;
  private periodEl!: HTMLElement | null;
  private statusEl!: HTMLElement | null;

  constructor() { super('RetroKickScene'); }

  /* ----------------------------- setup ----------------------------- */
  create(): void {
    this.drawPitch();
    this.createCrowd();
    this.createTeams();
    this.createBall();
    this.fx = this.add.graphics().setDepth(40);
    this.confettiG = this.add.graphics().setDepth(60);
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,SPACE,SHIFT,P,M,ENTER') as Record<string, Phaser.Input.Keyboard.Key>;
    this.homeScoreEl = document.getElementById('home-score');
    this.awayScoreEl = document.getElementById('away-score');
    this.clockEl = document.getElementById('clock');
    this.periodEl = document.getElementById('period');
    this.statusEl = document.getElementById('status-message');
    this.hint = document.getElementById('canvas-hint');
    this.input.on('pointerdown', () => {
      this.sfx.init();
      if (this.mode === 'ended') { this.resetMatch(); return; }
      if (this.paused) {
        this.paused = false;
        this.sfx.whistle();
        this.sfx.roar(0.5, 2.5);
        if (this.hint) this.hint.style.display = 'none';
        this.setMessage('Play on!');
      }
    });
    document.getElementById('restart-button')?.addEventListener('click', () => { this.sfx.init(); this.resetMatch(); });
    this.time.addEvent({ delay: 120, loop: true, callback: () => this.redrawCrowd() });
    this.kickoff('home');
    this.setMessage('Ready for kick-off');
  }

  private drawPitch(): void {
    const g = this.add.graphics();
    g.fillStyle(0x0d3626, 1).fillRect(0, 0, FIELD_W, FIELD_H);
    const stripes = 14, sw = (R - L) / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle(i % 2 ? 0x22804f : 0x1b6849, 1).fillRect(L + i * sw, T, sw + 1, B - T);
    }
    // faint grass noise
    g.fillStyle(0xffffff, 0.04);
    for (let i = 0; i < 260; i++) g.fillRect(rand(L, R), rand(T, B), 2, 1);
    g.lineStyle(3, 0xeaf6df, 0.92);
    g.strokeRect(L, T, R - L, B - T);
    g.lineBetween(FIELD_W / 2, T, FIELD_W / 2, B);
    g.strokeCircle(FIELD_W / 2, CY, 67);
    g.fillStyle(0xeaf6df, 1).fillCircle(FIELD_W / 2, CY, 4);
    g.strokeRect(L, BOX_TOP, BOX_W, BOX_BOT - BOX_TOP);
    g.strokeRect(L, 190, 49, 140);
    g.strokeRect(R - BOX_W, BOX_TOP, BOX_W, BOX_BOT - BOX_TOP);
    g.strokeRect(R - 49, 190, 49, 140);
    g.fillCircle(SPOT_X, CY, 3).fillCircle(FIELD_W - SPOT_X, CY, 3);
    const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
      g.beginPath(); g.arc(cx, cy, r, a0, a1); g.strokePath();
    };
    arc(SPOT_X, CY, 67, -1.19, 1.19);
    arc(FIELD_W - SPOT_X, CY, 67, Math.PI - 1.19, Math.PI + 1.19);
    arc(L, T, 12, 0, Math.PI / 2); arc(R, T, 12, Math.PI / 2, Math.PI);
    arc(L, B, 12, -Math.PI / 2, 0); arc(R, B, 12, Math.PI, Math.PI * 1.5);
    // goals
    this.netL = this.add.graphics(); this.netR = this.add.graphics();
    this.drawNet(this.netL, true); this.drawNet(this.netR, false);
    g.fillStyle(0xffffff, 1);
    [L, R].forEach(x => [CY - GOAL_HALF, CY + GOAL_HALF].forEach(y => g.fillCircle(x, y, 4)));
    // corner flags
    [[L, T], [R, T], [L, B], [R, B]].forEach(([x, y]) => {
      const sx = x < FIELD_W / 2 ? 1 : -1, sy = y < CY ? 1 : -1;
      g.lineStyle(2, 0xffffff, 1).lineBetween(x, y, x + sx * 2, y + sy * 12);
      g.fillStyle(0xffd166, 1).fillTriangle(x, y, x + sx * 10, y + sy * 3, x, y + sy * 7);
    });
  }

  private drawNet(g: Phaser.GameObjects.Graphics, left: boolean): void {
    const x0 = left ? 0 : R;
    g.fillStyle(0x0a2219, 1).fillRect(x0, CY - GOAL_HALF, L, GOAL_HALF * 2);
    g.lineStyle(1, 0xffffff, 0.45);
    for (let y = CY - GOAL_HALF; y <= CY + GOAL_HALF; y += 8) g.lineBetween(x0, y, x0 + L, y);
    for (let x = x0; x <= x0 + L; x += 6) g.lineBetween(x, CY - GOAL_HALF, x, CY + GOAL_HALF);
  }

  private createCrowd(): void {
    const cols = [0xff5a5f, 0x3aa9ff, 0xf4d06f, 0xffffff, 0x9be564, 0xc77dff];
    const add = (x: number, y: number) => this.crowd.push({ x, y, c: cols[Math.floor(Math.random() * cols.length)] });
    for (let i = 0; i < 230; i++) { add(rand(2, FIELD_W - 4), rand(2, T - 4)); add(rand(2, FIELD_W - 4), rand(B + 2, FIELD_H - 4)); }
    for (let i = 0; i < 70; i++) {
      [rand(2, L - 4), rand(R + 2, FIELD_W - 4)].forEach(x => {
        let y = rand(T, B);
        if (Math.abs(y - CY) < GOAL_HALF + 4) y = y < CY ? y - 60 : y + 60;
        add(x, y);
      });
    }
    this.crowdG = this.add.graphics().setDepth(2);
  }

  private redrawCrowd(): void {
    const g = this.crowdG; g.clear();
    this.crowd.forEach(d => {
      const j = this.excited > 0 ? rand(-2, 2) : 0;
      g.fillStyle(d.c, this.excited > 0 ? 1 : 0.8).fillRect(d.x, d.y + j, 3, 3);
    });
  }

  private createTeams(): void {
    const home = [[40, CY, 'GK'], [250, 145, 'DEF'], [250, 375, 'DEF'], [390, 205, 'MID'], [390, 315, 'MID'], [490, 155, 'FWD'], [490, 365, 'FWD']] as const;
    const away = [[FIELD_W - 40, CY, 'GK'], [650, 145, 'DEF'], [650, 375, 'DEF'], [510, 205, 'MID'], [510, 315, 'MID'], [410, 155, 'FWD'], [410, 365, 'FWD']] as const;
    home.forEach((p, i) => this.addPlayer('home', p[0], p[1], p[2], i + 1));
    away.forEach((p, i) => this.addPlayer('away', p[0], p[1], p[2], i + 1));
  }

  private addPlayer(side: TeamSide, x: number, y: number, role: Role, number: number): void {
    const kit = role === 'GK' ? (side === 'home' ? 0xf4d06f : 0x9be564) : (side === 'home' ? 0x3aa9ff : 0xff5a5f);
    const shadow = this.add.ellipse(x + 3, y + 6, 26, 14, 0x041510, 0.35).setDepth(1);
    const f1 = this.add.circle(0, -6, 3.4, 0x14110f, 1);
    const f2 = this.add.circle(0, 6, 3.4, 0x14110f, 1);
    const torso = this.add.ellipse(0, 0, 13, 22, kit, 1).setStrokeStyle(2, 0xf7f3df, 1);
    const stripe = this.add.rectangle(0, 0, 3, 20, 0xffffff, 0.55);
    const head = this.add.circle(2, 0, 5.4, 0xe0b48a, 1).setStrokeStyle(1, 0x3a2a1c, 1);
    const hair = this.add.circle(0.5, 0, 4.4, role === 'GK' ? 0x222222 : 0x2b1b12, 1);
    const body = this.add.container(x, y, [f1, f2, torso, stripe, hair, head]).setDepth(5);
    const tag = this.add.text(x, y - 19, String(number), {
      fontFamily: 'Arial, sans-serif', fontSize: '9px', color: '#ffffff', fontStyle: 'bold', stroke: '#0a1f16', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(30);
    const ring = this.add.circle(x, y, 17).setStrokeStyle(2, 0xffe07a, 1).setDepth(4).setVisible(false);
    this.players.push({
      side, role, number, x, y, vx: 0, vy: 0, homeX: x, homeY: y, facing: side === 'home' ? 0 : Math.PI, run: Math.random() * 6,
      cooldown: 0, stun: 0, slide: 0, slideAng: 0, slideCool: 0, slideHit: false, think: 0, diveT: 0, diveTy: y,
      shadow, body, feet: [f1, f2], tag, ring,
    });
  }

  private createBall(): void {
    this.ballShadow = this.add.ellipse(0, 0, 14, 8, 0x041510, 0.4).setDepth(10);
    const base = this.add.circle(0, 0, 6.5, 0xf8f7ed, 1).setStrokeStyle(1.5, 0x17211e, 1);
    const dots = [[0, 0, 2.4], [-4, -3, 1.6], [4, -3, 1.6], [0, 5, 1.6]].map(d => this.add.circle(d[0], d[1], d[2], 0x17211e, 1));
    this.ballC = this.add.container(0, 0, [base, ...dots]).setDepth(11);
  }

  /* ------------------------------ loop ----------------------------- */
  update(_time: number, delta: number): void {
    if (this.keys.P.isDown && !this.pauseHeld) {
      this.pauseHeld = true;
      if (this.mode !== 'ended') { this.paused = !this.paused; this.setMessage(this.paused ? 'Paused — press P to resume' : 'Play on!'); }
    }
    if (this.keys.P.isUp) this.pauseHeld = false;
    if (this.keys.M.isDown && !this.muteHeld) { this.muteHeld = true; this.setMessage(this.sfx.toggleMute() ? 'Sound off' : 'Sound on'); }
    if (this.keys.M.isUp) this.muteHeld = false;
    if (this.keys.ENTER.isDown && this.mode === 'ended') this.resetMatch();
    this.drawBall();
    this.players.forEach(p => this.renderPlayer(p));
    if (this.paused || this.mode === 'ended') { this.drawFx(); return; }

    const dt = Math.min(delta / 1000, 0.035);
    this.excited = Math.max(0, this.excited - dt);
    if (this.mode !== 'celebrate' && !this.shootout) this.tickClock(dt);

    if (this.mode === 'play') this.updatePlay(dt);
    else if (this.mode === 'setpiece') this.updateSetPiece(dt);
    else if (this.mode === 'celebrate') this.updateCelebrate(dt);

    this.updateConfetti(dt);
    this.drawFx();
    this.updateHud();
  }

  private tickClock(dt: number): void {
    this.clockAcc += dt;
    if (this.clockAcc < 1) return;
    this.clockAcc -= 1;
    this.remaining = Math.max(0, this.remaining - 1);
    if (this.remaining === 0) this.endPeriod();
  }

  private endPeriod(): void {
    this.sfx.whistle(true);
    if (this.half === 1) {
      this.half = 2; this.remaining = HALF_SECONDS;
      this.banner('HALF-TIME', '#ffe07a'); this.kickoff('away');
    } else if (this.half === 2) {
      if (this.homeScore === this.awayScore && EXTRA_TIME_ON_DRAW) {
        this.half = 3; this.remaining = EXTRA_SECONDS;
        this.banner('EXTRA TIME', '#ffe07a', 'Level after 90 — 2 × 45s to find a winner'); this.kickoff('home');
      } else this.endMatch(this.homeScore === this.awayScore ? null : this.homeScore > this.awayScore ? 'home' : 'away');
    } else if (this.half === 3) {
      this.half = 4; this.remaining = EXTRA_SECONDS;
      this.banner('EXTRA TIME', '#ffe07a', 'Second period'); this.kickoff('away');
    } else {
      if (this.homeScore === this.awayScore) this.startShootout();
      else this.endMatch(this.homeScore > this.awayScore ? 'home' : 'away');
    }
  }

  private endMatch(winner: TeamSide | null, pens = false): void {
    this.mode = 'ended'; this.sp = null;
    this.sfx.whistle(true);
    const txt = winner ? `Full-time — ${NAMES[winner]} win${pens ? ' on penalties' : ''}!` : 'Full-time — it ends level!';
    this.setMessage(txt);
    if (winner) { this.excited = 8; this.sfx.roar(1, 6); this.burstConfetti(FIELD_W / 2, CY, winner, 140); }
    this.banner(winner ? `${NAMES[winner].toUpperCase()} WIN!` : 'DRAW', winner ? TEAM_HEX[winner] : '#ffffff');
    if (this.hint) { this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN'; this.hint.style.display = 'block'; }
  }

  /* --------------------------- open play --------------------------- */
  private updatePlay(dt: number): void {
    if (this.kickoffLock > 0) {
      this.kickoffLock -= dt;
      this.players.forEach(p => { p.vx = 0; p.vy = 0; this.moveP(p, dt); });
      this.updateBall(dt);
      return;
    }
    if (!this.shootout) this.updateUser(dt);
    this.updateAI(dt);
    this.updateTackles();
    this.updateBall(dt);
    this.resolveTouches();
    this.separate();
    if (this.mode === 'play') this.checkBounds();
    if (this.shootout && this.penTimer >= 0 && this.mode === 'play') {
      this.penTimer -= dt;
      if (this.penTimer < 0) { this.penTimer = -1; this.resolvePenalty(); }
    }
  }

  private updateUser(dt: number): void {
    const c = this.controlled;
    const k = this.keys;
    const left = k.A.isDown || k.LEFT.isDown, right = k.D.isDown || k.RIGHT.isDown;
    const up = k.W.isDown || k.UP.isDown, down = k.S.isDown || k.DOWN.isDown;
    let dx = Number(right) - Number(left), dy = Number(down) - Number(up);
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const holding = this.carrier === c;
    const speed = k.SHIFT.isDown ? (holding ? 225 : 245) : (holding ? 170 : 185);
    c.vx = dx * speed; c.vy = dy * speed;
    this.moveP(c, dt);

    // auto-switch to the closest defender
    this.switchT -= dt;
    if (this.switchT <= 0 && (!this.carrier || this.carrier.side === 'away')) {
      this.switchT = 0.25;
      const n = this.nearestOutfield('home', this.bx, this.by);
      if (n !== c && dist(n.x, n.y, this.bx, this.by) + 30 < dist(c.x, c.y, this.bx, this.by)) this.selectControlled(n);
    }

    if (Phaser.Input.Keyboard.JustDown(k.X)) {
      if (holding) this.passBall();
      else this.selectControlled();
    }
    if (Phaser.Input.Keyboard.JustDown(k.Z)) {
      const canKick = holding || (!this.carrier && dist(c.x, c.y, this.bx, this.by) < 28 && this.bz < 22);
      if (canKick) { this.charging = true; this.charge = 0; } else this.setMessage('Get on the ball to shoot');
    }
    if (this.charging) {
      this.charge = Math.min(1, this.charge + dt / 0.8);
      if (Phaser.Input.Keyboard.JustUp(k.Z)) { this.charging = false; this.shootBall(this.charge, dy); }
    }
    if (Phaser.Input.Keyboard.JustDown(k.SPACE)) {
      if (holding) this.setMessage('X pass · Z shoot');
      else this.startSlide(c);
    }
  }

  private passBall(): void {
    const c = this.controlled, k = this.keys;
    const ax = Number(k.D.isDown || k.RIGHT.isDown) - Number(k.A.isDown || k.LEFT.isDown);
    const ay = Number(k.S.isDown || k.DOWN.isDown) - Number(k.W.isDown || k.UP.isDown);
    const ang = ax || ay ? Math.atan2(ay, ax) : c.facing;
    const mates = this.players.filter(p => p.side === 'home' && p !== c && p.role !== 'GK');
    const scored = mates.map(m => {
      const a = Math.atan2(m.y - c.y, m.x - c.x), d = dist(m.x, m.y, c.x, c.y);
      return { m, d, score: -Math.abs(Phaser.Math.Angle.Wrap(a - ang)) * 1.3 - d / 320 };
    }).sort((a, b) => b.score - a.score);
    const t = scored[0]; if (!t) return;
    this.passTo(c, t.m);
    this.setMessage('Pass played');
  }

  private passTo(from: Footballer, to: Footballer): void {
    const tx = to.x + to.vx * 0.3, ty = to.y + to.vy * 0.3;
    const d = dist(from.x, from.y, tx, ty), a = Math.atan2(ty - from.y, tx - from.x);
    const v = clamp(d * 1.1 + 70, 150, 340);
    this.kickBall(from, Math.cos(a) * v, Math.sin(a) * v);
  }

  private shootBall(charge: number, aimDir: number): void {
    const c = this.controlled, gx = attackX('home');
    const ty = CY + aimDir * 38;
    const far = dist(c.x, c.y, gx, CY);
    const err = (Math.random() - 0.5) * (0.07 + charge * 0.08 + far / 4500);
    const a = Math.atan2(ty - this.by, gx - this.bx) + err;
    const power = 300 + charge * 190;
    const vz = charge > 0.4 ? 40 + charge * 110 : 0;
    this.kickBall(c, Math.cos(a) * power, Math.sin(a) * power, vz);
    this.setMessage(charge > 0.8 ? 'POWER SHOT!' : 'SHOT!');
  }

  private kickBall(p: Footballer, vx: number, vy: number, vz = 0, spin = 0): void {
    this.carrier = null;
    this.bvx = vx; this.bvy = vy; this.bvz = vz; this.spin = spin;
    if (vz > 0 && this.bz < 0.5) this.bz = 0.6;
    this.lastTouch = p; p.cooldown = 0.35;
    this.sfx.kick(Math.min(1, Math.hypot(vx, vy) / 450));
  }

  /* ------------------------------ AI ------------------------------- */
  private updateAI(dt: number): void {
    const pressers: Record<TeamSide, Footballer | null> = {
      home: this.nearestFree('home'), away: this.nearestFree('away'),
    };
    const target = this.ballTarget();
    for (const p of this.players) {
      if (p === this.controlled && !this.shootout) continue;
      if (this.shootout) {
        if (p.role === 'GK') this.updateGK(p, dt); else { p.vx = 0; p.vy = 0; this.moveP(p, dt); }
        continue;
      }
      if (p.role === 'GK') { this.updateGK(p, dt); continue; }
      const side = p.side, dir = dirOf(side);
      const hasBall = this.carrier?.side === side;
      if (this.carrier === p) { this.carrierAI(p, dt); continue; }
      if (!hasBall && pressers[side] === p) {
        const c = this.carrier;
        const tx = c ? c.x + c.vx * 0.2 : target.x, ty = c ? c.y + c.vy * 0.2 : target.y;
        this.steerTo(p, tx, ty, side === 'away' ? 150 : 145, dt);
        if (c && c.side !== side && p.slide <= 0 && p.stun <= 0) {
          const d = dist(p.x, p.y, c.x, c.y);
          if (d < 17 && Math.random() < dt * 0.8) this.dispossess(p, c);
          else if (d < 38 && p.slideCool <= 0 && Math.random() < dt * (side === 'away' ? 1.0 : 0.6)) {
            p.facing = Math.atan2(c.y - p.y, c.x - p.x); this.startSlide(p);
          }
        }
      } else if (hasBall) {
        const adv = p.role === 'FWD' ? 70 : p.role === 'MID' ? 30 : -10;
        this.steerTo(p, clamp(p.homeX + dir * adv + (this.bx - FIELD_W / 2) * 0.35, L + 30, R - 30),
          p.homeY + clamp((this.by - CY) * 0.15, -35, 35), 115, dt);
      } else {
        this.steerTo(p, p.homeX + clamp((this.bx - FIELD_W / 2) * 0.22, -70, 70),
          p.homeY + clamp((this.by - CY) * 0.14, -40, 40), 95, dt);
      }
    }
  }

  private ballTarget(): { x: number; y: number } {
    if (this.bz > 6 || this.bvz > 0) {
      const tl = (this.bvz + Math.sqrt(this.bvz * this.bvz + 2 * GRAVITY * this.bz)) / GRAVITY;
      return { x: clamp(this.bx + this.bvx * tl, L, R), y: clamp(this.by + this.bvy * tl, T, B) };
    }
    return { x: this.bx + this.bvx * 0.25, y: this.by + this.bvy * 0.25 };
  }

  private carrierAI(p: Footballer, dt: number): void {
    p.think -= dt;
    const gx = attackX(p.side), dir = dirOf(p.side);
    const toGoal = dist(p.x, p.y, gx, CY);
    let near: Footballer | null = null, nd = 999;
    for (const o of this.players) {
      if (o.side === p.side) continue;
      const d = dist(o.x, o.y, p.x, p.y);
      if (d < nd) { nd = d; near = o; }
    }
    if (p.think <= 0) {
      p.think = 0.25;
      if (toGoal < 270 && Math.abs(p.y - CY) < 175 && Math.random() < 0.4) {
        const ty = CY + rand(-38, 38), a = Math.atan2(ty - p.y, gx - p.x);
        const v = rand(350, 420);
        this.kickBall(p, Math.cos(a) * v, Math.sin(a) * v, Math.random() < 0.2 ? 90 : 0);
        p.think = 0.8; return;
      }
      if (nd < 46 && Math.random() < 0.55) {
        const mates = this.players.filter(m => m.side === p.side && m !== p && m.role !== 'GK');
        let best: Footballer | null = null, bs = -1e9;
        for (const m of mates) {
          const d = dist(m.x, m.y, p.x, p.y);
          if (d < 40 || d > 340) continue;
          let open = 999;
          this.players.forEach(o => { if (o.side !== p.side) open = Math.min(open, dist(o.x, o.y, m.x, m.y)); });
          const s = dir * (m.x - p.x) * 0.6 + open * 0.9 - d * 0.15;
          if (s > bs) { bs = s; best = m; }
        }
        if (best) { this.passTo(p, best); p.think = 0.6; return; }
      }
    }
    let tx = gx - dir * 30, ty = CY;
    if (near && nd < 70) {
      const away = Math.atan2(p.y - near.y, p.x - near.x);
      tx = p.x + dir * 60 + Math.cos(away) * 40; ty = p.y + Math.sin(away) * 60;
    }
    this.steerTo(p, tx, ty, 128, dt);
  }

  private updateGK(p: Footballer, dt: number): void {
    const side = p.side, line = ownX(side) + dirOf(side) * 22;
    if (this.carrier === p) {
      p.think -= dt; p.vx = 0; p.vy = 0; this.moveP(p, dt);
      if (p.think <= 0) this.gkDistribute(p);
      return;
    }
    if (p.diveT > 0) { p.diveT -= dt; this.steerTo(p, p.x, p.diveTy, 330, dt); return; }
    if (this.shootout) { this.steerTo(p, line - dirOf(side) * 14, CY, 120, dt); return; }
    const speed = Math.hypot(this.bvx, this.bvy);
    const toward = side === 'home' ? this.bvx < -60 : this.bvx > 60;
    if (toward && !this.carrier && speed > 230) {
      const t = (line - this.bx) / this.bvx;
      if (t > 0 && t < 0.7) {
        const py = this.by + this.bvy * t;
        if (Math.abs(py - CY) < GOAL_HALF + 10 && Math.abs(py - p.y) > 12) {
          p.diveT = 0.45; p.diveTy = py + rand(-14, 14); return;
        }
      }
    }
    const nearBall = dist(this.bx, this.by, line, CY) < 150;
    const loose = !this.carrier && inBox(side, this.bx, this.by) && speed < 130 && this.nearestFree(side) === null;
    if (loose) { this.steerTo(p, this.bx, this.by, 150, dt); return; }
    this.steerTo(p, line + dirOf(side) * (nearBall ? 18 : 0), CY + clamp((this.by - CY) * 0.28, -40, 40), 140, dt);
  }

  private gkDistribute(p: Footballer): void {
    const dir = dirOf(p.side);
    const mates = this.players.filter(m => m.side === p.side && m.role !== 'GK');
    mates.sort((a, b) => dir * (b.x - a.x));
    const m = mates[Math.floor(rand(0, 2))] ?? mates[0];
    const d = dist(p.x, p.y, m.x, m.y), a = Math.atan2(m.y - p.y, m.x - p.x);
    const v = clamp(d / 0.7, 200, 420);
    this.kickBall(p, Math.cos(a) * v, Math.sin(a) * v, GRAVITY * 0.35);
  }

  private nearestFree(side: TeamSide): Footballer | null {
    let best: Footballer | null = null, bd = 1e9;
    const t = this.ballTarget();
    for (const p of this.players) {
      if (p.side !== side || p.role === 'GK' || p === this.controlled || p.stun > 0) continue;
      const d = dist(p.x, p.y, t.x, t.y);
      if (d < bd) { bd = d; best = p; }
    }
    // keepers only count when nobody else exists (used for loose-ball checks)
    return best && bd < 90 && this.carrier === null && inBox(side, this.bx, this.by) ? null : best;
  }

  private nearestOutfield(side: TeamSide, x: number, y: number): Footballer {
    return this.players.filter(p => p.side === side && p.role !== 'GK')
      .reduce((b, p) => (dist(p.x, p.y, x, y) < dist(b.x, b.y, x, y) ? p : b));
  }

  private gkOf(side: TeamSide): Footballer { return this.players.find(p => p.side === side && p.role === 'GK')!; }

  /* ----------------------------- movement -------------------------- */
  private moveP(p: Footballer, dt: number): void {
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.slideCool = Math.max(0, p.slideCool - dt);
    if (p.stun > 0) { p.stun -= dt; p.vx = 0; p.vy = 0; return; }
    if (p.slide > 0) {
      p.slide -= dt;
      const k = Math.max(0, p.slide / SLIDE_TIME), sp = 60 + 300 * k;
      p.x += Math.cos(p.slideAng) * sp * dt; p.y += Math.sin(p.slideAng) * sp * dt;
      p.facing = p.slideAng;
      if (p.slide <= 0) { p.slide = 0; if (!p.slideHit) p.stun = 0.45; p.slideHit = false; }
      this.clampP(p); return;
    }
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 8) {
      p.facing += Phaser.Math.Angle.Wrap(Math.atan2(p.vy, p.vx) - p.facing) * Math.min(1, dt * 14);
      p.run += speed * dt * 0.09;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    this.clampP(p);
  }

  private clampP(p: Footballer): void { p.x = clamp(p.x, L + 6, R - 6); p.y = clamp(p.y, T + 6, B - 6); }

  private steerTo(p: Footballer, x: number, y: number, speed: number, dt: number): void {
    const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
    if (d > 3) { const s = Math.min(speed, d * 3); p.vx = (dx / d) * s; p.vy = (dy / d) * s; }
    else {
      p.vx = 0; p.vy = 0;
      p.facing += Phaser.Math.Angle.Wrap(Math.atan2(this.by - p.y, this.bx - p.x) - p.facing) * Math.min(1, dt * 8);
    }
    this.moveP(p, dt);
  }

  private separate(): void {
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i], b = this.players[j];
        if (a.slide > 0 || b.slide > 0 || a.stun > 0 || b.stun > 0) continue;
        const d = dist(a.x, a.y, b.x, b.y);
        if (d > 0.01 && d < 15) {
          const push = (15 - d) / 2, nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
          a.x += nx * push; a.y += ny * push; b.x -= nx * push; b.y -= ny * push;
        }
      }
    }
  }

  /* ----------------------------- tackles --------------------------- */
  private startSlide(p: Footballer): void {
    if (p.slideCool > 0 || p.slide > 0 || p.stun > 0 || p.role === 'GK') return;
    p.slide = SLIDE_TIME; p.slideAng = p.facing; p.slideCool = 1.0; p.slideHit = false;
    this.sfx.tone(500, 160, 0.2, 'sawtooth', 0.06);
  }

  private updateTackles(): void {
    for (const p of this.players) {
      if (p.slide <= 0 || p.slideHit) continue;
      const c = this.carrier;
      if (c && c.side !== p.side && c.stun <= 0 && dist(p.x, p.y, c.x, c.y) < 21) { this.resolveTackle(p, c); continue; }
      if (!c && this.bz < 10 && dist(p.x, p.y, this.bx, this.by) < 18) {
        p.slideHit = true; this.lastTouch = p;
        this.bvx = Math.cos(p.slideAng) * 220; this.bvy = Math.sin(p.slideAng) * 220;
        this.sfx.kick(0.5); continue;
      }
      for (const q of this.players) {
        if (q.side === p.side || q.role === 'GK' || q === c || q.stun > 0 || q.slide > 0) continue;
        if (dist(p.x, p.y, q.x, q.y) < 14) {
          p.slideHit = true;
          if (Math.random() < 0.45) this.foul(p, q);
          break;
        }
      }
    }
  }

  private resolveTackle(p: Footballer, c: Footballer): void {
    p.slideHit = true;
    const behind = Math.abs(Phaser.Math.Angle.Wrap(p.slideAng - c.facing)) < 0.9;
    const moving = Math.hypot(c.vx, c.vy) > 40;
    const foulP = behind ? (moving ? 0.62 : 0.35) : 0.12;
    if (Math.random() < foulP) { this.foul(p, c); return; }
    c.stun = 0.9; this.carrier = null; this.lastTouch = p;
    this.bvx = Math.cos(p.slideAng) * 170; this.bvy = Math.sin(p.slideAng) * 170;
    this.sfx.thud(); this.popup('TACKLE!', c.x, c.y - 24, '#ffffff');
    this.cameras.main.shake(90, 0.003);
    this.setMessage(`Clean tackle by #${p.number}!`);
  }

  private dispossess(p: Footballer, c: Footballer): void {
    this.lastTouch = p; this.carrier = null;
    const a = Math.atan2(c.y - p.y, c.x - p.x) + Math.PI * 0 + rand(-0.6, 0.6);
    this.bvx = Math.cos(a) * -140; this.bvy = Math.sin(a) * -140;
    c.cooldown = 0.5; p.cooldown = 0; this.sfx.kick(0.3);
  }

  private foul(p: Footballer, victim: Footballer): void {
    this.sfx.whistle();
    p.slide = 0; victim.stun = 0.8;
    const yellow = Math.random() < 0.3;
    this.banner('FOUL!', '#ffe07a', yellow ? `Yellow card · #${p.number} ${NAMES[p.side]}` : undefined, 900);
    if (yellow) this.popup('🟨', p.x, p.y - 28, '#ffe07a');
    this.sfx.roar(0.35, 1.5);
    if (inBox(p.side, victim.x, victim.y)) {
      this.setMessage('PENALTY!');
      this.startSetPiece('penalty', victim.side, victim.side === 'home' ? R - SPOT_X : L + SPOT_X, CY);
    } else {
      this.setMessage(`Free kick to ${NAMES[victim.side]}`);
      this.startSetPiece('freekick', victim.side, victim.x, victim.y);
    }
  }

  /* ------------------------------ ball ----------------------------- */
  private updateBall(dt: number): void {
    const c = this.carrier;
    if (c) {
      if (c.stun > 0 || c.slide > 0) {
        this.carrier = null; this.bvx = c.vx; this.bvy = c.vy;
      } else {
        const off = c.role === 'GK' ? 11 : 13;
        const tx = c.x + Math.cos(c.facing) * off, ty = c.y + Math.sin(c.facing) * off;
        const k = Math.min(1, dt * 28);
        this.bx += (tx - this.bx) * k; this.by += (ty - this.by) * k;
        this.bz = 0; this.bvz = 0; this.spin = 0; this.bvx = c.vx; this.bvy = c.vy;
        this.bx = clamp(this.bx, L + 3, R - 3); this.by = clamp(this.by, T + 3, B - 3);
        this.roll += Math.hypot(c.vx, c.vy) * dt * 0.12;
        return;
      }
    }
    if (this.mode === 'setpiece') return;
    this.bx += this.bvx * dt; this.by += this.bvy * dt;
    if (this.bz > 0 || this.bvz > 0) {
      this.bvz -= GRAVITY * dt; this.bz += this.bvz * dt;
      if (this.spin) {
        const a = this.spin * dt, cs = Math.cos(a), sn = Math.sin(a);
        const nx = this.bvx * cs - this.bvy * sn, ny = this.bvx * sn + this.bvy * cs;
        this.bvx = nx; this.bvy = ny;
      }
      if (this.bz <= 0) {
        this.bz = 0; this.spin = 0;
        if (this.bvz < -120) { this.bvz = -this.bvz * 0.45; this.bz = 0.01; } else this.bvz = 0;
      }
    } else {
      const f = Math.pow(0.986, dt * 60);
      this.bvx *= f; this.bvy *= f;
      if (Math.hypot(this.bvx, this.bvy) < 4) { this.bvx = 0; this.bvy = 0; }
    }
    this.roll += Math.hypot(this.bvx, this.bvy) * dt * 0.12;

    // posts
    for (const px of [L, R]) for (const py of [CY - GOAL_HALF, CY + GOAL_HALF]) {
      const d = dist(this.bx, this.by, px, py);
      if (d < 6.5 && this.bz < BAR_H) {
        const nx = (this.bx - px) / (d || 1), ny = (this.by - py) / (d || 1);
        const dot = this.bvx * nx + this.bvy * ny;
        if (dot < 0) {
          this.bvx = (this.bvx - 1.8 * dot * nx) * 0.8; this.bvy = (this.bvy - 1.8 * dot * ny) * 0.8;
          this.bx = px + nx * 7; this.by = py + ny * 7;
          this.sfx.post(); this.popup('POST!', this.bx, this.by - 14, '#ffffff');
          this.cameras.main.shake(80, 0.004);
        }
      }
    }
    // speed trail
    this.trailT -= dt;
    if (Math.hypot(this.bvx, this.bvy) > 330 && this.trailT <= 0) {
      this.trailT = 0.03;
      const t = this.add.circle(this.bx, this.by - this.bz, 3.5, 0xffffff, 0.5).setDepth(9);
      this.tweens.add({ targets: t, alpha: 0, scale: 0.3, duration: 240, onComplete: () => t.destroy() });
    }
  }

  private resolveTouches(): void {
    if (this.carrier || this.mode !== 'play') return;
    const speed = Math.hypot(this.bvx, this.bvy);
    let best: Footballer | null = null, bd = 999;
    for (const p of this.players) {
      if (p.stun > 0 || p.cooldown > 0 || p.slide > 0) continue;
      if (this.shootout && p.role !== 'GK') continue;
      const d = dist(p.x, p.y, this.bx, this.by);
      const reach = p.role === 'GK' ? 20 : this.bz >= 10 ? 15 : 14;
      if (d < reach && d < bd && this.bz < 46) { best = p; bd = d; }
    }
    if (!best) return;
    const p = best;
    if (p.role === 'GK' && inBox(p.side, this.bx, this.by)) {
      this.lastTouch = p;
      if (speed < 340 && this.bz < 40) {
        this.carrier = p; p.think = 1.1; this.bvx = 0; this.bvy = 0; this.bvz = 0;
        this.popup('SAVED!', p.x, p.y - 26, '#9be564'); this.sfx.save();
      } else {
        this.bvx = -this.bvx * 0.45; this.bvy = this.bvy * 0.5 + rand(-110, 110); this.bvz = 70; this.spin = 0;
        p.cooldown = 0.5; this.popup('SAVE!', p.x, p.y - 26, '#9be564'); this.sfx.save();
        this.cameras.main.shake(100, 0.004);
      }
      return;
    }
    if (this.bz >= 10) { this.header(p); return; }
    const mate = this.lastTouch !== null && this.lastTouch.side === p.side;
    if (speed > 300 && !mate) {
      this.bvx = -this.bvx * 0.35 + rand(-60, 60); this.bvy = this.bvy * 0.35 + rand(-120, 120); this.bvz = 40; this.spin = 0;
      this.lastTouch = p; p.cooldown = 0.3; this.sfx.thud(); return;
    }
    if (speed > 430) return;
    this.carrier = p; this.lastTouch = p; this.bvx = 0; this.bvy = 0; p.think = 0.3;
    if (p.side === 'home') this.selectControlled(p);
  }

  private header(p: Footballer): void {
    const gx = attackX(p.side), dir = dirOf(p.side);
    const near = Math.abs(gx - p.x) < 230 && Math.abs(p.y - CY) < 150;
    let tx: number, ty: number;
    if (near) { tx = gx; ty = CY + rand(-40, 40); }
    else if (inBox(p.side, p.x, p.y) || Math.abs(p.x - ownX(p.side)) < 260) { tx = p.x + dir * 200; ty = p.y < CY ? T + 40 : B - 40; }
    else { tx = p.x + dir * 160; ty = p.y; }
    let a = Math.atan2(ty - p.y, tx - p.x);
    if (Math.random() < 0.25) a += rand(-1.2, 1.2);
    const v = near ? 330 : 260;
    this.kickBall(p, Math.cos(a) * v, Math.sin(a) * v, near ? 30 : 110);
    p.cooldown = 0.4; this.popup('HEADER', p.x, p.y - 24, '#ffffff');
  }

  private checkBounds(): void {
    if (this.shootout) {
      if (this.bx < L - 8 || this.bx > R + 8 || this.by < T || this.by > B) {
        if (this.bx < L || this.bx > R) {
          const inMouth = Math.abs(this.by - CY) < GOAL_HALF && this.bz < BAR_H;
          if (inMouth && this.penTimer >= 0) { this.score(this.bx < L ? 'away' : 'home'); return; }
        }
        this.bvx = 0; this.bvy = 0; this.bx = clamp(this.bx, L - 6, R + 6); this.by = clamp(this.by, T, B);
      }
      return;
    }
    if (this.by < T || this.by > B) {
      const side = other(this.lastTouch?.side ?? 'home');
      this.sfx.whistle();
      this.setMessage(`Throw-in — ${NAMES[side]}`);
      this.startSetPiece('throw', side, clamp(this.bx, L + 20, R - 20), this.by < T ? T : B);
      return;
    }
    if (this.bx < L || this.bx > R) {
      const leftEnd = this.bx < L;
      if (Math.abs(this.by - CY) < GOAL_HALF && this.bz < BAR_H) { this.score(leftEnd ? 'away' : 'home'); return; }
      const def: TeamSide = leftEnd ? 'home' : 'away';
      const touch = this.lastTouch?.side ?? def;
      this.sfx.whistle();
      if (touch === def) {
        this.setMessage(`Corner — ${NAMES[other(def)]}`); this.popup('CORNER', this.bx, this.by, '#ffe07a');
        this.startSetPiece('corner', other(def), leftEnd ? L + 2 : R - 2, this.by < CY ? T + 2 : B - 2);
      } else {
        this.setMessage(`Goal kick — ${NAMES[def]}`);
        this.startSetPiece('goalkick', def, ownX(def) + dirOf(def) * 22, CY);
      }
    }
  }

  private drawBall(): void {
    this.ballC.setPosition(this.bx, this.by - this.bz).setRotation(this.roll);
    this.ballShadow.setPosition(this.bx + 2, this.by + 4).setScale(1 / (1 + this.bz / 70));
    this.ballShadow.setAlpha(0.4 / (1 + this.bz / 50));
    this.ballC.setScale(1 + this.bz / 140);
  }

  private renderPlayer(p: Footballer): void {
    p.body.setPosition(p.x, p.y).setRotation(p.facing).setDepth(5 + p.y / 1000);
    p.shadow.setPosition(p.x + 3, p.y + 6);
    p.tag.setPosition(p.x, p.y - 19);
    p.ring.setPosition(p.x, p.y).setVisible(p === this.controlled && this.mode !== 'celebrate' && this.mode !== 'ended');
    const s = Math.sin(p.run) * 5;
    p.feet[0].setPosition(s, -6); p.feet[1].setPosition(-s, 6);
    const lying = p.stun > 0.01 || p.diveT > 0;
    p.body.setScale(p.slide > 0 ? 1.55 : lying ? 1.3 : 1, p.slide > 0 || lying ? 0.7 : 1);
  }

  /* ---------------------------- set pieces ------------------------- */
  private startSetPiece(kind: PieceKind, side: TeamSide, x: number, y: number): void {
    this.mode = 'setpiece';
    this.carrier = null; this.charging = false; this.charge = 0; this.penTimer = -1;
    this.bx = clamp(x, L + 2, R - 2); this.by = clamp(y, T, B); this.bz = 0;
    this.bvx = 0; this.bvy = 0; this.bvz = 0; this.spin = 0;
    this.players.forEach(p => { p.stun = 0; p.slide = 0; p.slideHit = false; p.vx = 0; p.vy = 0; p.diveT = 0; });
    const taker = this.pickTaker(kind, side);
    const sp: SetPiece = {
      kind, side, x: this.bx, y: this.by, taker, timer: 0,
      wait: kind === 'penalty' ? 2.0 : kind === 'corner' ? 1.6 : kind === 'freekick' ? 1.5 : 0.9,
      ready: false, readyT: 0, aimX: 0, aimY: 0, aimPx: 0, prompted: false, targets: new Map(),
    };
    this.sp = sp; this.buildTargets(sp);
    if (side === 'home') this.controlled = taker;
    if (kind === 'penalty') {
      this.banner('PENALTY!', TEAM_HEX[side], undefined, 1200);
      if (side === 'away') this.setMessage('Penalty! Press ↑ or ↓ to dive');
    }
    if (kind === 'freekick' || kind === 'corner') this.sfx.roar(0.25, 1.6);
  }

  private pickTaker(kind: PieceKind, side: TeamSide): Footballer {
    if (kind === 'goalkick') return this.gkOf(side);
    const outfield = this.players.filter(p => p.side === side && p.role !== 'GK');
    if (kind === 'penalty') {
      if (this.shootout) return outfield[this.shootout.taken[side] % outfield.length];
      return outfield.find(p => p.role === 'FWD') ?? outfield[0];
    }
    return this.nearestOutfield(side, this.bx, this.by);
  }

  private buildTargets(sp: SetPiece): void {
    const { kind, side, x, y } = sp, dir = dirOf(side), opp = other(side), t = sp.targets;
    const put = (p: Footballer, tx: number, ty: number) => t.set(p, { x: clamp(tx, L + 6, R - 6), y: clamp(ty, T + 6, B - 6) });
    const keepOff = (px: number, py: number, d: number): { x: number; y: number } => {
      const dd = dist(px, py, x, y);
      if (dd >= d || dd < 0.1) return { x: px, y: py };
      return { x: x + ((px - x) / dd) * d, y: y + ((py - y) / dd) * d };
    };
    switch (kind) {
      case 'throw': put(sp.taker, x, y + (y < CY ? 9 : -9)); break;
      case 'corner': put(sp.taker, x + (x < FIELD_W / 2 ? 10 : -10), y + (y < CY ? 10 : -10)); break;
      case 'goalkick': put(sp.taker, x - dir * 10, y); break;
      case 'freekick': put(sp.taker, x - dir * 20, y); break;
      case 'penalty': put(sp.taker, x - dir * 32, y); break;
    }
    const gx = attackX(side);
    const others = this.players.filter(p => p !== sp.taker);
    let wall: Footballer[] = [];
    if (kind === 'freekick') {
      const gd = dist(x, y, gx, CY) || 1, wd = gd < 130 ? 60 : 75;
      const wc = { x: x + ((gx - x) / gd) * wd, y: y + ((CY - y) / gd) * wd };
      const px = -(CY - y) / gd, py = (gx - x) / gd;
      wall = others.filter(p => p.side === opp && p.role !== 'GK')
        .sort((a, b) => dist(a.x, a.y, wc.x, wc.y) - dist(b.x, b.y, wc.x, wc.y)).slice(0, 3);
      wall.forEach((p, i) => put(p, wc.x + px * (i - 1) * 15, wc.y + py * (i - 1) * 15));
    }
    let slot = 0;
    for (const p of others) {
      if (t.has(p)) continue;
      const shape = {
        x: p.homeX + clamp((x - FIELD_W / 2) * 0.3, -70, 70) * 0.6 + (x - p.homeX) * 0.2,
        y: p.homeY * 0.6 + y * 0.4,
      };
      if (p.role === 'GK') { put(p, p.homeX, CY); continue; }
      if (kind === 'penalty') {
        const ax = gx - dir * (BOX_W + 45);
        put(p, ax, CY + (slot++ - 5) * 32); continue;
      }
      if (kind === 'corner') {
        const inward = x < FIELD_W / 2 ? 1 : -1, ge = x < FIELD_W / 2 ? L : R;
        const atk = p.side === side;
        const slots = atk
          ? [[80, -30], [95, 30], [60, 0], [140, 10], [170, -50], [170, 50]]
          : [[45, -25], [45, 25], [70, 0], [100, -40], [100, 40], [130, 0]];
        const s = slots[slot++ % slots.length];
        put(p, ge + inward * s[0], CY + s[1]); continue;
      }
      if (kind === 'freekick' && p.side === side) { put(p, (p.homeX + x + dir * 70) / 2, p.homeY * 0.5 + y * 0.5); continue; }
      const k = keepOff(shape.x, shape.y, p.side === side ? 40 : 65);
      put(p, k.x, k.y);
    }
  }

  private updateSetPiece(dt: number): void {
    const sp = this.sp;
    if (!sp) { this.mode = 'play'; return; }
    sp.timer += dt;
    for (const p of this.players) {
      const tg = sp.targets.get(p);
      if (tg) this.steerTo(p, tg.x, tg.y, p === sp.taker ? 210 : 170, dt);
      else { p.vx = 0; p.vy = 0; this.moveP(p, dt); }
    }
    const tt = sp.targets.get(sp.taker);
    if (!sp.ready && sp.timer > sp.wait && (!tt || dist(sp.taker.x, sp.taker.y, tt.x, tt.y) < 6)) {
      sp.ready = true; sp.readyT = 0;
      sp.taker.facing = Math.atan2(sp.y - sp.taker.y, sp.x - sp.taker.x);
    }
    if (!sp.ready) return;
    sp.readyT += dt;
    const k = this.keys;
    if (sp.side === 'home') {
      if (!sp.prompted) {
        sp.prompted = true;
        this.setMessage({
          throw: 'Throw-in · aim with arrows · X to throw',
          corner: 'Corner · aim with arrows · X to cross',
          goalkick: 'Goal kick · X short · Z long',
          freekick: 'Free kick · ↑↓ aim · ←→ curl · Z shoot · X pass',
          penalty: 'Penalty · ↑↓ aim · Z to shoot',
        }[sp.kind]);
      }
      sp.aimX = Number(k.D.isDown || k.RIGHT.isDown) - Number(k.A.isDown || k.LEFT.isDown);
      sp.aimY = Number(k.S.isDown || k.DOWN.isDown) - Number(k.W.isDown || k.UP.isDown);
      if (sp.kind === 'penalty') sp.aimPx = clamp(sp.aimPx + sp.aimY * 90 * dt, -50, 50);
      if (Phaser.Input.Keyboard.JustDown(k.X) && sp.kind !== 'penalty') this.performPiece(sp, 'pass');
      else if (Phaser.Input.Keyboard.JustDown(k.Z)) this.performPiece(sp, 'shoot');
      else if (sp.readyT > 12) this.performPiece(sp, sp.kind === 'penalty' ? 'shoot' : 'pass');
    } else if (sp.readyT > (sp.kind === 'penalty' ? 1.8 : 1.2)) {
      this.cpuPiece(sp);
    }
  }

  private cpuPiece(sp: SetPiece): void {
    sp.aimX = rand(-1, 1); sp.aimY = rand(-1, 1);
    if (sp.kind === 'penalty') sp.aimPx = [-40, -22, 0, 22, 40][Math.floor(Math.random() * 5)];
    let how: 'pass' | 'shoot' = 'pass';
    if (sp.kind === 'freekick' && dist(sp.x, sp.y, attackX(sp.side), CY) < 330) how = 'shoot';
    if (sp.kind === 'goalkick' && Math.random() < 0.5) how = 'shoot';
    if (sp.kind === 'penalty') how = 'shoot';
    sp.aimX = sp.kind === 'goalkick' || sp.kind === 'throw' ? 0 : sp.aimX;
    this.performPiece(sp, how);
  }

  private performPiece(sp: SetPiece, how: 'pass' | 'shoot'): void {
    const taker = sp.taker, side = sp.side, dir = dirOf(side), gx = attackX(side);
    const mates = this.players.filter(p => p.side === side && p.role !== 'GK' && p !== taker);
    const hasAim = Math.hypot(sp.aimX, sp.aimY) > 0.3;
    const aim = hasAim ? Math.atan2(sp.aimY, sp.aimX) : (sp.kind === 'goalkick' && how === 'shoot' ? (dir > 0 ? 0 : Math.PI) : null);
    const pickMate = (maxD: number): Footballer => {
      const list = mates.map(m => {
        const a = Math.atan2(m.y - this.by, m.x - this.bx), d = dist(m.x, m.y, this.bx, this.by);
        const diff = aim === null ? 0 : Math.abs(Phaser.Math.Angle.Wrap(a - aim));
        return { m, d, score: -diff * 1.4 - d / 260 };
      }).sort((a, b) => b.score - a.score);
      return (list.find(e => e.d <= maxD && e.d > 30) ?? list[0]).m;
    };
    this.mode = 'play'; this.sp = null; this.kickoffLock = 0;
    this.setMessage('Play on!');
    const dxm = (m: Footballer) => ({ d: dist(m.x, m.y, this.bx, this.by), a: Math.atan2(m.y - this.by, m.x - this.bx) });

    if (sp.kind === 'throw') {
      const m = pickMate(260), { d, a } = dxm(m);
      this.bz = 14;
      this.kickBall(taker, Math.cos(a) * Math.min(300, d / 0.55), Math.sin(a) * Math.min(300, d / 0.55), GRAVITY * 0.275);
    } else if (sp.kind === 'corner') {
      const inward = this.bx < FIELD_W / 2 ? 1 : -1, ge = this.bx < FIELD_W / 2 ? L : R;
      const tx = ge + inward * 80 + sp.aimX * 25, ty = CY + sp.aimY * 40, tf = 0.85;
      this.bz = 1;
      this.kickBall(taker, (tx - this.bx) / tf, (ty - this.by) / tf, GRAVITY * tf / 2);
      this.setMessage('Cross into the box!');
    } else if (sp.kind === 'goalkick') {
      const m = pickMate(520), { d, a } = dxm(m);
      if (how === 'shoot') this.kickBall(taker, Math.cos(a) * (d / 0.7), Math.sin(a) * (d / 0.7), GRAVITY * 0.35);
      else { const v = clamp(d * 1.1 + 70, 150, 320); this.kickBall(taker, Math.cos(a) * v, Math.sin(a) * v); }
    } else if (sp.kind === 'freekick') {
      if (how === 'shoot') {
        const ty = CY + sp.aimY * 34, d = dist(this.bx, this.by, gx, ty);
        const tf = clamp(d / 420, 0.45, 0.95), spin = sp.aimX * 1.0;
        const a = Math.atan2(ty - this.by, gx - this.bx) - spin * tf * 0.5;
        this.bz = 1;
        this.kickBall(taker, Math.cos(a) * (d / tf), Math.sin(a) * (d / tf), GRAVITY * tf / 2, spin);
        this.setMessage('FREE KICK!');
      } else {
        const m = pickMate(300);
        this.passTo(taker, m);
      }
    } else {
      this.takePenalty(sp);
    }
    if (this.controlled.role === 'GK') this.selectControlled(this.nearestOutfield('home', this.bx, this.by));
  }

  private takePenalty(sp: SetPiece): void {
    const taker = sp.taker, gx = attackX(sp.side), gk = this.gkOf(other(sp.side));
    let ty = CY + sp.aimPx;
    if (Math.abs(sp.aimPx) > 42 && Math.random() < 0.3) ty += Math.sign(sp.aimPx) * 26; // pulled it wide
    ty += rand(-4, 4);
    const a = Math.atan2(ty - this.by, gx - this.bx), v = sp.side === 'home' ? 430 : 410;
    this.kickBall(taker, Math.cos(a) * v, Math.sin(a) * v);
    let dive: number;
    if (sp.side === 'away') {
      dive = Number(this.keys.S.isDown || this.keys.DOWN.isDown) - Number(this.keys.W.isDown || this.keys.UP.isDown);
    } else {
      dive = Math.random() < 0.4 ? Math.sign(ty - CY) || 0 : [-1, 0, 1][Math.floor(Math.random() * 3)];
    }
    gk.diveT = 0.55; gk.diveTy = CY + dive * 40;
    if (this.shootout) { this.penTimer = 2.4; this.penGoal = false; }
    this.setMessage('Penalty taken!');
  }

  /* ------------------------ goals & celebrations -------------------- */
  private score(side: TeamSide): void {
    const lt = this.lastTouch;
    const scorer = lt && lt.role !== 'GK' && lt.side === side ? lt : this.nearestOutfield(side, this.bx, this.by);
    const own = !!lt && lt.side !== side;
    if (!this.shootout) { if (side === 'home') this.homeScore++; else this.awayScore++; }
    else this.penGoal = true;
    this.bx = side === 'home' ? R + 7 : L - 7; this.bz = 0;
    this.bvx = 0; this.bvy = 0; this.bvz = 0; this.carrier = null; this.charging = false;
    this.mode = 'celebrate';
    const slideRight = side === 'home';
    this.celeb = {
      side, scorer, t: this.shootout ? 2.4 : 4.2, slid: false,
      fx: slideRight ? R - 20 : L + 20, fy: scorer.y < CY ? T + 18 : B - 18,
    };
    const hex = parseInt(TEAM_HEX[side].slice(1), 16);
    this.banner(own ? 'OWN GOAL!' : 'GOAL!', TEAM_HEX[side], `#${scorer.number} ${NAMES[side]}`, 2400);
    this.setMessage(own ? `Own goal! ${NAMES[side]} benefit` : `GOAL! ${NAMES[side]} score!`);
    this.cameras.main.shake(380, 0.012);
    this.cameras.main.flash(260, (hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
    this.burstConfetti(side === 'home' ? R : L, CY, side, 110);
    this.excited = 4.5;
    this.sfx.whistle(); this.sfx.roar(1, 5);
    this.sfx.speak(own ? 'Own goal!' : 'Gooooooal!', 0.7, 1.15);
    const net = side === 'home' ? this.netR : this.netL;
    this.tweens.add({ targets: net, x: { from: side === 'home' ? 6 : -6, to: 0 }, duration: 500, ease: 'Bounce.Out' });
    this.tweens.add({ targets: this.cameras.main, zoom: { from: 1.06, to: 1 }, duration: 600, ease: 'Sine.Out' });
  }

  private updateCelebrate(dt: number): void {
    const ce = this.celeb;
    if (!ce) { this.kickoff('home'); return; }
    ce.t -= dt;
    const sc = ce.scorer;
    this.players.forEach((p, i) => {
      if (p === sc) {
        if (!ce.slid) {
          this.steerTo(p, ce.fx, ce.fy, 215, dt);
          if (dist(p.x, p.y, ce.fx, ce.fy) < 70) {
            ce.slid = true; p.slide = 0.5; p.slideAng = p.facing; p.slideHit = true;
            this.sfx.roar(0.8, 3);
          }
        } else { p.vx = 0; p.vy = 0; this.moveP(p, dt); }
      } else if (p.side === ce.side && p.role !== 'GK') {
        const ang = i * 1.1;
        this.steerTo(p, sc.x + Math.cos(ang) * 28, sc.y + Math.sin(ang) * 28, 200, dt);
      } else { p.vx = 0; p.vy = 0; this.moveP(p, dt); }
    });
    if (Math.random() < dt * 8) {
      const c = ce.side === 'home' ? R : L;
      this.spawnConfetti(c, CY + rand(-40, 40), ce.side, 3);
    }
    if (ce.t <= 0) {
      this.celeb = null;
      if (this.shootout) { this.mode = 'play'; this.resolvePenalty(); }
      else this.kickoff(other(ce.side));
    }
  }

  private burstConfetti(x: number, y: number, side: TeamSide, n: number): void { this.spawnConfetti(x, y, side, n, true); }

  private spawnConfetti(x: number, y: number, side: TeamSide, n: number, burst = false): void {
    const cols = [parseInt(TEAM_HEX[side].slice(1), 16), 0xffffff, 0xffe07a, 0xc77dff];
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = burst ? rand(120, 380) : rand(40, 160);
      this.confetti.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (burst ? 150 : 60), w: rand(3, 6), h: rand(3, 7),
        c: cols[Math.floor(Math.random() * cols.length)], life: rand(1.6, 3.2), ph: rand(0, 6),
      });
    }
  }

  private updateConfetti(dt: number): void {
    const g = this.confettiG; g.clear();
    this.confetti = this.confetti.filter(c => c.life > 0 && c.y < FIELD_H + 10);
    for (const c of this.confetti) {
      c.life -= dt; c.vy += 320 * dt; c.vx *= 0.99; c.x += c.vx * dt; c.y += c.vy * dt; c.ph += dt * 10;
      g.fillStyle(c.c, Math.min(1, c.life)).fillRect(c.x, c.y, c.w, c.h * Math.abs(Math.cos(c.ph)) + 1);
    }
  }

  /* ----------------------- shoot-out & restarts --------------------- */
  private startShootout(): void {
    this.shootout = { home: 0, away: 0, taken: { home: 0, away: 0 }, hist: { home: [], away: [] }, turn: 'home' };
    this.banner('PENALTY SHOOT-OUT', '#ffe07a', 'Best of five — then sudden death', 2000);
    this.sfx.roar(0.6, 3);
    this.nextPenalty();
  }

  private nextPenalty(): void {
    const so = this.shootout!;
    this.startSetPiece('penalty', so.turn, so.turn === 'home' ? R - SPOT_X : L + SPOT_X, CY);
  }

  private resolvePenalty(): void {
    const so = this.shootout; if (!so) return;
    const side = so.turn, scored = this.penGoal;
    this.penGoal = false;
    so.hist[side].push(scored ? '●' : '○');
    if (scored) so[side]++;
    so.taken[side]++;
    if (!scored) { this.popup('MISSED', FIELD_W / 2, CY - 40, '#ff8a8a'); this.sfx.roar(0.2, 1.2); }
    const hLeft = Math.max(0, 5 - so.taken.home), aLeft = Math.max(0, 5 - so.taken.away);
    let winner: TeamSide | null = null;
    if (so.taken.home <= 5 || so.taken.away <= 5) {
      if (so.home > so.away + aLeft) winner = 'home'; else if (so.away > so.home + hLeft) winner = 'away';
    }
    if (!winner && so.taken.home === so.taken.away && so.taken.home >= 5 && so.home !== so.away) winner = so.home > so.away ? 'home' : 'away';
    this.setMessage(`Shoot-out ${so.home}–${so.away} · Rockets ${so.hist.home.join('')} · Comets ${so.hist.away.join('')}`);
    if (winner) { this.shootout = null; this.endMatch(winner, true); return; }
    so.turn = other(side);
    this.nextPenalty();
  }

  private kickoff(side: TeamSide): void {
    this.mode = 'play'; this.sp = null; this.celeb = null; this.carrier = null; this.charging = false;
    this.players.forEach(p => {
      p.x = p.homeX; p.y = p.homeY; p.vx = 0; p.vy = 0; p.stun = 0; p.slide = 0; p.diveT = 0; p.cooldown = 0;
      p.facing = p.side === 'home' ? 0 : Math.PI;
    });
    this.bx = FIELD_W / 2; this.by = CY; this.bz = 0; this.bvx = 0; this.bvy = 0; this.bvz = 0; this.spin = 0;
    const taker = this.nearestOutfield(side, this.bx, this.by);
    taker.x = FIELD_W / 2 - dirOf(side) * 14; taker.y = CY;
    this.carrier = taker; this.lastTouch = taker; taker.think = 0.6;
    this.kickoffLock = 1.0;
    this.selectControlled(side === 'home' ? taker : this.nearestOutfield('home', this.bx, this.by));
    this.sfx.whistle();
  }

  private resetMatch(): void {
    this.homeScore = 0; this.awayScore = 0; this.remaining = HALF_SECONDS; this.half = 1; this.clockAcc = 0;
    this.shootout = null; this.penTimer = -1; this.penGoal = false; this.paused = false;
    this.confetti = []; this.excited = 0;
    if (this.hint) this.hint.style.display = 'none';
    this.kickoff('home');
    this.updateHud();
    this.setMessage('New match — kick-off!');
  }

  private selectControlled(p?: Footballer): void {
    this.controlled = p ?? this.nearestOutfield('home', this.bx, this.by);
  }

  /* ------------------------------ visuals --------------------------- */
  private drawFx(): void {
    const g = this.fx; g.clear();
    const c = this.controlled;
    if (this.charging && c && this.mode === 'play') {
      g.fillStyle(0x000000, 0.6).fillRect(c.x - 17, c.y - 34, 34, 7);
      g.fillStyle(this.charge > 0.8 ? 0xff5a5f : 0xffe07a, 1).fillRect(c.x - 16, c.y - 33, 32 * this.charge, 5);
    }
    const sp = this.sp;
    if (this.mode === 'setpiece' && sp) {
      const pulse = 8 + Math.sin(this.time.now / 120) * 2;
      g.lineStyle(2, 0xffe07a, 0.9).strokeCircle(this.bx, this.by, pulse);
      if (sp.ready && sp.side === 'home') {
        g.lineStyle(2, 0xffffff, 0.8);
        if (sp.kind === 'penalty') {
          const gx = attackX('home'), ty = CY + sp.aimPx;
          g.lineStyle(2, 0xffe07a, 1).strokeCircle(gx + 6, ty, 7).lineBetween(this.bx, this.by, gx, ty);
        } else if (sp.kind === 'corner') {
          const inward = this.bx < FIELD_W / 2 ? 1 : -1, ge = this.bx < FIELD_W / 2 ? L : R;
          g.strokeCircle(ge + inward * 80 + sp.aimX * 25, CY + sp.aimY * 40, 9);
        } else if (Math.hypot(sp.aimX, sp.aimY) > 0.3) {
          const a = Math.atan2(sp.aimY, sp.aimX);
          g.lineBetween(this.bx, this.by, this.bx + Math.cos(a) * 80, this.by + Math.sin(a) * 80);
          g.fillStyle(0xffffff, 0.9).fillCircle(this.bx + Math.cos(a) * 80, this.by + Math.sin(a) * 80, 4);
        }
      }
    }
  }

  private banner(text: string, color: string, sub?: string, hold = 1100): void {
    const t = this.add.text(FIELD_W / 2, CY - 24, text, {
      fontFamily: '"Arial Black", Impact, sans-serif', fontSize: text.length > 10 ? '46px' : '80px', color,
      stroke: '#0a1f16', strokeThickness: 9, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(80).setScale(0.2).setAlpha(0);
    const items: Phaser.GameObjects.Text[] = [t];
    if (sub) {
      items.push(this.add.text(FIELD_W / 2, CY + 36, sub, {
        fontFamily: 'Arial, sans-serif', fontSize: '22px', color: '#ffffff', stroke: '#0a1f16', strokeThickness: 5, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(80).setScale(0.2).setAlpha(0));
    }
    this.tweens.add({
      targets: items, scale: 1, alpha: 1, duration: 320, ease: 'Back.Out',
      onComplete: () => this.tweens.add({
        targets: items, alpha: 0, y: '-=20', delay: hold, duration: 450,
        onComplete: () => items.forEach(i => i.destroy()),
      }),
    });
  }

  private popup(text: string, x: number, y: number, color: string): void {
    const t = this.add.text(x, y, text, {
      fontFamily: 'Arial, sans-serif', fontSize: '14px', color, stroke: '#0a1f16', strokeThickness: 4, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(70);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 900, ease: 'Sine.Out', onComplete: () => t.destroy() });
  }

  /* -------------------------------- HUD ----------------------------- */
  private updateHud(): void {
    if (this.homeScoreEl) this.homeScoreEl.textContent = String(this.homeScore);
    if (this.awayScoreEl) this.awayScoreEl.textContent = String(this.awayScore);
    if (this.clockEl) {
      this.clockEl.textContent = this.shootout ? 'PENS'
        : `${String(Math.floor(this.remaining / 60)).padStart(2, '0')}:${String(this.remaining % 60).padStart(2, '0')}`;
    }
    if (this.periodEl) {
      this.periodEl.textContent = this.shootout ? `PENALTIES ${this.shootout.home}-${this.shootout.away}`
        : ['FIRST HALF', 'SECOND HALF', 'EXTRA TIME 1', 'EXTRA TIME 2'][this.half - 1];
    }
    if (this.statusEl && this.message) this.statusEl.innerHTML = `<span class="status-icon">▶</span> ${this.message}`;
  }

  private setMessage(message: string): void {
    this.message = message;
    this.updateHud();
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: FIELD_W,
  height: FIELD_H,
  backgroundColor: '#0d3626',
  antialias: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: FIELD_W,
    height: FIELD_H,
  },
  render: { pixelArt: false, roundPixels: false },
  scene: [RetroKickScene],
});

(window as Window & { retroKickGame?: Phaser.Game }).retroKickGame = game;
