import Phaser from 'phaser';
import './style.css';

const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_TIME_SECONDS = 60;

type TeamSide = 'home' | 'away';
type GameState =
  | 'kickoff'
  | 'playing'
  | 'goal'
  | 'throw-in'
  | 'corner'
  | 'freekick'
  | 'penalty'
  | 'goalkick'
  | 'halftime'
  | 'fulltime'
  | 'extratime';

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
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

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
  private lastClockTick = 0;
  private half = 1;
  private paused = true;
  private pauseKeyHeld = false;
  private ended = false;
  private kickoffLock = 0;
  private state: GameState = 'kickoff';
  private setPieceTaker: TeamSide | null = null;
  private setPieceTimer = 0;
  private goalScored = false; // <-- KEY FIX: prevents double-scoring
  private message = 'Ready for kick-off';
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
        this.audioCtx = new (
          window.AudioContext ||
          (window as any).webkitAudioContext
        )();
      }
      if (this.ended) this.resetMatch();
      this.paused = false;
      if (this.hint) this.hint.style.display = 'none';
      this.setMessage('Play on!');
    });
    document
      .getElementById('restart-button')
      ?.addEventListener('click', () => this.resetMatch());
    this.selectControlled();
    this.updateHud();
    this.setMessage('Ready for kick-off');
  }

  // ═══════════════ GRAPHICS ═══════════════

  private drawPitch(): void {
    const g = this.add.graphics();
    g.setDepth(0);

    // Pitch with alternating stripes
    for (let i = 0; i < 12; i++) {
      const shade = i % 2 === 0 ? 0x1f7a52 : 0x1a6846;
      g.fillStyle(shade, 1);
      g.fillRect(i * (FIELD_W / 12), 0, FIELD_W / 12, FIELD_H);
    }

    // Crowd stands
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

    // Field lines
    g.lineStyle(3, 0xffffff, 0.95);
    g.strokeRect(19, 19, FIELD_W - 38, FIELD_H - 38);
    g.lineBetween(FIELD_W / 2, 19, FIELD_W / 2, FIELD_H - 19);
    g.strokeCircle(FIELD_W / 2, FIELD_H / 2, 67);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W / 2, FIELD_H / 2, 4);

    // Penalty areas
    g.strokeRect(19, 135, 118, 250);
    g.strokeRect(19, 190, 49, 140);
    g.strokeRect(FIELD_W - 137, 135, 118, 250);
    g.strokeRect(FIELD_W - 68, 190, 49, 140);

    // Penalty spots
    g.fillStyle(0xffffff, 1).fillCircle(112, FIELD_H / 2, 3);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W - 112, FIELD_H / 2, 3);

    // Penalty arcs
    g.beginPath();
    g.arc(112, FIELD_H / 2, 40, -0.9, 0.9);
    g.strokePath();
    g.beginPath();
    g.arc(FIELD_W - 112, FIELD_H / 2, 40, Math.PI - 0.9, Math.PI + 0.9);
    g.strokePath();

    // Corner arcs
    const cr = 10;
    g.beginPath(); g.arc(19, 19, cr, 0, Math.PI / 2); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, 19, cr, Math.PI / 2, Math.PI); g.strokePath();
    g.beginPath(); g.arc(19, FIELD_H - 19, cr, -Math.PI / 2, 0); g.strokePath();
    g.beginPath(); g.arc(FIELD_W - 19, FIELD_H - 19, cr, Math.PI, 1.5 * Math.PI); g.strokePath();

    // Goals with nets
    this.drawGoal(g, 0, FIELD_H / 2 - 52, true);
    this.drawGoal(g, FIELD_W - 22, FIELD_H / 2 - 52, false);

    // Corner flags
    this.drawCornerFlag(22, 22);
    this.drawCornerFlag(FIELD_W - 22, 22);
    this.drawCornerFlag(22, FIELD_H - 22);
    this.drawCornerFlag(FIELD_W - 22, FIELD_H - 22);
  }

  private drawGoal(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    left: boolean
  ): void {
    g.fillStyle(0xffffff, 1);
    g.fillRect(x, y, 22, 4);
    g.fillRect(x, y + 100, 22, 4);
    g.fillStyle(0xdddddd, 1);
    g.fillRect(left ? x : x + 20, y, 2, 104);
    g.lineStyle(1, 0xf0f0f0, 0.5);
    for (let i = 4; i < 20; i += 4) {
      g.lineBetween(x + i, y + 4, x + i, y + 100);
    }
    for (let j = 10; j < 100; j += 10) {
      g.lineBetween(x + 2, y + j, x + 20, y + j);
    }
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
      .setDepth(50)
      .setAlpha(0);

    this.goalText = this.add
      .text(FIELD_W / 2, FIELD_H / 2 - 20, '', {
        fontFamily: 'Impact, Arial Black, sans-serif',
        fontSize: '80px',
        color: '#ffd23f',
        stroke: '#000000',
        strokeThickness: 8,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(51)
      .setAlpha(0);

    this.goalSubText = this.add
      .text(FIELD_W / 2, FIELD_H / 2 + 40, '', {
        fontFamily: 'Barlow Condensed, Arial Black, sans-serif',
        fontSize: '28px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(51)
      .setAlpha(0);
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

  private addPlayer(
    side: TeamSide,
    x: number,
    y: number,
    role: Footballer['role'],
    number: number
  ): void {
    const isGK = role === 'GK';
    const bodyColor =
      isGK
        ? side === 'home' ? 0x9b59b6 : 0xff9800
        : side === 'home' ? 0x2d7fff : 0xff3b47;
    const shortsColor =
      isGK
        ? 0x333333
        : side === 'home' ? 0x0a4fb5 : 0xb01822;
    const skinColor = 0xf4c892;

    const container = this.add.container(x, y).setDepth(20);
    const shadow = this.add
      .ellipse(x + 2, y + 10, isGK ? 22 : 20, isGK ? 10 : 9, 0x000000, 0.3)
      .setDepth(15);

    const shorts = this.add
      .rectangle(0, 6, isGK ? 14 : 12, 5, shortsColor)
      .setOrigin(0.5);
    const body = this.add
      .circle(0, 0, isGK ? 11 : 10, bodyColor, 1)
      .setStrokeStyle(2, 0xffffff);
    const head = this.add
      .circle(0, -8, 5, skinColor, 1)
      .setStrokeStyle(1, 0x2a1810);
    const hair = this.add.arc(0, -10, 5, 180, 360, false, 0x3a2418);

    container.add([shorts, body, head, hair]);

    const label = this.add
      .text(0, 0, String(number), {
        fontFamily: 'Arial Black, sans-serif',
        fontSize: '9px',
        color: '#ffffff',
        stroke: '#000',
        strokeThickness: 2,
      })
      .setOrigin(0.5);
    container.add(label);

    const player: Footballer = {
      sprite: container,
      body,
      head,
      shorts,
      shadow,
      label,
      side,
      role,
      homeX: x,
      homeY: y,
      vx: 0,
      vy: 0,
      number,
      cooldown: 0,
      celebrating: false,
      celebrateUntil: 0,
      tackling: 0,
      facing: side === 'home' ? 0 : Math.PI,
    };
    this.players.push(player);
  }

  private createBall(): void {
    this.ballShadow = this.add
      .ellipse(FIELD_W / 2 + 2, FIELD_H / 2 + 6, 14, 6, 0x000000, 0.4)
      .setDepth(12);
    this.ball = this.add
      .circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 1)
      .setStrokeStyle(1.5, 0x111111)
      .setDepth(30);
    this.ballInner = this.add
      .circle(FIELD_W / 2, FIELD_H / 2, 2, 0x111111)
      .setDepth(31);
  }

  // ═══════════════ UPDATE LOOP ═══════════════

  update(time: number, delta: number): void {
    // Pause toggle
    if (this.keys.P.isDown && !this.pauseKeyHeld) {
      this.paused = !this.paused;
      this.pauseKeyHeld = true;
      this.setMessage(
        this.paused ? 'Paused — press P to resume' : 'Play on!'
      );
    }
    if (this.keys.P.isUp) this.pauseKeyHeld = false;
    if (this.keys.ENTER.isDown && this.ended) this.resetMatch();
    if (this.paused || this.ended) return;

    const dt = Math.min(delta / 1000, 0.035);

    // Clock — don't tick during goal celebration
    if (
      time - this.lastClockTick >= 1000 &&
      this.state !== 'goal' &&
      this.state !== 'halftime'
    ) {
      this.lastClockTick = time;
      this.remaining = Math.max(0, this.remaining - 1);
      this.updateHud();
      if (this.remaining === 0) this.handlePeriodEnd();
    }

    this.kickoffLock = Math.max(0, this.kickoffLock - dt);
    this.setPieceTimer = Math.max(0, this.setPieceTimer - dt);

    // Update celebrations
    this.players.forEach((p) => {
      if (p.celebrating && time > p.celebrateUntil) {
        p.celebrating = false;
      }
      if (p.cooldown > 0) p.cooldown -= dt;
    });

    // Set piece input
    if (
      this.state === 'throw-in' ||
      this.state === 'corner' ||
      this.state === 'freekick' ||
      this.state === 'penalty' ||
      this.state === 'goalkick'
    ) {
      if (
        this.setPieceTaker === 'home' &&
        Phaser.Input.Keyboard.JustDown(this.keys.C)
      ) {
        this.takeSetPiece();
      } else if (this.setPieceTaker === 'away' && this.setPieceTimer <= 0) {
        this.takeSetPiece();
      }
      // Don't run normal play logic during set piece setup
      this.updateParticles(dt);
      this.updateCamera(dt);
      this.updateHud();
      return;
    }

    // Goal state — just animate, don't process gameplay
    if (this.state === 'goal') {
      this.updateParticles(dt);
      this.updateCamera(dt);
      this.updateHud();
      return;
    }

    this.updateUser(dt);
    this.updateCpu(dt);
    this.updateBall(dt);
    this.updatePossession();
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.updateHud();

    // Ball visual updates
    this.ballInner.setPosition(
      this.ball.x + Math.cos(this.ballSpin) * 2,
      this.ball.y - this.ballHeight + Math.sin(this.ballSpin) * 2
    );
    this.ball.setScale(1 + this.ballHeight * 0.01);
  }

  private handlePeriodEnd(): void {
    if (this.half === 1) {
      this.half = 2;
      this.remaining = HALF_SECONDS;
      this.state = 'halftime';
      this.kickoff();
      this.setMessage('⚽ HALF-TIME! Second half begins');
    } else if (this.half === 2) {
      if (this.homeScore === this.awayScore) {
        this.half = 3;
        this.remaining = EXTRA_TIME_SECONDS;
        this.kickoff();
        this.flashScreen(0xffd23f, 0.3);
        this.setMessage('⏱ EXTRA TIME! Golden goal period');
      } else {
        this.endMatch();
      }
    } else {
      this.endMatch();
    }
  }

  private endMatch(): void {
    this.ended = true;
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

  // ═══════════════ USER INPUT ═══════════════

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
    if (dx !== 0 || dy !== 0) {
      this.controlled.facing = Math.atan2(dy, dx);
    }

    this.movePlayer(this.controlled, dt, true);

    // Teammate AI support positioning
    this.players
      .filter((p) => p.side === 'home' && p !== this.controlled && !p.celebrating)
      .forEach((p) => {
        if (p.role === 'GK') {
          this.steerTo(
            p,
            67,
            Phaser.Math.Clamp(this.ball.y, FIELD_H / 2 - 36, FIELD_H / 2 + 36),
            115,
            dt
          );
        } else {
          const supportX =
            p.homeX +
            Phaser.Math.Clamp(
              (this.ball.x - FIELD_W / 2) * 0.14,
              -45,
              45
            );
          const supportY =
            p.homeY +
            Phaser.Math.Clamp(
              (this.ball.y - FIELD_H / 2) * 0.1,
              -35,
              35
            );
          this.steerTo(p, supportX, supportY, 110, dt);
        }
      });

    if (Phaser.Input.Keyboard.JustDown(this.keys.X)) {
      const distance = Phaser.Math.Distance.Between(
        this.controlled.sprite.x,
        this.controlled.sprite.y,
        this.ball.x,
        this.ball.y
      );
      if (this.possession === 'home' && distance < 48) this.passBall();
      else this.selectControlled();
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.Z)) this.shootBall();
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) this.tackle();
  }

  // ═══════════════ CPU AI ═══════════════

  private updateCpu(dt: number): void {
    const awayPlayers = this.players.filter((p) => p.side === 'away');
    const nearest = this.nearestPlayer('away', this.ball.x, this.ball.y);

    awayPlayers.forEach((p) => {
      if (p.celebrating) {
        p.vx = 0;
        p.vy = 0;
        return;
      }
      if (p.role === 'GK') {
        this.steerTo(
          p,
          FIELD_W - 67,
          Phaser.Math.Clamp(
            this.ball.y,
            FIELD_H / 2 - 36,
            FIELD_H / 2 + 36
          ),
          115,
          dt
        );
      } else if (p === nearest) {
        this.steerTo(
          p,
          this.ball.x + (this.ball.x < FIELD_W * 0.62 ? 8 : -12),
          this.ball.y,
          150,
          dt
        );
        const d = Phaser.Math.Distance.Between(
          p.sprite.x,
          p.sprite.y,
          this.ball.x,
          this.ball.y
        );
        if (d < 23 && this.possession !== 'away') {
          if (
            this.possession === 'home' &&
            Phaser.Math.Between(0, 100) < 20
          ) {
            p.tackling = 0.3;
            this.playSound('tackle');
            this.possession = 'away';
            this.lastTouch = 'away';
            this.spawnDustParticles(this.ball.x, this.ball.y);
            this.setMessage('Ball won by Comets!');
          } else if (this.possession === null) {
            this.possession = 'away';
            this.lastTouch = 'away';
          }
        }
      } else {
        const driftX = Phaser.Math.Clamp(
          (this.ball.x - FIELD_W / 2) * 0.18,
          -58,
          58
        );
        const driftY = Phaser.Math.Clamp(
          (this.ball.y - FIELD_H / 2) * 0.13,
          -38,
          38
        );
        this.steerTo(p, p.homeX + driftX, p.homeY + driftY, 88, dt);
      }
    });

    // CPU attacking logic
    if (this.possession === 'away' && this.kickoffLock <= 0) {
      const carrier = nearest;
      const d = Phaser.Math.Distance.Between(
        carrier.sprite.x,
        carrier.sprite.y,
        this.ball.x,
        this.ball.y
      );
      if (d < 27) {
        const distToGoal = this.ball.x;
        if (
          distToGoal < 300 &&
          Math.abs(this.ball.y - FIELD_H / 2) < 175 &&
          Phaser.Math.Between(0, 100) < 4
        ) {
          const angle = Math.atan2(
            FIELD_H / 2 - this.ball.y,
            18 - this.ball.x
          );
          this.kickBall(
            Math.cos(angle) * 340,
            Math.sin(angle) * 340,
            'away',
            40
          );
          this.playSound('shoot');
          this.setMessage('Shot from Comets!');
        } else if (Phaser.Math.Between(0, 100) < 2) {
          const teammate = awayPlayers.find(
            (p) => p !== carrier && p.role !== 'GK'
          );
          if (teammate) {
            this.kickBall(
              (teammate.sprite.x - this.ball.x) * 1.7,
              (teammate.sprite.y - this.ball.y) * 1.7,
              'away',
              15
            );
          }
        } else {
          // Dribble toward home goal
          this.ballVx = Math.max(-140, this.ballVx - 8);
          this.ballVy +=
            Phaser.Math.Clamp(
              carrier.sprite.y - this.ball.y,
              -30,
              30
            ) * dt * -1;
        }
      }
    }
  }

  // ═══════════════ MOVEMENT ═══════════════

  private movePlayer(
    p: Footballer,
    dt: number,
    userControlled = false
  ): void {
    const newX = Phaser.Math.Clamp(p.sprite.x + p.vx * dt, 31, FIELD_W - 31);
    const newY = Phaser.Math.Clamp(p.sprite.y + p.vy * dt, 31, FIELD_H - 31);
    p.sprite.setPosition(newX, newY);
    p.shadow.setPosition(newX + 2, newY + 10);

    // Tackle animation
    if (p.tackling > 0) {
      p.tackling -= dt;
      p.sprite.setRotation(p.facing + Math.PI / 4);
      p.sprite.setScale(1.1, 0.9);
    } else if (p.celebrating) {
      // Bounce while celebrating
      const bounce = Math.sin(this.time.now * 0.015) * 2;
      p.sprite.setY(newY + bounce);
    } else {
      p.sprite.setRotation(0);
      p.sprite.setScale(1, 1);
      // Walking bob
      if (Math.abs(p.vx) > 5 || Math.abs(p.vy) > 5) {
        p.sprite.setY(newY + Math.sin(this.time.now * 0.02) * 0.4);
      }
    }

    // Carry ball when user has possession
    if (
      userControlled &&
      this.possession === 'home' &&
      this.state === 'playing' &&
      this.kickoffLock <= 0 &&
      p.cooldown <= 0
    ) {
      const d = Phaser.Math.Distance.Between(
        p.sprite.x,
        p.sprite.y,
        this.ball.x,
        this.ball.y
      );
      if (d < 22) {
        this.ball.x = p.sprite.x + Math.cos(p.facing) * 15;
        this.ball.y = p.sprite.y + Math.sin(p.facing) * 15;
        this.ballVx = p.vx * 0.25;
        this.ballVy = p.vy * 0.25;
        this.lastTouch = 'home';
      }
    }
  }

  private steerTo(
    p: Footballer,
    x: number,
    y: number,
    speed: number,
    dt: number
  ): void {
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

  // ═══════════════ BALL PHYSICS ═══════════════

  private updateBall(dt: number): void {
    // Move ball
    this.ball.x += this.ballVx * dt;
    this.ball.y += this.ballVy * dt;

    // Vertical physics
    this.ballHeight += this.ballVz * dt;
    this.ballVz -= 400 * dt;
    if (this.ballHeight < 0) {
      this.ballHeight = 0;
      this.ballVz = this.ballVz < -30 ? this.ballVz * -0.4 : 0;
    }

    // Friction
    const friction = this.ballHeight > 1 ? 0.997 : 0.986;
    this.ballVx *= Math.pow(friction, dt * 60);
    this.ballVy *= Math.pow(friction, dt * 60);

    // Ball spin visual
    this.ballSpin += Math.hypot(this.ballVx, this.ballVy) * dt * 0.05;

    // ─── BOUNDARY CHECKS ───
    // Only check boundaries when playing and not already scored
    if (this.state === 'playing' && !this.goalScored && this.kickoffLock <= 0) {
      // Touchline (top/bottom) -> throw in
      if (this.ball.y < 19) {
        this.ball.y = 25;
        this.ballVx = 0;
        this.ballVy = 0;
        this.throwIn(this.ball.x, 30);
        return;
      }
      if (this.ball.y > FIELD_H - 19) {
        this.ball.y = FIELD_H - 25;
        this.ballVx = 0;
        this.ballVy = 0;
        this.throwIn(this.ball.x, FIELD_H - 30);
        return;
      }

      // Goal line — left side
      if (this.ball.x < 19) {
        if (Math.abs(this.ball.y - FIELD_H / 2) <= 52) {
          // GOAL for away team (scored in home goal)
          this.scoreGoal('away');
          return;
        } else {
          // Out on goal line
          this.ball.x = 25;
          this.ballVx = 0;
          this.ballVy = 0;
          if (this.lastTouch === 'home') {
            this.cornerKick('away', 'left');
          } else {
            this.goalKick('home');
          }
          return;
        }
      }

      // Goal line — right side
      if (this.ball.x > FIELD_W - 19) {
        if (Math.abs(this.ball.y - FIELD_H / 2) <= 52) {
          // GOAL for home team (scored in away goal)
          this.scoreGoal('home');
          return;
        } else {
          this.ball.x = FIELD_W - 25;
          this.ballVx = 0;
          this.ballVy = 0;
          if (this.lastTouch === 'away') {
            this.cornerKick('home', 'right');
          } else {
            this.goalKick('away');
          }
          return;
        }
      }
    }

    // Clamp ball position during play
    this.ball.x = Phaser.Math.Clamp(this.ball.x, 5, FIELD_W - 5);
    this.ball.y = Phaser.Math.Clamp(this.ball.y, 5, FIELD_H - 5);

    // Ball collection by nearest player
    if (
      this.kickoffLock <= 0 &&
      this.state === 'playing' &&
      Math.hypot(this.ballVx, this.ballVy) < 190 &&
      this.ballHeight < 5
    ) {
      const candidates = this.players.filter(
        (p) => !p.celebrating && p.cooldown <= 0
      );
      if (candidates.length > 0) {
        const closest = candidates.reduce((best, p) =>
          Phaser.Math.Distance.Between(
            p.sprite.x,
            p.sprite.y,
            this.ball.x,
            this.ball.y
          ) <
          Phaser.Math.Distance.Between(
            best.sprite.x,
            best.sprite.y,
            this.ball.x,
            this.ball.y
          )
            ? p
            : best
        );
        const d = Phaser.Math.Distance.Between(
          closest.sprite.x,
          closest.sprite.y,
          this.ball.x,
          this.ball.y
        );
        if (d < 17 && Math.hypot(this.ballVx, this.ballVy) < 100) {
          this.possession = closest.side;
          this.lastTouch = closest.side;
          if (closest.side === 'home') this.controlled = closest;
          this.ballVx = 0;
          this.ballVy = 0;
        }
      }
    }

    // Shadow position
    this.ballShadow.setPosition(
      this.ball.x + 2 + this.ballHeight * 0.15,
      this.ball.y + 6 + this.ballHeight * 0.1
    );
    this.ballShadow.setScale(
      1 - Math.min(0.5, this.ballHeight * 0.015)
    );
  }

  private updatePossession(): void {
    if (this.possession === 'home' && this.state === 'playing') {
      const carrier = this.controlled;
      const d = Phaser.Math.Distance.Between(
        carrier.sprite.x,
        carrier.sprite.y,
        this.ball.x,
        this.ball.y
      );
      if (d < 32 && Math.hypot(this.ballVx, this.ballVy) < 120) {
        this.ball.x =
          carrier.sprite.x + Math.cos(carrier.facing) * 14;
        this.ball.y =
          carrier.sprite.y + Math.sin(carrier.facing) * 14;
        this.ballVx = carrier.vx * 0.22;
        this.ballVy = carrier.vy * 0.22;
        this.lastTouch = 'home';
      }
    }
  }

  // ═══════════════ ACTIONS ═══════════════

  private passBall(): void {
    const teammates = this.players
      .filter(
        (p) =>
          p.side === 'home' &&
          p !== this.controlled &&
          p.role !== 'GK'
      )
      .sort(
        (a, b) =>
          Phaser.Math.Distance.Between(
            a.sprite.x,
            a.sprite.y,
            this.ball.x,
            this.ball.y
          ) -
          Phaser.Math.Distance.Between(
            b.sprite.x,
            b.sprite.y,
            this.ball.x,
            this.ball.y
          )
      );
    const teammate = teammates[0];
    if (!teammate) return;
    const angle = Math.atan2(
      teammate.sprite.y - this.ball.y,
      teammate.sprite.x - this.ball.x
    );
    this.kickBall(
      Math.cos(angle) * 260,
      Math.sin(angle) * 260,
      'home',
      10
    );
    this.playSound('pass');
    this.setMessage('→ Pass played');
  }

  private shootBall(): void {
    const d = Phaser.Math.Distance.Between(
      this.controlled.sprite.x,
      this.controlled.sprite.y,
      this.ball.x,
      this.ball.y
    );
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('⚠ Get closer to shoot');
      return;
    }
    const targetY =
      FIELD_H / 2 + Phaser.Math.Between(-30, 30);
    const angle = Math.atan2(
      targetY - this.ball.y,
      FIELD_W - 8 - this.ball.x
    );
    const power = this.ball.x > FIELD_W * 0.65 ? 430 : 350;
    this.kickBall(
      Math.cos(angle) * power,
      Math.sin(angle) * power,
      'home',
      50
    );
    this.playSound('shoot');
    this.setMessage('💥 SHOT!');
    this.cameraShake = 0.12;
  }

  private tackle(): void {
    this.controlled.tackling = 0.3;
    const opponent = this.nearestPlayer(
      'away',
      this.controlled.sprite.x,
      this.controlled.sprite.y
    );
    const d = Phaser.Math.Distance.Between(
      this.controlled.sprite.x,
      this.controlled.sprite.y,
      opponent.sprite.x,
      opponent.sprite.y
    );
    const ballDist = Phaser.Math.Distance.Between(
      this.controlled.sprite.x,
      this.controlled.sprite.y,
      this.ball.x,
      this.ball.y
    );

    this.playSound('tackle');
    this.spawnDustParticles(
      this.controlled.sprite.x,
      this.controlled.sprite.y + 8
    );

    if (ballDist < 35 && this.possession === 'away') {
      // Successful tackle
      this.possession = 'home';
      this.lastTouch = 'home';
      this.selectControlled();
      this.ballVx *= -0.3;
      this.ballVy *= -0.3;
      this.setMessage('✓ Clean tackle!');
    } else if (d < 37) {
      // Risky challenge — foul chance
      if (Phaser.Math.Between(0, 100) < 35) {
        this.setMessage('⚑ FOUL! Free kick awarded');
        this.freeKick('away', opponent.sprite.x, opponent.sprite.y);
      } else {
        this.setMessage('Challenge missed!');
      }
    } else {
      this.setMessage('Missed tackle');
    }
  }

  private kickBall(
    vx: number,
    vy: number,
    side: TeamSide,
    lift = 10
  ): void {
    this.ballVx = vx;
    this.ballVy = vy;
    this.ballVz = lift;
    this.possession = null;
    this.lastTouch = side;
    if (side === 'home') this.controlled.cooldown = 0.25;
  }

  // ═══════════════ SET PIECES ═══════════════

  private throwIn(x: number, y: number): void {
    this.state = 'throw-in';
    this.setPieceTaker = this.lastTouch === 'home' ? 'away' : 'home';
    this.ball.setPosition(Phaser.Math.Clamp(x, 40, FIELD_W - 40), y);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = this.setPieceTaker;
    this.setPieceTimer = 2;
    const nearest = this.nearestPlayer(
      this.setPieceTaker,
      this.ball.x,
      this.ball.y
    );
    if (this.setPieceTaker === 'home') this.controlled = nearest;
    this.setMessage(
      `🙌 THROW-IN: ${this.setPieceTaker === 'home' ? 'Rockets' : 'Comets'}${
        this.setPieceTaker === 'home' ? ' — press C' : ''
      }`
    );
  }

  private cornerKick(taker: TeamSide, side: 'left' | 'right'): void {
    this.state = 'corner';
    this.setPieceTaker = taker;
    const cx = side === 'left' ? 22 : FIELD_W - 22;
    const cy = this.ball.y < FIELD_H / 2 ? 22 : FIELD_H - 22;
    this.ball.setPosition(cx, cy);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = taker;
    this.setPieceTimer = 2.5;
    if (taker === 'home') {
      const nearest = this.nearestPlayer(taker, cx, cy);
      this.controlled = nearest;
    }
    this.setMessage(
      `🚩 CORNER: ${taker === 'home' ? 'Rockets' : 'Comets'}${
        taker === 'home' ? ' — press C' : ''
      }`
    );
  }

  private goalKick(taker: TeamSide): void {
    this.state = 'goalkick';
    this.setPieceTaker = taker;
    const x = taker === 'home' ? 55 : FIELD_W - 55;
    this.ball.setPosition(x, FIELD_H / 2);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = taker;
    this.setPieceTimer = 2;
    if (taker === 'home') {
      const gk = this.players.find(
        (p) => p.side === taker && p.role === 'GK'
      )!;
      this.controlled = gk;
    }
    this.setMessage(
      `🥅 GOAL KICK: ${taker === 'home' ? 'Rockets' : 'Comets'}`
    );
  }

  private freeKick(
    taker: TeamSide,
    x: number,
    y: number
  ): void {
    // Check if in penalty box
    const inHomeBox = x < 137 && Math.abs(y - FIELD_H / 2) < 125;
    const inAwayBox =
      x > FIELD_W - 137 && Math.abs(y - FIELD_H / 2) < 125;

    if (
      (taker === 'home' && inAwayBox) ||
      (taker === 'away' && inHomeBox)
    ) {
      this.penalty(taker);
      return;
    }

    this.state = 'freekick';
    this.setPieceTaker = taker;
    this.ball.setPosition(x, y);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = taker;
    this.setPieceTimer = 2.5;
    if (taker === 'home') {
      const nearest = this.nearestPlayer(taker, x, y);
      this.controlled = nearest;
    }
    this.setMessage(
      `⚑ FREE KICK: ${taker === 'home' ? 'Rockets' : 'Comets'}${
        taker === 'home' ? ' — press C' : ''
      }`
    );
  }

  private penalty(taker: TeamSide): void {
    this.state = 'penalty';
    this.setPieceTaker = taker;
    const spotX = taker === 'home' ? FIELD_W - 112 : 112;
    this.ball.setPosition(spotX, FIELD_H / 2);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = taker;
    this.setPieceTimer = 3;
    if (taker === 'home') {
      const striker = this.players.find(
        (p) => p.side === taker && p.role === 'FWD'
      )!;
      this.controlled = striker;
    }
    this.flashScreen(0xff3b47, 0.3);
    this.setMessage(
      `⚠ PENALTY! ${taker === 'home' ? 'Rockets' : 'Comets'}${
        taker === 'home' ? ' — press C' : ''
      }`
    );
  }

  private takeSetPiece(): void {
    const taker = this.setPieceTaker!;
    const goalX = taker === 'home' ? FIELD_W - 8 : 8;

    if (this.state === 'penalty') {
      const targetY =
        FIELD_H / 2 + Phaser.Math.Between(-35, 35);
      const angle = Math.atan2(
        targetY - this.ball.y,
        goalX - this.ball.x
      );
      this.kickBall(
        Math.cos(angle) * 450,
        Math.sin(angle) * 450,
        taker,
        20
      );
      this.playSound('shoot');
      this.cameraShake = 0.2;
    } else if (this.state === 'corner') {
      const targetX = taker === 'home' ? FIELD_W - 90 : 90;
      const dx = targetX - this.ball.x;
      const dy = FIELD_H / 2 - this.ball.y;
      this.kickBall(dx * 2.2, dy * 2.2, taker, 80);
      this.playSound('kick');
    } else if (this.state === 'throw-in') {
      const teammate = this.players.find(
        (p) =>
          p.side === taker &&
          p.role !== 'GK' &&
          Phaser.Math.Distance.Between(
            p.sprite.x,
            p.sprite.y,
            this.ball.x,
            this.ball.y
          ) < 200
      );
      if (teammate) {
        const dx = teammate.sprite.x - this.ball.x;
        const dy = teammate.sprite.y - this.ball.y;
        this.kickBall(dx * 1.8, dy * 1.8, taker, 40);
      } else {
        this.kickBall(
          taker === 'home' ? 150 : -150,
          0,
          taker,
          40
        );
      }
    } else {
      // Freekick / goal kick
      const targetX =
        taker === 'home' ? FIELD_W * 0.7 : FIELD_W * 0.3;
      const targetY =
        FIELD_H / 2 + Phaser.Math.Between(-80, 80);
      const dx = targetX - this.ball.x;
      const dy = targetY - this.ball.y;
      const dist = Math.hypot(dx, dy);
      this.kickBall(
        (dx / dist) * 330,
        (dy / dist) * 330,
        taker,
        40
      );
      this.playSound('kick');
    }

    this.state = 'playing';
    this.setPieceTaker = null;
    this.kickoffLock = 0.3;
  }

  // ═══════════════ GOAL ═══════════════

  private scoreGoal(side: TeamSide): void {
    // >>> THE KEY FIX: prevent re-entry <<<
    if (this.goalScored) return;
    this.goalScored = true;

    if (side === 'home') this.homeScore++;
    else this.awayScore++;

    // Immediately stop the ball and move it to center
    this.state = 'goal';
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    // Park the ball safely in center so it can't trigger again
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);

    this.updateHud();

    // Visual celebration
    const teamName = side === 'home' ? 'ROCKETS' : 'COMETS';
    this.showGoalCelebration('GOAL!!!', `${teamName} SCORE!`);
    this.flashScreen(0xffffff, 0.7);
    this.cameraShake = 0.4;
    this.playSound('goal');

    // Confetti particles
    const confettiX = side === 'home' ? FIELD_W * 0.75 : FIELD_W * 0.25;
    for (let i = 0; i < 50; i++) {
      this.spawnConfetti(confettiX, FIELD_H / 2);
    }

    // Player celebrations
    const now = this.time.now;
    this.players
      .filter((p) => p.side === side)
      .forEach((p) => {
        p.celebrating = true;
        p.celebrateUntil = now + 2500;
        p.vx = 0;
        p.vy = 0;
        this.tweens.add({
          targets: p.sprite,
          y: p.sprite.y - 12,
          yoyo: true,
          repeat: 4,
          duration: 180,
          ease: 'Sine.easeInOut',
        });
      });

    this.setMessage(
      `⚽ GOAL! ${side === 'home' ? 'Rockets' : 'Comets'} score!`
    );

    // Delayed kickoff
    this.time.delayedCall(2800, () => {
      this.goalScored = false; // Reset the guard
      this.players.forEach((p) => {
        p.celebrating = false;
      });
      this.goalText.setAlpha(0);
      this.goalSubText.setAlpha(0);
      this.kickoff();
    });
  }

  private showGoalCelebration(big: string, sub: string): void {
    // Big text
    this.goalText.setText(big).setAlpha(1).setScale(0.2);
    this.tweens.add({
      targets: this.goalText,
      scale: 1.1,
      duration: 350,
      ease: 'Back.easeOut',
      yoyo: true,
      hold: 1800,
      onComplete: () => {
        this.goalText.setAlpha(0);
      },
    });

    // Sub text
    this.goalSubText.setText(sub).setAlpha(0);
    this.tweens.add({
      targets: this.goalSubText,
      alpha: 1,
      delay: 300,
      duration: 300,
      hold: 1700,
      yoyo: true,
    });
  }

  private flashScreen(color: number, alpha: number): void {
    this.goalFlash.setFillStyle(color, 1).setAlpha(alpha);
    this.tweens.add({
      targets: this.goalFlash,
      alpha: 0,
      duration: 500,
      ease: 'Cubic.easeOut',
    });
  }

  // ═══════════════ PARTICLES ═══════════════

  private spawnConfetti(x: number, y: number): void {
    const colors = [0xffd23f, 0xef476f, 0x06d6a0, 0x118ab2, 0xffffff];
    const color = colors[Phaser.Math.Between(0, colors.length - 1)];
    const obj = this.add
      .rectangle(
        x + Phaser.Math.Between(-20, 20),
        y + Phaser.Math.Between(-20, 20),
        Phaser.Math.Between(3, 6),
        Phaser.Math.Between(3, 6),
        color
      )
      .setDepth(49);
    this.particles.push({
      obj,
      vx: Phaser.Math.Between(-180, 180),
      vy: Phaser.Math.Between(-320, -80),
      life: 2.5,
      maxLife: 2.5,
    });
  }

  private spawnDustParticles(x: number, y: number): void {
    for (let i = 0; i < 6; i++) {
      const obj = this.add
        .circle(x, y, Phaser.Math.Between(2, 4), 0xbfa678, 0.6)
        .setDepth(14);
      this.particles.push({
        obj,
        vx: Phaser.Math.Between(-60, 60),
        vy: Phaser.Math.Between(-50, 10),
        life: 0.4,
        maxLife: 0.4,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      (p.obj as any).x += p.vx * dt;
      (p.obj as any).y += p.vy * dt;
      p.vy += 350 * dt; // gravity
      p.life -= dt;
      p.obj.setAlpha(Math.max(0, p.life / p.maxLife));
      if ('rotation' in p.obj) {
        (p.obj as any).rotation += dt * 4;
      }
      if (p.life <= 0) {
        p.obj.destroy();
        this.particles.splice(i, 1);
      }
    }
  }

  private updateCamera(dt: number): void {
    if (this.cameraShake > 0) {
      const intensity = this.cameraShake * 8;
      this.cameras.main.setScroll(
        Phaser.Math.Between(-intensity, intensity),
        Phaser.Math.Between(-intensity, intensity)
      );
      this.cameraShake -= dt;
      if (this.cameraShake <= 0) {
        this.cameraShake = 0;
        this.cameras.main.setScroll(0, 0);
      }
    }
  }

  // ═══════════════ SOUND ═══════════════

  private playSound(
    type: 'kick' | 'pass' | 'shoot' | 'goal' | 'tackle'
  ): void {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;

    try {
      switch (type) {
        case 'kick': {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'square';
          o.frequency.value = 200;
          g.gain.setValueAtTime(0.12, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + 0.1
          );
          o.start();
          o.stop(ctx.currentTime + 0.1);
          break;
        }
        case 'pass': {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'triangle';
          o.frequency.value = 350;
          g.gain.setValueAtTime(0.08, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + 0.08
          );
          o.start();
          o.stop(ctx.currentTime + 0.08);
          break;
        }
        case 'shoot': {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(180, ctx.currentTime);
          o.frequency.exponentialRampToValueAtTime(
            80,
            ctx.currentTime + 0.2
          );
          g.gain.setValueAtTime(0.15, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + 0.2
          );
          o.start();
          o.stop(ctx.currentTime + 0.2);
          break;
        }
        case 'tackle': {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'square';
          o.frequency.value = 120;
          g.gain.setValueAtTime(0.12, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + 0.06
          );
          o.start();
          o.stop(ctx.currentTime + 0.06);
          break;
        }
        case 'goal': {
          [523, 659, 784, 1047].forEach((freq, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            o.type = 'square';
            o.frequency.value = freq;
            const t = ctx.currentTime + i * 0.12;
            g.gain.setValueAtTime(0.12, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
            o.start(t);
            o.stop(t + 0.25);
          });
          break;
        }
      }
    } catch (_e) {
      // Audio context may be suspended
    }
  }

  // ═══════════════ HELPERS ═══════════════

  private kickoff(): void {
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);
    this.ballVx = 0;
    this.ballVy = 0;
    this.ballVz = 0;
    this.ballHeight = 0;
    this.possession = 'home';
    this.lastTouch = 'home';
    this.kickoffLock = 1.2;
    this.state = 'playing';
    this.goalScored = false; // Make sure guard is reset

    this.players.forEach((p) => {
      p.sprite.setPosition(p.homeX, p.homeY);
      p.shadow.setPosition(p.homeX + 2, p.homeY + 10);
      p.vx = 0;
      p.vy = 0;
      p.celebrating = false;
      p.tackling = 0;
      p.cooldown = 0;
      p.sprite.setRotation(0).setScale(1, 1);
    });

    this.selectControlled();
    this.ballShadow.setPosition(FIELD_W / 2 + 2, FIELD_H / 2 + 6);
    this.ballInner.setPosition(FIELD_W / 2, FIELD_H / 2);
  }

  private resetMatch(): void {
    // Clean up particles
    this.particles.forEach((p) => p.obj.destroy());
    this.particles = [];

    // Kill all tweens
    this.tweens.killAll();

    // Reset overlays
    this.goalText.setAlpha(0);
    this.goalSubText.setAlpha(0);
    this.goalFlash.setAlpha(0);
    this.cameras.main.setScroll(0, 0);
    this.cameraShake = 0;

    this.homeScore = 0;
    this.awayScore = 0;
    this.remaining = HALF_SECONDS;
    this.half = 1;
    this.paused = false;
    this.ended = false;
    this.lastClockTick = 0;
    this.goalScored = false;
    if (this.hint) this.hint.style.display = 'none';
    this.kickoff();
    this.updateHud();
    this.setMessage('New match — kick-off!');
  }

  private selectControlled(): void {
    this.controlled = this.nearestPlayer(
      'home',
      this.ball.x,
      this.ball.y
    );
    this.players
      .filter((p) => p.side === 'home')
      .forEach((p) => {
        p.body.setStrokeStyle(
          p === this.controlled ? 3 : 2,
          p === this.controlled ? 0xffd23f : 0xffffff
        );
      });
  }

  private nearestPlayer(
    side: TeamSide,
    x: number,
    y: number
  ): Footballer {
    const outfield = this.players.filter(
      (p) => p.side === side && p.role !== 'GK'
    );
    if (outfield.length === 0) {
      return this.players.find((p) => p.side === side)!;
    }
    return outfield.reduce((best, p) =>
      Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, x, y) <
      Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, x, y)
        ? p
        : best
    );
  }

  private updateHud(): void {
    if (this.homeScoreEl)
      this.homeScoreEl.textContent = String(this.homeScore);
    if (this.awayScoreEl)
      this.awayScoreEl.textContent = String(this.awayScore);
    if (this.clockEl) {
      const mins = String(Math.floor(this.remaining / 60)).padStart(
        2,
        '0'
      );
      const secs = String(this.remaining % 60).padStart(2, '0');
      this.clockEl.textContent = `${mins}:${secs}`;
    }
    if (this.periodEl) {
      this.periodEl.textContent =
        this.half === 1
          ? 'FIRST HALF'
          : this.half === 2
            ? 'SECOND HALF'
            : 'EXTRA TIME';
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

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: FIELD_W,
  height: FIELD_H,
  backgroundColor: '#1b6849',
  antialias: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: FIELD_W,
    height: FIELD_H,
  },
  render: { pixelArt: true, roundPixels: true },
  scene: [RetroKickScene],
});

(window as Window & { retroKickGame?: Phaser.Game }).retroKickGame = game;
