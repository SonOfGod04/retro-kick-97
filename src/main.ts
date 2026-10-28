import Phaser from 'phaser';
import './style.css';

const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_HALF_SECONDS = 40;
const GOAL_HALF = 52;
const HOME_NAME = 'Rockets';
const AWAY_NAME = 'Comets';

type TeamSide = 'home' | 'away';
type Phase =
  | 'kickoff' | 'play' | 'throwin' | 'corner' | 'goalkick'
  | 'freekick' | 'penalty' | 'goal' | 'halftime' | 'fulltime'
  | 'extratime-break' | 'shootout' | 'matchend';

interface Footballer {
  sprite: Phaser.GameObjects.Arc;
  shadow: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  facing: Phaser.GameObjects.Triangle;
  side: TeamSide;
  role: 'GK' | 'DEF' | 'MID' | 'FWD';
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  number: number;
  cooldown: number;
  facingAngle: number;
}

interface Particle {
  obj: Phaser.GameObjects.Shape;
  vx: number;
  vy: number;
  vr: number;
  life: number;
  maxLife: number;
}

/** Tiny synthesized sound effects — no audio assets required. */
class SoundFX {
  private ctx: AudioContext | null = null;

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
      } catch { this.ctx = null; }
    }
    return this.ctx;
  }

  resume(): void { this.ensure()?.resume().catch(() => {}); }

  private noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  whistle(): void {
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2100, t0);
    osc.frequency.exponentialRampToValueAtTime(1750, t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.26);
  }

  kick(): void {
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx, 0.08);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t0);
  }

  /** The "goal scream" — a rising crowd roar. */
  crowdCheer(big = false): void {
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = big ? 2.6 : 1.1;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx, dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(380, t0);
    filter.frequency.linearRampToValueAtTime(big ? 1700 : 950, t0 + dur * 0.45);
    filter.frequency.linearRampToValueAtTime(300, t0 + dur);
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(big ? 0.55 : 0.3, t0 + dur * 0.16);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t0); src.stop(t0 + dur);

    // A second, slightly delayed layer makes the roar feel bigger.
    if (big) {
      const src2 = ctx.createBufferSource();
      src2.buffer = this.noiseBuffer(ctx, dur * 0.8);
      const filter2 = ctx.createBiquadFilter();
      filter2.type = 'lowpass'; filter2.frequency.value = 1200;
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0.0001, t0 + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.35, t0 + 0.4);
      gain2.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      src2.connect(filter2).connect(gain2).connect(ctx.destination);
      src2.start(t0 + 0.1);
    }
  }

  crowdGroan(): void {
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx, 0.7);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.1);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + 0.7);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t0); src.stop(t0 + 0.7);
  }
}

class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ball!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Arc;
  private ballMark!: Phaser.GameObjects.Star;
  private ballVx = 0;
  private ballVy = 0;
  private ballSpin = 0;

  private possession: TeamSide | null = 'home';
  private lastTouch: TeamSide | null = null;
  private controlled!: Footballer;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  private homeScore = 0;
  private awayScore = 0;
  private remaining = HALF_SECONDS;
  private lastClockTick = 0;
  private half = 1;
  private isExtraTime = false;
  private extraHalf = 1;
  private pendingHalfEnd = false;

  private paused = true;
  private pauseKeyHeld = false;

  private phase: Phase = 'kickoff';
  private phaseTimer = 0;
  private breakCallback: (() => void) | null = null;
  private touchLock = 0;

  private setPieceSide: TeamSide | null = null;
  private setPieceTaker: Footballer | null = null;
  private setPieceWall: Footballer[] = [];

  private penaltyGK: Footballer | null = null;
  private penaltyAim = 0;
  private penaltyActive = false;

  private inShootout = false;
  private shootoutHome: boolean[] = [];
  private shootoutAway: boolean[] = [];
  private shootoutTurn: TeamSide = 'home';
  private shootoutWindowOpen = false;
  private shootoutText: Phaser.GameObjects.Text | null = null;

  private lastScorer: TeamSide = 'home';

  private particles: Particle[] = [];
  private bigText!: Phaser.GameObjects.Text;
  private flashRect!: Phaser.GameObjects.Rectangle;
  private crowdGraphic!: Phaser.GameObjects.Graphics;

  private sfx = new SoundFX();

  private message = 'Ready for kick-off';
  private messageUntil = Infinity;

  private hint!: HTMLElement | null;
  private homeScoreEl!: HTMLElement | null;
  private awayScoreEl!: HTMLElement | null;
  private clockEl!: HTMLElement | null;
  private periodEl!: HTMLElement | null;
  private statusEl!: HTMLElement | null;

  constructor() { super('RetroKickScene'); }

  create(): void {
    this.drawPitch();
    this.createTeams();
    this.createBall();
    this.createOverlayFx();

    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,SPACE,SHIFT,P,ENTER') as Record<string, Phaser.Input.Keyboard.Key>;
    this.homeScoreEl = document.getElementById('home-score');
    this.awayScoreEl = document.getElementById('away-score');
    this.clockEl = document.getElementById('clock');
    this.periodEl = document.getElementById('period');
    this.statusEl = document.getElementById('status-message');
    this.hint = document.getElementById('canvas-hint');

    this.input.on('pointerdown', () => {
      this.sfx.resume();
      if (this.phase === 'matchend') { this.resetMatch(); return; }
      this.paused = false;
      if (this.hint) this.hint.style.display = 'none';
      this.setMessage('Play on!');
    });
    this.input.keyboard!.on('keydown', () => this.sfx.resume());
    document.getElementById('restart-button')?.addEventListener('click', () => this.resetMatch());

    this.selectControlled();
    this.updateHud();
    this.setMessage('Ready for kick-off');
    this.phase = 'play';

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      const btn = document.getElementById('restart-button');
      btn?.replaceWith(btn.cloneNode(true));
    });
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------

  private drawPitch(): void {
    const g = this.add.graphics();
    g.fillStyle(0x1b6849, 1).fillRect(0, 0, FIELD_W, FIELD_H);
    const stripeW = FIELD_W / 10;
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) g.fillStyle(0xffffff, 0.035).fillRect(i * stripeW, 0, stripeW, FIELD_H);
    }
    g.lineStyle(3, 0xe6f4d9, 0.83);
    g.strokeRect(19, 19, FIELD_W - 38, FIELD_H - 38);
    g.lineBetween(FIELD_W / 2, 19, FIELD_W / 2, FIELD_H - 19);
    g.strokeCircle(FIELD_W / 2, FIELD_H / 2, 67);
    g.fillStyle(0xe6f4d9, 0.9).fillCircle(FIELD_W / 2, FIELD_H / 2, 4);

    // Penalty boxes, six-yard boxes, spots.
    g.strokeRect(19, 135, 118, 250);
    g.strokeRect(19, 190, 49, 140);
    g.strokeRect(FIELD_W - 137, 135, 118, 250);
    g.strokeRect(FIELD_W - 68, 190, 49, 140);
    g.fillStyle(0xe6f4d9, 0.9).fillCircle(112, FIELD_H / 2, 3).fillCircle(FIELD_W - 112, FIELD_H / 2, 3);

    // Authentic "D" arcs at the edge of the penalty boxes.
    const arcAngle = Math.acos(25 / 55);
    g.beginPath(); g.arc(112, FIELD_H / 2, 55, -arcAngle, arcAngle, false); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 112, FIELD_H / 2, 55, Math.PI - arcAngle, Math.PI + arcAngle, false); g.strokePath();

    // Corner arcs.
    g.beginPath(); g.arc(19, 19, 10, 0, Math.PI / 2, false); g.strokePath();
    g.beginPath(); g.arc(19, FIELD_H - 19, 10, -Math.PI / 2, 0, false); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, 19, 10, Math.PI / 2, Math.PI, false); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, FIELD_H - 19, 10, Math.PI, Math.PI * 1.5, false); g.strokePath();

    // Goals with a simple net mesh.
    g.fillStyle(0xd8e3dc, 1).fillRect(0, FIELD_H / 2 - 52, 22, 104);
    g.fillStyle(0xd8e3dc, 1).fillRect(FIELD_W - 22, FIELD_H / 2 - 52, 22, 104);
    g.lineStyle(1, 0xffffff, 0.4);
    for (let gy = FIELD_H / 2 - 52; gy <= FIELD_H / 2 + 52; gy += 9) {
      g.lineBetween(0, gy, 22, gy);
      g.lineBetween(FIELD_W - 22, gy, FIELD_W, gy);
    }
    for (let gx = 0; gx <= 22; gx += 7) {
      g.lineBetween(gx, FIELD_H / 2 - 52, gx, FIELD_H / 2 + 52);
      g.lineBetween(FIELD_W - gx, FIELD_H / 2 - 52, FIELD_W - gx, FIELD_H / 2 + 52);
    }
    g.lineStyle(2, 0xffffff, 0.85);
    for (let y = FIELD_H / 2 - 44; y <= FIELD_H / 2 + 44; y += 22) {
      g.lineBetween(0, y, 20, y);
      g.lineBetween(FIELD_W - 20, y, FIELD_W, y);
    }

    // Corner flags.
    g.fillStyle(0xf4d06f, 1);
    g.fillTriangle(10, 9, 22, 9, 10, 21);
    g.fillTriangle(FIELD_W - 10, 9, FIELD_W - 22, 9, FIELD_W - 10, 21);
    g.fillTriangle(10, FIELD_H - 9, 22, FIELD_H - 9, 10, FIELD_H - 21);
    g.fillTriangle(FIELD_W - 10, FIELD_H - 9, FIELD_W - 22, FIELD_H - 9, FIELD_W - 10, FIELD_H - 21);

    // Pixel-crowd border, drawn in the outer margin so pitch coordinates stay unchanged.
    const crowd = this.add.graphics().setDepth(0);
    const crowdColors = [0xf4d06f, 0xffffff, 0x3aa9ff, 0xff5a5f, 0x2c3e50, 0x8fd3a0];
    for (let x = 4; x < FIELD_W - 4; x += 6) {
      crowd.fillStyle(Phaser.Utils.Array.GetRandom(crowdColors), 0.8).fillCircle(x, 6, 1.6);
      crowd.fillStyle(Phaser.Utils.Array.GetRandom(crowdColors), 0.8).fillCircle(x, FIELD_H - 6, 1.6);
    }
    for (let y = 4; y < FIELD_H - 4; y += 6) {
      crowd.fillStyle(Phaser.Utils.Array.GetRandom(crowdColors), 0.8).fillCircle(6, y, 1.6);
      crowd.fillStyle(Phaser.Utils.Array.GetRandom(crowdColors), 0.8).fillCircle(FIELD_W - 6, y, 1.6);
    }
    this.crowdGraphic = crowd;
  }

  private createOverlayFx(): void {
    this.flashRect = this.add.rectangle(FIELD_W / 2, FIELD_H / 2, FIELD_W, FIELD_H, 0xffffff, 0).setDepth(50);
    this.bigText = this.add.text(FIELD_W / 2, FIELD_H / 2 - 30, '', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: '56px',
      color: '#fff176',
      stroke: '#102018',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(60).setAlpha(0);
  }

  private createTeams(): void {
    const home = [
      [105, 260, 'GK'], [250, 145, 'DEF'], [250, 375, 'DEF'],
      [390, 205, 'MID'], [390, 315, 'MID'], [490, 155, 'FWD'], [490, 365, 'FWD'],
    ] as const;
    const away = [
      [795, 260, 'GK'], [650, 145, 'DEF'], [650, 375, 'DEF'],
      [510, 205, 'MID'], [510, 315, 'MID'], [410, 155, 'FWD'], [410, 365, 'FWD'],
    ] as const;
    home.forEach((p, i) => this.addPlayer('home', p[0], p[1], p[2], i + 1));
    away.forEach((p, i) => this.addPlayer('away', p[0], p[1], p[2], i + 1));
  }

  private addPlayer(side: TeamSide, x: number, y: number, role: Footballer['role'], number: number): void {
    const color = side === 'home' ? 0x3aa9ff : 0xff5a5f;
    const shadow = this.add.circle(x + 3, y + 5, role === 'GK' ? 15 : 13, 0x071b14, 0.3);
    const sprite = this.add.circle(x, y, role === 'GK' ? 13 : 12, color, 1).setStrokeStyle(3, 0xf7f3df, 1).setDepth(5);
    const label = this.add.text(x, y, String(number), {
      fontFamily: 'Arial, sans-serif',
      fontSize: role === 'GK' ? '11px' : '10px',
      color: '#10202a',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(6);
    const facing = this.add.triangle(x, y, 0, -5, 4, 4, -4, 4, 0xffffff, 0.9).setDepth(4);

    const player: Footballer = {
      sprite, shadow, label, facing, side, role, homeX: x, homeY: y,
      vx: 0, vy: 0, number, cooldown: 0, facingAngle: side === 'home' ? 0 : Math.PI,
    };
    this.players.push(player);
  }

  private createBall(): void {
    this.ballShadow = this.add.circle(FIELD_W / 2 + 2, FIELD_H / 2 + 4, 8, 0x071b14, 0.35).setDepth(10);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xf8f7ed, 1).setStrokeStyle(2, 0x17211e, 1).setDepth(11);
    this.ballMark = this.add.star(FIELD_W / 2, FIELD_H / 2, 5, 1.2, 3, 0x1c2b22, 0.85).setDepth(12);
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------

  update(time: number, delta: number): void {
    if (this.keys.P.isDown && !this.pauseKeyHeld) {
      this.paused = !this.paused;
      this.pauseKeyHeld = true;
      this.setMessage(this.paused ? 'Paused — press P to resume' : 'Play on!');
    }
    if (this.keys.P.isUp) this.pauseKeyHeld = false;
    if (this.keys.ENTER.isDown && this.phase === 'matchend') this.resetMatch();
    if (this.paused || this.phase === 'matchend') { this.updateHud(); return; }

    const dt = Math.min(delta / 1000, 0.035);
    this.tickClock(dt, time);
    this.tickMessageExpiry();

    switch (this.phase) {
      case 'kickoff': this.updateKickoffCountdown(dt); break;
      case 'play': this.updatePlay(dt); break;
      case 'throwin': this.updateThrowIn(dt); break;
      case 'corner': this.updateCorner(dt); break;
      case 'goalkick': this.updateGoalKick(dt); break;
      case 'freekick': this.updateFreeKick(dt); break;
      case 'penalty': this.updatePenalty(dt); break;
      case 'goal': this.updateGoalCelebration(dt); break;
      case 'halftime':
      case 'fulltime':
      case 'extratime-break':
        this.updateBreak(dt);
        break;
      case 'shootout': this.updateShootoutPhase(dt); break;
    }

    this.updateParticles(dt);
    this.spinBall(dt);
    this.updateHud();
  }

  private tickClock(dt: number, time: number): void {
    const running = this.phase !== 'goal' && this.phase !== 'halftime' && this.phase !== 'fulltime'
      && this.phase !== 'extratime-break' && this.phase !== 'shootout' && this.phase !== 'matchend';
    if (!running) return;
    if (time - this.lastClockTick >= 1000) {
      this.lastClockTick = time;
      if (this.remaining > 0) this.remaining--;
      if (this.remaining === 0 && !this.pendingHalfEnd) {
        if (this.phase === 'play') this.endHalf();
        else this.pendingHalfEnd = true;
      }
    }
  }

  private tickMessageExpiry(): void {
    if (this.time.now > this.messageUntil) {
      this.messageUntil = Infinity;
    }
  }

  // ---------------------------------------------------------------------
  // Open play
  // ---------------------------------------------------------------------

  private updatePlay(dt: number): void {
    this.touchLock = Math.max(0, this.touchLock - dt);
    this.players.forEach(p => { if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt); });

    this.updateUser(dt);
    this.updateCpu(dt);
    this.updateCpuTackles(dt);
    this.updateBallPhysics(dt);
    this.updatePossession();
  }

  private updateUser(dt: number): void {
    const left = this.keys.A.isDown || this.keys.LEFT.isDown;
    const right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const speed = this.keys.SHIFT.isDown ? 245 : 185;
    let dx = Number(right) - Number(left);
    let dy = Number(down) - Number(up);
    const length = Math.hypot(dx, dy) || 1;
    dx /= length; dy /= length;
    this.controlled.vx = dx * speed;
    this.controlled.vy = dy * speed;
    this.movePlayer(this.controlled, dt, true);

    this.players.filter(p => p.side === 'home' && p !== this.controlled).forEach(p => {
      const supportX = p.homeX + Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.14, -45, 45);
      const supportY = p.homeY + Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.1, -35, 35);
      this.steerTo(p, supportX, supportY, 110, dt);
    });

    if (Phaser.Input.Keyboard.JustDown(this.keys.X)) {
      const distance = Phaser.Math.Distance.Between(this.controlled.sprite.x, this.ball.x, this.controlled.sprite.y, this.ball.y);
      if (this.possession === 'home' && distance < 48) this.passBall();
      else this.selectControlled();
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.Z)) this.shootBall();
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) this.tackle();
  }

  private updateCpu(dt: number): void {
    const awayPlayers = this.players.filter(p => p.side === 'away');
    const nearest = this.nearestPlayer('away', this.ball.x, this.ball.y);
    awayPlayers.forEach(p => {
      if (p.role === 'GK') {
        this.steerTo(p, FIELD_W - 67, Phaser.Math.Clamp(this.ball.y, FIELD_H / 2 - 36, FIELD_H / 2 + 36), 115, dt);
      } else if (p === nearest) {
        this.steerTo(p, this.ball.x + (this.ball.x < FIELD_W * 0.62 ? 8 : -12), this.ball.y, 143, dt);
        if (Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) < 23 && this.possession !== 'away') {
          this.possession = 'away';
        }
      } else {
        const driftX = Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.18, -58, 58);
        const driftY = Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.13, -38, 38);
        this.steerTo(p, p.homeX + driftX, p.homeY + driftY, 88, dt);
      }
    });

    if (this.possession === 'away' && this.touchLock <= 0) {
      const carrier = nearest;
      const distanceToGoal = FIELD_W - this.ball.x;
      if (Phaser.Math.Distance.Between(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y) < 27) {
        if (distanceToGoal < 300 && Math.abs(this.ball.y - FIELD_H / 2) < 175 && Phaser.Math.Between(0, 100) < 5) {
          const angle = Math.atan2(FIELD_H / 2 - this.ball.y, FIELD_W - 18 - this.ball.x);
          this.kickBall(Math.cos(angle) * 330, Math.sin(angle) * 330, 'away');
        } else if (Phaser.Math.Between(0, 100) < 2) {
          const teammate = awayPlayers.find(p => p !== carrier && p.role !== 'GK')!;
          this.kickBall((teammate.sprite.x - this.ball.x) * 1.7, (teammate.sprite.y - this.ball.y) * 1.7, 'away');
        } else {
          this.ballVx = Math.min(120, this.ballVx + 12);
          this.ballVy += Phaser.Math.Clamp(this.ball.y - carrier.sprite.y, -30, 30) * dt;
          this.lastTouch = 'away';
        }
      }
    }
  }

  /** CPU defenders occasionally dive into a challenge — can win the ball or concede a foul. */
  private updateCpuTackles(dt: number): void {
    if (this.possession !== 'home') return;
    const carrier = this.controlled;
    const defender = this.nearestPlayer('away', carrier.sprite.x, carrier.sprite.y);
    if (defender.cooldown > 0) return;
    const d = Phaser.Math.Distance.Between(defender.sprite.x, defender.sprite.y, carrier.sprite.x, carrier.sprite.y);
    if (d < 20 && Math.random() < dt * 1.1) {
      defender.cooldown = 0.6;
      this.spawnDust(defender.sprite.x, defender.sprite.y);
      this.sfx.kick();
      const win = Math.random() < 0.5;
      if (win) {
        this.possession = 'away';
        this.lastTouch = 'away';
        this.ballVx *= 0.2; this.ballVy *= 0.2;
        this.setMessage('Tackle won by the defender!');
        this.tweens.add({ targets: carrier.sprite, scaleY: 0.6, yoyo: true, duration: 150 });
      } else if (Math.random() < 0.32) {
        this.sfx.whistle();
        this.setMessage('FOUL on the defender!');
        this.awardFreeKick('away', carrier.sprite.x, carrier.sprite.y);
      }
    }
  }

  private movePlayer(p: Footballer, dt: number, userControlled = false): void {
    p.sprite.x = Phaser.Math.Clamp(p.sprite.x + p.vx * dt, 31, FIELD_W - 31);
    p.sprite.y = Phaser.Math.Clamp(p.sprite.y + p.vy * dt, 31, FIELD_H - 31);
    p.shadow.setPosition(p.sprite.x + 3, p.sprite.y + 5);
    p.label.setPosition(p.sprite.x, p.sprite.y);

    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 6) p.facingAngle = Math.atan2(p.vy, p.vx);
    p.facing.setPosition(p.sprite.x + Math.cos(p.facingAngle) * 16, p.sprite.y + Math.sin(p.facingAngle) * 16);
    p.facing.setRotation(p.facingAngle + Math.PI / 2);

    if (userControlled && this.possession === 'home' && this.phase === 'play' && this.touchLock <= 0
      && Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) < 22) {
      this.ball.x = p.sprite.x + (p.vx === 0 ? 13 : Math.sign(p.vx) * 15);
      this.ball.y = p.sprite.y + (p.vy === 0 ? 0 : Math.sign(p.vy) * 8);
      this.ballVx = p.vx * 0.25;
      this.ballVy = p.vy * 0.25;
      this.lastTouch = 'home';
    }
  }

  private steerTo(p: Footballer, x: number, y: number, speed: number, dt: number): void {
    const dx = x - p.sprite.x, dy = y - p.sprite.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 3) {
      p.vx = (dx / distance) * Math.min(speed, distance * 3);
      p.vy = (dy / distance) * Math.min(speed, distance * 3);
    } else { p.vx = 0; p.vy = 0; }
    this.movePlayer(p, dt, false);
  }

  private driftOthers(dt: number, speed = 70): void {
    this.players.forEach(p => {
      if (p === this.setPieceTaker || p === this.penaltyGK || this.setPieceWall.includes(p)) return;
      this.steerTo(p, p.homeX, p.homeY, speed, dt);
    });
  }

  // ---------------------------------------------------------------------
  // Ball physics + out-of-bounds decisions
  // ---------------------------------------------------------------------

  private updateBallPhysics(dt: number): void {
    this.ball.x += this.ballVx * dt;
    this.ball.y += this.ballVy * dt;
    this.ballVx *= Math.pow(0.986, dt * 60);
    this.ballVy *= Math.pow(0.986, dt * 60);

    if (this.penaltyActive && this.penaltyGK) {
      const d = Phaser.Math.Distance.Between(this.ball.x, this.ball.y, this.penaltyGK.sprite.x, this.penaltyGK.sprite.y);
      if (d < 26) {
        this.penaltyActive = false;
        this.ballVx *= -0.3; this.ballVy *= 0.2;
        this.lastTouch = this.penaltyGK.side;
        this.sfx.crowdGroan();
        this.setMessage('SAVED by the keeper!');
      }
    }

    // Goal line checks.
    if (this.ball.x <= 19) {
      if (Math.abs(this.ball.y - FIELD_H / 2) <= GOAL_HALF) { this.score('away'); return; }
      if (this.ball.x <= 15) { this.awardCornerOrGoalKick('home'); return; }
    }
    if (this.ball.x >= FIELD_W - 19) {
      if (Math.abs(this.ball.y - FIELD_H / 2) <= GOAL_HALF) { this.score('home'); return; }
      if (this.ball.x >= FIELD_W - 15) { this.awardCornerOrGoalKick('away'); return; }
    }
    // Touchline checks.
    if (this.ball.y <= 15) { this.awardThrowIn(this.ball.x, 20); return; }
    if (this.ball.y >= FIELD_H - 15) { this.awardThrowIn(this.ball.x, FIELD_H - 20); return; }

    this.ball.y = Phaser.Math.Clamp(this.ball.y, 20, FIELD_H - 20);
    this.ball.x = Phaser.Math.Clamp(this.ball.x, 20, FIELD_W - 20);
    this.ballShadow.setPosition(this.ball.x + 3, this.ball.y + 4);

    if (this.touchLock <= 0 && Math.hypot(this.ballVx, this.ballVy) < 190) {
      const candidates = this.players.filter(p => p.role !== 'GK');
      const closest = candidates.reduce((best, p) =>
        Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) <
        Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, this.ball.x, this.ball.y) ? p : best);
      const d = Phaser.Math.Distance.Between(closest.sprite.x, closest.sprite.y, this.ball.x, this.ball.y);
      if (d < 17 && Math.hypot(this.ballVx, this.ballVy) < 100) {
        this.possession = closest.side;
        this.lastTouch = closest.side;
        if (closest.side === 'home') this.controlled = closest;
        this.ballVx = 0; this.ballVy = 0;
      }
    }
  }

  private updatePossession(): void {
    if (this.possession === 'home') {
      const carrier = this.controlled;
      if (Phaser.Math.Distance.Between(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y) < 32 && Math.hypot(this.ballVx, this.ballVy) < 120) {
        this.ball.x = carrier.sprite.x + (carrier.vx === 0 ? 14 : Math.sign(carrier.vx) * 14);
        this.ball.y = carrier.sprite.y + (carrier.vy === 0 ? 0 : Math.sign(carrier.vy) * 7);
        this.ballVx = carrier.vx * 0.22;
        this.ballVy = carrier.vy * 0.22;
        this.lastTouch = 'home';
      }
    }
    this.ball.setPosition(Phaser.Math.Clamp(this.ball.x, 7, FIELD_W - 7), Phaser.Math.Clamp(this.ball.y, 7, FIELD_H - 7));
  }

  private spinBall(dt: number): void {
    const speed = Math.hypot(this.ballVx, this.ballVy);
    this.ballSpin += speed * dt * 0.05;
    this.ballMark.setPosition(this.ball.x, this.ball.y);
    this.ballMark.setRotation(this.ballSpin);
  }

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  private passBall(): void {
    const teammate = this.players.filter(p => p.side === 'home' && p !== this.controlled && p.role !== 'GK')
      .sort((a, b) => Phaser.Math.Distance.Between(a.sprite.x, a.sprite.y, this.ball.x, this.ball.y) -
        Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, this.ball.x, this.ball.y))[0];
    if (!teammate) return;
    const angle = Math.atan2(teammate.sprite.y - this.ball.y, teammate.sprite.x - this.ball.x);
    this.kickBall(Math.cos(angle) * 250, Math.sin(angle) * 250, 'home');
    this.setMessage('Pass played');
  }

  private shootBall(): void {
    const d = Phaser.Math.Distance.Between(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('Get closer to the ball to shoot');
      return;
    }
    const angle = Math.atan2(FIELD_H / 2 - this.ball.y, FIELD_W - 8 - this.ball.x);
    const power = this.ball.x > FIELD_W * 0.68 ? 390 : 330;
    this.kickBall(Math.cos(angle) * power, Math.sin(angle) * power, 'home');
    this.setMessage('SHOT!');
  }

  /** A proper tackle: lunge animation, contest the ball, risk conceding a foul. */
  private tackle(): void {
    if (this.controlled.cooldown > 0) return;
    this.controlled.cooldown = 0.5;
    const opponent = this.nearestPlayer('away', this.controlled.sprite.x, this.controlled.sprite.y);
    const d = Phaser.Math.Distance.Between(this.controlled.sprite.x, this.controlled.sprite.y, opponent.sprite.x, opponent.sprite.y);
    const angle = Math.atan2(opponent.sprite.y - this.controlled.sprite.y, opponent.sprite.x - this.controlled.sprite.x);

    this.tweens.add({
      targets: this.controlled.sprite,
      x: this.controlled.sprite.x + Math.cos(angle) * 14,
      y: this.controlled.sprite.y + Math.sin(angle) * 14,
      duration: 120, yoyo: true, ease: 'Quad.easeOut',
    });
    this.spawnDust(this.controlled.sprite.x, this.controlled.sprite.y);
    this.sfx.kick();

    if (d > 36) { this.setMessage('No contact — challenge missed'); return; }

    const contestedBall = this.possession === 'away';
    const successChance = contestedBall ? 0.6 : 0.85;
    if (Math.random() < successChance) {
      if (contestedBall) {
        this.possession = 'home';
        this.lastTouch = 'home';
        this.ballVx *= 0.2; this.ballVy *= 0.2;
        this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
        this.tweens.add({ targets: opponent.sprite, scaleY: 0.6, yoyo: true, duration: 150 });
        this.setMessage('Clean tackle!');
      } else {
        this.setMessage('Shoulder to shoulder!');
      }
    } else {
      const foulChance = contestedBall ? 0.4 : 0.15;
      if (Math.random() < foulChance) {
        this.sfx.whistle();
        this.awardFreeKick('home', opponent.sprite.x, opponent.sprite.y);
      } else {
        this.setMessage('Challenge!');
      }
    }
  }

  private kickBall(vx: number, vy: number, side: TeamSide): void {
    this.ballVx = vx; this.ballVy = vy;
    this.possession = null;
    this.lastTouch = side;
    if (side === 'home') this.controlled.cooldown = 0.25;
    this.sfx.kick();
  }

  // ---------------------------------------------------------------------
  // Dead-ball situations
  // ---------------------------------------------------------------------

  private awardCornerOrGoalKick(defendingSide: TeamSide): void {
    if (this.lastTouch === defendingSide || this.lastTouch === null) {
      this.awardCorner(defendingSide === 'home' ? 'away' : 'home');
    } else {
      this.awardGoalKick(defendingSide);
    }
  }

  private awardThrowIn(x: number, y: number): void {
    const side: TeamSide = this.lastTouch === 'home' ? 'away' : 'home';
    this.phase = 'throwin';
    this.phaseTimer = this.inShootout ? 0 : 1.1;
    this.ballVx = 0; this.ballVy = 0;
    const bx = Phaser.Math.Clamp(x, 30, FIELD_W - 30);
    this.ball.setPosition(bx, y);
    this.possession = null;
    this.setPieceSide = side;
    this.sfx.whistle();
    this.setMessage(`${side === 'home' ? HOME_NAME : AWAY_NAME} throw-in`);
    const taker = this.nearestPlayer(side, bx, y);
    taker.sprite.setPosition(bx, y + (y < FIELD_H / 2 ? 14 : -14));
    this.setPieceTaker = taker;
    if (side === 'home') this.controlled = taker;
  }

  private updateThrowIn(dt: number): void {
    this.phaseTimer -= dt;
    this.driftOthers(dt);
    if (this.setPieceSide === 'home') {
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z) || Phaser.Input.Keyboard.JustDown(this.keys.X) || this.phaseTimer <= -2.5) {
        this.executeThrowIn();
      }
    } else if (this.phaseTimer <= 0) {
      this.executeThrowIn();
    }
  }

  private executeThrowIn(): void {
    const taker = this.setPieceTaker!;
    const target = this.players.filter(p => p.side === taker.side && p !== taker && p.role !== 'GK')
      .sort((a, b) => Phaser.Math.Distance.Between(a.sprite.x, a.sprite.y, taker.sprite.x, taker.sprite.y) -
        Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, taker.sprite.x, taker.sprite.y))[0];
    const dir = target ? Math.atan2(target.sprite.y - taker.sprite.y, target.sprite.x - taker.sprite.x)
      : (taker.side === 'home' ? 0 : Math.PI);
    this.ballVx = Math.cos(dir) * 190;
    this.ballVy = Math.sin(dir) * 190;
    this.lastTouch = taker.side;
    this.phase = 'play';
    this.sfx.kick();
    this.checkPendingHalfEnd();
    this.endSetPiece();
  }

  private awardCorner(attackingSide: TeamSide): void {
    this.phase = 'corner';
    this.phaseTimer = 1.3;
    const leftSide = this.ball.x < FIELD_W / 2;
    const topSide = this.ball.y < FIELD_H / 2;
    const cx = leftSide ? 24 : FIELD_W - 24;
    const cy = topSide ? 24 : FIELD_H - 24;
    this.ball.setPosition(cx, cy);
    this.ballVx = 0; this.ballVy = 0;
    this.possession = null;
    this.lastTouch = null;
    this.setPieceSide = attackingSide;
    this.sfx.whistle();
    this.setMessage(`${attackingSide === 'home' ? HOME_NAME : AWAY_NAME} corner kick`);
    const taker = this.nearestPlayer(attackingSide, cx, cy);
    taker.sprite.setPosition(cx, cy);
    this.setPieceTaker = taker;
    if (attackingSide === 'home') this.controlled = taker;
  }

  private updateCorner(dt: number): void {
    this.phaseTimer -= dt;
    this.driftOthers(dt);
    if (this.setPieceSide === 'home') {
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z) || this.phaseTimer <= -2) this.executeCorner();
    } else if (this.phaseTimer <= 0) {
      this.executeCorner();
    }
  }

  private executeCorner(): void {
    const taker = this.setPieceTaker!;
    const goalX = taker.side === 'home' ? FIELD_W - 18 : 18;
    const targetY = FIELD_H / 2 + Phaser.Math.Between(-30, 30);
    const angle = Math.atan2(targetY - taker.sprite.y, goalX - taker.sprite.x);
    this.ballVx = Math.cos(angle) * 260;
    this.ballVy = Math.sin(angle) * 260;
    this.lastTouch = taker.side;
    this.phase = 'play';
    this.sfx.kick();
    this.checkPendingHalfEnd();
    this.endSetPiece();
  }

  private awardGoalKick(defendingSide: TeamSide): void {
    this.phase = 'goalkick';
    this.phaseTimer = 1.2;
    const gx = defendingSide === 'home' ? 50 : FIELD_W - 50;
    this.ball.setPosition(gx, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.possession = null;
    this.lastTouch = null;
    this.setPieceSide = defendingSide;
    this.sfx.whistle();
    this.setMessage(`${defendingSide === 'home' ? HOME_NAME : AWAY_NAME} goal kick`);
    const gk = this.players.find(p => p.side === defendingSide && p.role === 'GK')!;
    gk.sprite.setPosition(gx, FIELD_H / 2);
    this.setPieceTaker = gk;
  }

  private updateGoalKick(dt: number): void {
    this.phaseTimer -= dt;
    if (this.setPieceSide === 'home') {
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z) || this.phaseTimer <= -1.5) this.executeGoalKick();
    } else if (this.phaseTimer <= 0) {
      this.executeGoalKick();
    }
  }

  private executeGoalKick(): void {
    const gk = this.setPieceTaker!;
    const forwardX = gk.side === 'home' ? FIELD_W * 0.55 : FIELD_W * 0.45;
    const targetY = FIELD_H / 2 + Phaser.Math.Between(-90, 90);
    const angle = Math.atan2(targetY - gk.sprite.y, forwardX - gk.sprite.x);
    this.ballVx = Math.cos(angle) * 300;
    this.ballVy = Math.sin(angle) * 300;
    this.lastTouch = gk.side;
    this.phase = 'play';
    this.sfx.kick();
    this.checkPendingHalfEnd();
    this.endSetPiece();
  }

  private awardFreeKick(foulingSide: TeamSide, x: number, y: number): void {
    const side: TeamSide = foulingSide === 'home' ? 'away' : 'home';
    const inOwnBoxLeft = foulingSide === 'home' && x < 137 && Math.abs(y - FIELD_H / 2) < 125;
    const inOwnBoxRight = foulingSide === 'away' && x > FIELD_W - 137 && Math.abs(y - FIELD_H / 2) < 125;
    if (inOwnBoxLeft || inOwnBoxRight) { this.awardPenalty(side); return; }

    this.phase = 'freekick';
    this.phaseTimer = 1.4;
    this.ball.setPosition(Phaser.Math.Clamp(x, 25, FIELD_W - 25), Phaser.Math.Clamp(y, 25, FIELD_H - 25));
    this.ballVx = 0; this.ballVy = 0;
    this.possession = null;
    this.lastTouch = null;
    this.setPieceSide = side;
    this.sfx.whistle();
    this.setMessage(`FOUL! Free kick to ${side === 'home' ? HOME_NAME : AWAY_NAME}`);

    const taker = this.nearestPlayer(side, this.ball.x, this.ball.y);
    taker.sprite.setPosition(this.ball.x, this.ball.y);
    this.setPieceTaker = taker;
    if (side === 'home') this.controlled = taker;

    const goalX = side === 'home' ? FIELD_W - 18 : 18;
    const wallDir = Math.atan2(FIELD_H / 2 - this.ball.y, goalX - this.ball.x);
    const wallDist = 68;
    const wx = this.ball.x + Math.cos(wallDir) * wallDist;
    const wy = this.ball.y + Math.sin(wallDir) * wallDist;
    const defenders = this.players.filter(p => p.side === foulingSide && p.role !== 'GK').slice(0, 3);
    this.setPieceWall = defenders;
    defenders.forEach((p, i) => {
      p.sprite.setPosition(wx + (i - 1) * 14 * Math.sin(wallDir), wy - (i - 1) * 14 * Math.cos(wallDir));
      this.tweens.add({ targets: p.sprite, y: p.sprite.y - 3, yoyo: true, duration: 500, repeat: -1 });
    });
  }

  private updateFreeKick(dt: number): void {
    this.phaseTimer -= dt;
    this.driftOthers(dt);
    if (this.setPieceSide === 'home') {
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z) || this.phaseTimer <= -2) this.executeFreeKick();
    } else if (this.phaseTimer <= 0) {
      this.executeFreeKick();
    }
  }

  private executeFreeKick(): void {
    const taker = this.setPieceTaker!;
    const goalX = taker.side === 'home' ? FIELD_W - 10 : 10;
    const closeRange = Math.abs(taker.sprite.x - goalX) < 260;
    const targetY = closeRange ? FIELD_H / 2 + Phaser.Math.Between(-40, 40) : FIELD_H / 2 + Phaser.Math.Between(-90, 90);
    const angle = Math.atan2(targetY - taker.sprite.y, goalX - taker.sprite.x);
    const power = closeRange ? 360 : 280;
    this.ballVx = Math.cos(angle) * power;
    this.ballVy = Math.sin(angle) * power;
    this.lastTouch = taker.side;
    this.tweens.killTweensOf(this.setPieceWall.map(p => p.sprite));
    this.phase = 'play';
    this.sfx.kick();
    this.checkPendingHalfEnd();
    this.endSetPiece();
  }

  private awardPenalty(side: TeamSide): void {
    this.phase = 'penalty';
    this.phaseTimer = 1.6;
    const px = side === 'home' ? FIELD_W - 90 : 90;
    this.ball.setPosition(px, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.possession = null;
    this.lastTouch = null;
    this.penaltyAim = 0;
    this.penaltyActive = false;
    this.sfx.whistle();
    this.setMessage(this.inShootout ? `${side === 'home' ? HOME_NAME : AWAY_NAME} steps up...` : 'PENALTY!');

    const taker = this.nearestPlayer(side, px, FIELD_H / 2);
    taker.sprite.setPosition(px - (side === 'home' ? 20 : -20), FIELD_H / 2);
    this.setPieceTaker = taker;
    this.setPieceSide = side;
    if (side === 'home') this.controlled = taker;

    const gkSide: TeamSide = side === 'home' ? 'away' : 'home';
    const gk = this.players.find(p => p.side === gkSide && p.role === 'GK')!;
    const goalX = gkSide === 'home' ? 30 : FIELD_W - 30;
    gk.sprite.setPosition(goalX, FIELD_H / 2);
    this.penaltyGK = gk;

    this.players.filter(p => p !== taker && p !== gk).forEach(p => {
      p.sprite.setPosition(FIELD_W / 2 + (p.side === 'home' ? -1 : 1) * Phaser.Math.Between(90, 150), FIELD_H / 2 + Phaser.Math.Between(-90, 90));
      p.vx = 0; p.vy = 0;
    });
  }

  private updatePenalty(dt: number): void {
    this.phaseTimer -= dt;
    if (this.setPieceSide === 'home') {
      const up = this.keys.W.isDown || this.keys.UP.isDown;
      const down = this.keys.S.isDown || this.keys.DOWN.isDown;
      if (up) this.penaltyAim = Phaser.Math.Clamp(this.penaltyAim - dt * 2, -1, 1);
      if (down) this.penaltyAim = Phaser.Math.Clamp(this.penaltyAim + dt * 2, -1, 1);
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z) || this.phaseTimer <= -2.5) {
        this.firePenalty(this.penaltyAim, 'home');
      }
    } else if (this.phaseTimer <= 0) {
      this.firePenalty(Phaser.Math.FloatBetween(-1, 1), 'away');
    }
  }

  private firePenalty(offsetY: number, side: TeamSide): void {
    const goalX = side === 'home' ? FIELD_W - 10 : 10;
    const targetY = FIELD_H / 2 + Phaser.Math.Clamp(offsetY, -1, 1) * 42;
    const angle = Math.atan2(targetY - this.ball.y, goalX - this.ball.x);
    this.ballVx = Math.cos(angle) * 520;
    this.ballVy = Math.sin(angle) * 520;
    this.lastTouch = side;

    const gk = this.penaltyGK!;
    const diveY = FIELD_H / 2 + Phaser.Math.Between(-1, 1) * 42;
    this.tweens.add({ targets: gk.sprite, y: diveY, duration: 260, ease: 'Cubic.easeOut' });

    this.penaltyActive = true;
    this.time.delayedCall(650, () => { this.penaltyActive = false; });

    this.sfx.kick();
    this.phase = 'play';
    this.checkPendingHalfEnd();
    this.endSetPiece();

    if (this.inShootout) {
      // In a shootout we judge the outcome shortly after impact rather than relying on open play.
      this.time.delayedCall(750, () => this.resolveShootoutKick(side));
    }
  }

  private endSetPiece(): void {
    this.setPieceTaker = null;
    this.setPieceWall = [];
    this.setPieceSide = null;
  }

  private checkPendingHalfEnd(): void {
    if (this.pendingHalfEnd) { this.pendingHalfEnd = false; this.endHalf(); }
  }

  // ---------------------------------------------------------------------
  // Goals, celebration, breaks, extra time, shootout
  // ---------------------------------------------------------------------

  private score(side: TeamSide): void {
    if (side === 'home') this.homeScore++; else this.awayScore++;
    this.lastScorer = side;
    this.sfx.crowdCheer(true);
    this.startCelebration(side);
  }

  private startCelebration(side: TeamSide): void {
    this.phase = 'goal';
    this.phaseTimer = 3.2;
    this.ballVx = 0; this.ballVy = 0;
    this.setMessage(side === 'home' ? `GOAL! ${HOME_NAME} find the net!` : `GOAL! ${AWAY_NAME} hit back!`);
    this.showBigText('GOAL!', side === 'home' ? 0x3aa9ff : 0xff5a5f);
    this.flashScreen(side === 'home' ? 0x3aa9ff : 0xff5a5f);
    this.spawnConfetti();
    this.pulseCrowd();

    const scorers = this.players.filter(p => p.side === side && p.role !== 'GK').slice(0, 3);
    scorers.forEach((p, i) => {
      const targetX = side === 'home' ? FIELD_W * 0.75 : FIELD_W * 0.25;
      const targetY = FIELD_H / 2 + (i - 1) * 30;
      this.tweens.add({ targets: p.sprite, x: targetX, y: targetY, duration: 700, ease: 'Sine.easeOut' });
      this.tweens.add({ targets: p.sprite, scale: 1.3, yoyo: true, repeat: 3, duration: 220, delay: 700 });
    });
  }

  private updateGoalCelebration(dt: number): void {
    this.phaseTimer -= dt;
    if (this.phaseTimer <= 0) {
      this.players.forEach(p => p.sprite.setScale(1));
      this.kickoff(this.lastScorer === 'home' ? 'away' : 'home');
    }
  }

  private endHalf(): void {
    if (!this.isExtraTime && this.half === 1) {
      this.half = 2;
      this.remaining = HALF_SECONDS;
      this.startBreak('halftime', 'Half-time!', () => this.kickoff('away'));
    } else if (!this.isExtraTime && this.half === 2) {
      this.finishRegulation();
    } else if (this.isExtraTime && this.extraHalf === 1) {
      this.extraHalf = 2;
      this.remaining = EXTRA_HALF_SECONDS;
      this.startBreak('halftime', 'End of first extra period', () => this.kickoff('away'));
    } else if (this.isExtraTime && this.extraHalf === 2) {
      this.finishExtraTime();
    }
  }

  private finishRegulation(): void {
    if (this.homeScore !== this.awayScore) { this.endMatch(); return; }
    this.startBreak('fulltime', 'Full-time — scores level! Extra time!', () => this.startExtraTime());
  }

  private finishExtraTime(): void {
    if (this.homeScore !== this.awayScore) { this.endMatch(); return; }
    this.startBreak('fulltime', 'Still level after extra time — penalties!', () => this.startShootout());
  }

  private startBreak(phase: Phase, message: string, callback: () => void): void {
    this.phase = phase;
    this.phaseTimer = 3;
    this.breakCallback = callback;
    this.setMessage(message);
    this.sfx.whistle();
  }

  private updateBreak(dt: number): void {
    this.phaseTimer -= dt;
    if (this.phaseTimer <= 0) {
      const cb = this.breakCallback;
      this.breakCallback = null;
      cb?.();
    }
  }

  private startExtraTime(): void {
    this.isExtraTime = true;
    this.extraHalf = 1;
    this.remaining = EXTRA_HALF_SECONDS;
    this.setMessage('Extra time — kick-off!');
    this.kickoff('home');
  }

  private endMatch(): void {
    this.phase = 'matchend';
    this.setMessage(this.homeScore === this.awayScore
      ? 'Full-time — it ends level!'
      : this.homeScore > this.awayScore ? `Full-time — ${HOME_NAME} win!` : `Full-time — ${AWAY_NAME} win!`);
    this.showBigText('FULL-TIME', 0xffffff);
    if (this.hint) {
      this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN';
      this.hint.style.display = 'block';
    }
  }

  // --- Penalty shootout -------------------------------------------------

  private startShootout(): void {
    this.inShootout = true;
    this.phase = 'shootout';
    this.shootoutHome = [];
    this.shootoutAway = [];
    this.shootoutTurn = 'home';
    this.shootoutText = this.add.text(FIELD_W / 2, 40, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '18px', color: '#fff7df', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(60);
    this.setMessage(`Penalty shootout!');
