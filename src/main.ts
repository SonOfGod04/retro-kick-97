import Phaser from 'phaser';
import './style.css';

const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;
const EXTRA_TIME_SECONDS = 60;

type TeamSide = 'home' | 'away';
type SetPieceType = 'none' | 'throwin' | 'corner' | 'freekick' | 'penalty' | 'goalkick' | 'kickoff';
type GameState = 'playing' | 'celebrating' | 'setpiece' | 'halftime' | 'fulltime' | 'extratime';

interface Footballer {
  sprite: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  head: Phaser.GameObjects.Arc;
  shadow: Phaser.GameObjects.Arc;
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
  tackled: boolean;
  tackleTimer: number;
  facing: number; // angle in radians
}

class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ball!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Arc;
  private ballZ = 0; // ball height for throw-ins
  private ballVz = 0;
  private ballVx = 0;
  private ballVy = 0;
  private possession: TeamSide | null = 'home';
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
  private message = 'Ready for kick-off';
  private gameState: GameState = 'playing';
  private setPiece: SetPieceType = 'none';
  private setPieceTimer = 0;
  private celebrationTimer = 0;
  private lastTouchSide: TeamSide = 'home';
  private pitchGraphics!: Phaser.GameObjects.Graphics;
  private crowdGraphics!: Phaser.GameObjects.Graphics;
  private effectsLayer!: Phaser.GameObjects.Container;
  private goalFlashText?: Phaser.GameObjects.Text;
  private confettiParticles: Phaser.GameObjects.Rectangle[] = [];
  private cameraShakeTime = 0;
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
    this.effectsLayer = this.add.container(0, 0).setDepth(100);

    this.keys = this.input.keyboard!.addKeys(
      'W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,SPACE,SHIFT,P,ENTER'
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    this.homeScoreEl = document.getElementById('home-score');
    this.awayScoreEl = document.getElementById('away-score');
    this.clockEl = document.getElementById('clock');
    this.periodEl = document.getElementById('period');
    this.statusEl = document.getElementById('status-message');
    this.hint = document.getElementById('canvas-hint');

    this.input.on('pointerdown', () => {
      if (this.ended) this.resetMatch();
      this.paused = false;
      if (this.hint) this.hint.style.display = 'none';
      this.setMessage('Play on!');
    });

    document.getElementById('restart-button')?.addEventListener('click', () => this.resetMatch());
    this.selectControlled();
    this.updateHud();
    this.setMessage('Ready for kick-off');
  }

  // ============ PITCH DRAWING (ENHANCED) ============
  private drawPitch(): void {
    // Crowd background
    this.crowdGraphics = this.add.graphics();
    this.drawCrowd();

    this.pitchGraphics = this.add.graphics();
    const g = this.pitchGraphics;

    // Grass with gradient effect via multiple stripes
    g.fillStyle(0x1b6849, 1).fillRect(0, 0, FIELD_W, FIELD_H);
    const stripeH = 32;
    for (let i = 0; i < Math.ceil(FIELD_H / stripeH); i++) {
      const shade = i % 2 === 0 ? 0x1f7552 : 0x1a6246;
      g.fillStyle(shade, 1).fillRect(0, i * stripeH, FIELD_W, stripeH);
    }

    // Field lines
    g.lineStyle(3, 0xffffff, 0.9);
    g.strokeRect(19, 19, FIELD_W - 38, FIELD_H - 38);
    g.lineBetween(FIELD_W / 2, 19, FIELD_W / 2, FIELD_H - 19);
    g.strokeCircle(FIELD_W / 2, FIELD_H / 2, 67);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W / 2, FIELD_H / 2, 4);

    // Penalty boxes
    g.strokeRect(19, 135, 118, 250);
    g.strokeRect(19, 190, 49, 140);
    g.strokeRect(FIELD_W - 137, 135, 118, 250);
    g.strokeRect(FIELD_W - 68, 190, 49, 140);

    // Penalty spots
    g.fillStyle(0xffffff, 1).fillCircle(100, FIELD_H / 2, 3);
    g.fillStyle(0xffffff, 1).fillCircle(FIELD_W - 100, FIELD_H / 2, 3);

    // Penalty arcs (D)
    g.beginPath();
    g.arc(100, FIELD_H / 2, 40, -Math.PI / 3, Math.PI / 3, false);
    g.strokePath();
    g.beginPath();
    g.arc(FIELD_W - 100, FIELD_H / 2, 40, Math.PI - Math.PI / 3, Math.PI + Math.PI / 3, true);
    g.strokePath();

    // Corner arcs
    const corners = [[19, 19], [FIELD_W - 19, 19], [19, FIELD_H - 19], [FIELD_W - 19, FIELD_H - 19]];
    corners.forEach(([x, y]) => {
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.strokePath();
    });

    // Goals with proper net look
    this.drawGoal(g, 0);
    this.drawGoal(g, FIELD_W - 22);

    // Corner flags
    this.drawCornerFlag(19, 19);
    this.drawCornerFlag(FIELD_W - 19, 19);
    this.drawCornerFlag(19, FIELD_H - 19);
    this.drawCornerFlag(FIELD_W - 19, FIELD_H - 19);
  }

  private drawGoal(g: Phaser.GameObjects.Graphics, x: number): void {
    // Goal frame
    g.fillStyle(0xf5f5f5, 1).fillRect(x, FIELD_H / 2 - 52, 22, 104);
    // Goal net pattern
    g.lineStyle(1, 0xaaaaaa, 0.7);
    for (let y = FIELD_H / 2 - 50; y <= FIELD_H / 2 + 50; y += 6) {
      g.lineBetween(x + 2, y, x + 20, y);
    }
    for (let vx = x + 2; vx <= x + 20; vx += 5) {
      g.lineBetween(vx, FIELD_H / 2 - 50, vx, FIELD_H / 2 + 50);
    }
    // Posts
    g.fillStyle(0xffffff, 1);
    g.fillRect(x === 0 ? 20 : x, FIELD_H / 2 - 52, 2, 104);
  }

  private drawCornerFlag(x: number, y: number): void {
    const flag = this.add.graphics().setDepth(2);
    flag.fillStyle(0x8b4513, 1).fillRect(x - 1, y - 12, 2, 14);
    flag.fillStyle(0xff3030, 1).fillTriangle(x, y - 12, x + 10, y - 9, x, y - 6);
  }

  private drawCrowd(): void {
    const g = this.crowdGraphics;
    // Simple pixelated crowd on top and bottom
    for (let i = 0; i < FIELD_W; i += 4) {
      const c = Phaser.Utils.Array.GetRandom([0x4a3a2a, 0x5a4a3a, 0x3a2a1a, 0x6a5a4a]);
      g.fillStyle(c, 1).fillRect(i, 0, 3, 18);
      g.fillStyle(c, 1).fillRect(i, FIELD_H - 18, 3, 18);
    }
    // Dot "heads"
    for (let i = 0; i < FIELD_W; i += 6) {
      const skin = Phaser.Utils.Array.GetRandom([0xf4c2a1, 0xd8a67a, 0xb57a5a, 0x8b5a3a]);
      g.fillStyle(skin, 1).fillCircle(i, 10, 2);
      g.fillStyle(skin, 1).fillCircle(i, FIELD_H - 10, 2);
    }
  }

  // ============ TEAMS ============
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
    const bodyColor = side === 'home' ? 0x2a7ad4 : 0xd4302a;
    const trimColor = side === 'home' ? 0xffffff : 0xffeb3b;
    const skinColor = 0xf4c2a1;

    const shadow = this.add.circle(x + 3, y + 5, role === 'GK' ? 14 : 12, 0x000000, 0.35).setDepth(1);

    // Container-based player
    const container = this.add.container(x, y).setDepth(10);
    // Body (jersey)
    const body = this.add.circle(0, 2, role === 'GK' ? 11 : 10, bodyColor, 1).setStrokeStyle(2, trimColor);
    // Shorts suggestion
    const shorts = this.add.rectangle(0, 8, 14, 5, 0x222222, 1);
    // Head
    const head = this.add.circle(0, -7, 5, skinColor, 1).setStrokeStyle(1, 0x000000);
    // Hair
    const hair = this.add.arc(0, -9, 5, 180, 360, true, 0x3a2a1a, 1);

    container.add([shorts, body, head, hair]);

    const label = this.add.text(0, 2, String(number), {
      fontFamily: 'Arial, sans-serif',
      fontSize: '9px',
      color: '#ffffff',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add(label);

    const player: Footballer = {
      sprite: container,
      body,
      head,
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
      tackled: false,
      tackleTimer: 0,
      facing: side === 'home' ? 0 : Math.PI,
    };

    this.players.push(player);
  }

  private createBall(): void {
    this.ballShadow = this.add.circle(FIELD_W / 2 + 2, FIELD_H / 2 + 4, 7, 0x000000, 0.4).setDepth(20);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xffffff, 1)
      .setStrokeStyle(1.5, 0x000000, 1).setDepth(21);
  }

  // ============ MAIN UPDATE ============
  update(time: number, delta: number): void {
    if (this.keys.P.isDown && !this.pauseKeyHeld) {
      this.paused = !this.paused;
      this.pauseKeyHeld = true;
      this.setMessage(this.paused ? 'Paused — press P to resume' : 'Play on!');
    }
    if (this.keys.P.isUp) this.pauseKeyHeld = false;
    if (this.keys.ENTER.isDown && this.ended) this.resetMatch();
    if (this.paused || this.ended) return;

    const dt = Math.min(delta / 1000, 0.035);

    // Camera shake
    if (this.cameraShakeTime > 0) {
      this.cameraShakeTime -= dt;
      this.cameras.main.setPosition(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6
      );
      if (this.cameraShakeTime <= 0) this.cameras.main.setPosition(0, 0);
    }

    // Clock
    if (time - this.lastClockTick >= 1000 && this.gameState === 'playing') {
      this.lastClockTick = time;
      this.remaining = Math.max(0, this.remaining - 1);
      if (this.remaining === 0) this.handlePeriodEnd();
    }

    // Celebration lockout
    if (this.gameState === 'celebrating') {
      this.celebrationTimer -= dt;
      this.updateCelebration(dt);
      if (this.celebrationTimer <= 0) {
        this.endCelebration();
      }
      this.updateBall(dt);
      this.updatePlayerVisuals();
      return;
    }

    // Set piece countdown
    if (this.gameState === 'setpiece') {
      this.setPieceTimer -= dt;
      this.updateUser(dt);
      this.updateCpu(dt);
      this.updatePlayerVisuals();
      if (this.setPieceTimer <= 0) {
        this.executeSetPiece();
      }
      return;
    }

    this.kickoffLock = Math.max(0, this.kickoffLock - dt);
    this.updateUser(dt);
    this.updateCpu(dt);
    this.updateBall(dt);
    this.updatePossession();
    this.updatePlayerVisuals();
    this.updateHud();
  }

  private handlePeriodEnd(): void {
    if (this.half === 1) {
      this.half = 2;
      this.remaining = HALF_SECONDS;
      this.kickoff();
      this.setMessage('⏱ Half-time! Second half begins');
    } else if (this.half === 2) {
      if (this.homeScore === this.awayScore) {
        // Go to extra time
        this.half = 3;
        this.gameState = 'extratime';
        this.remaining = EXTRA_TIME_SECONDS;
        this.kickoff();
        this.setMessage('⚡ EXTRA TIME! Tied score!');
        this.gameState = 'playing';
      } else {
        this.endMatch();
      }
    } else {
      // End of extra time
      this.endMatch();
    }
  }

  private endMatch(): void {
    this.ended = true;
    const msg = this.homeScore === this.awayScore
      ? '🏆 Full-time — Honours even!'
      : this.homeScore > this.awayScore
        ? '🏆 Full-time — Rockets WIN!'
        : '🏆 Full-time — Comets WIN!';
    this.setMessage(msg);
    this.showBigText(msg, 0xffd700);
    if (this.hint) {
      this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN';
      this.hint.style.display = 'block';
    }
  }

  // ============ PLAYER VISUALS ============
  private updatePlayerVisuals(): void {
    this.players.forEach(p => {
      // Animate facing direction
      if (Math.abs(p.vx) > 5 || Math.abs(p.vy) > 5) {
        p.facing = Math.atan2(p.vy, p.vx);
        // Rotate head slightly
        p.head.setPosition(Math.cos(p.facing) * 2, -7 + Math.sin(p.facing) * 1);
      }
      // Tackle animation (fallen player)
      if (p.tackled) {
        p.tackleTimer -= 0.016;
        p.sprite.setRotation(Math.PI / 2);
        p.sprite.setAlpha(0.7);
        if (p.tackleTimer <= 0) {
          p.tackled = false;
          p.sprite.setRotation(0);
          p.sprite.setAlpha(1);
        }
      }
      // Celebration bobbing
      if (p.celebrating) {
        p.sprite.y = p.homeY + Math.sin(this.time.now / 100) * 6;
      }
      p.cooldown = Math.max(0, p.cooldown - 0.016);
    });
  }

  // ============ USER INPUT ============
  private updateUser(dt: number): void {
    if (this.controlled.tackled) return;

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
      const distance = Phaser.Math.Distance.Between(
        this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y
      );
      if (this.possession === 'home' && distance < 48) this.passBall();
      else this.selectControlled();
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.Z)) this.shootBall();
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) this.tackle();
  }

  // ============ CPU ============
  private updateCpu(dt: number): void {
    const awayPlayers = this.players.filter(p => p.side === 'away');
    const nearest = this.nearestPlayer('away', this.ball.x, this.ball.y);
    awayPlayers.forEach(p => {
      if (p.tackled) return;
      if (p.role === 'GK') {
        this.steerTo(p, FIELD_W - 67, Phaser.Math.Clamp(this.ball.y, FIELD_H / 2 - 36, FIELD_H / 2 + 36), 115, dt);
      } else if (p === nearest) {
        this.steerTo(p, this.ball.x + (this.ball.x < FIELD_W * 0.62 ? 8 : -12), this.ball.y, 143, dt);
        if (Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) < 23 && this.possession !== 'away') {
          this.possession = 'away';
          this.lastTouchSide = 'away';
        }
      } else {
        const driftX = Phaser.Math.Clamp((this.ball.x - FIELD_W / 2) * 0.18, -58, 58);
        const driftY = Phaser.Math.Clamp((this.ball.y - FIELD_H / 2) * 0.13, -38, 38);
        this.steerTo(p, p.homeX + driftX, p.homeY + driftY, 88, dt);
      }
    });

    if (this.possession === 'away' && this.kickoffLock <= 0) {
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
        }
      }
    }
  }

  // ============ MOVEMENT ============
  private movePlayer(p: Footballer, dt: number, userControlled = false): void {
    if (p.tackled) return;
    p.sprite.x = Phaser.Math.Clamp(p.sprite.x + p.vx * dt, 20, FIELD_W - 20);
    p.sprite.y = Phaser.Math.Clamp(p.sprite.y + p.vy * dt, 20, FIELD_H - 20);
    p.shadow.setPosition(p.sprite.x + 3, p.sprite.y + 5);

    if (userControlled && this.possession === 'home' &&
        Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) < 22 &&
        this.kickoffLock <= 0) {
      this.ball.x = p.sprite.x + (p.vx === 0 ? 13 : Math.sign(p.vx) * 15);
      this.ball.y = p.sprite.y + (p.vy === 0 ? 0 : Math.sign(p.vy) * 8);
      this.ballVx = p.vx * 0.25;
      this.ballVy = p.vy * 0.25;
      this.lastTouchSide = 'home';
    }
  }

  private steerTo(p: Footballer, x: number, y: number, speed: number, dt: number): void {
    if (p.tackled) return;
    const dx = x - p.sprite.x, dy = y - p.sprite.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 3) {
      p.vx = (dx / distance) * Math.min(speed, distance * 3);
      p.vy = (dy / distance) * Math.min(speed, distance * 3);
    } else { p.vx = 0; p.vy = 0; }
    this.movePlayer(p, dt, false);
  }

  // ============ BALL ============
  private updateBall(dt: number): void {
    // Ball height physics (for throw-ins)
    if (this.ballZ > 0 || this.ballVz !== 0) {
      this.ballZ += this.ballVz * dt;
      this.ballVz -= 200 * dt; // gravity
      if (this.ballZ <= 0) {
        this.ballZ = 0;
        this.ballVz = 0;
      }
      this.ball.setScale(1 + this.ballZ * 0.015);
    }

    this.ball.x += this.ballVx * dt;
    this.ball.y += this.ballVy * dt;
    this.ballVx *= Math.pow(0.986, dt * 60);
    this.ballVy *= Math.pow(0.986, dt * 60);

    // Out of bounds detection — throw-ins and corners
    const outTop = this.ball.y < 19;
    const outBottom = this.ball.y > FIELD_H - 19;
    const outLeft = this.ball.x < 19 && Math.abs(this.ball.y - FIELD_H / 2) > 52;
    const outRight = this.ball.x > FIELD_W - 19 && Math.abs(this.ball.y - FIELD_H / 2) > 52;

    if ((outTop || outBottom) && this.gameState === 'playing' && this.ballZ === 0) {
      this.triggerThrowIn(outTop ? 19 : FIELD_H - 19);
      return;
    }
    if (outLeft && this.gameState === 'playing') {
      if (this.lastTouchSide === 'away') {
        this.triggerCorner('home', 19, this.ball.y < FIELD_H / 2 ? 19 : FIELD_H - 19);
      } else {
        this.triggerGoalKick('away');
      }
      return;
    }
    if (outRight && this.gameState === 'playing') {
      if (this.lastTouchSide === 'home') {
        this.triggerCorner('away', FIELD_W - 19, this.ball.y < FIELD_H / 2 ? 19 : FIELD_H - 19);
      } else {
        this.triggerGoalKick('home');
      }
      return;
    }

    // Goal detection
    if (this.ball.x < 18 && Math.abs(this.ball.y - FIELD_H / 2) <= 52) this.score('away');
    if (this.ball.x > FIELD_W - 18 && Math.abs(this.ball.y - FIELD_H / 2) <= 52) this.score('home');

    // Ball collection
    if (this.kickoffLock <= 0 && Math.hypot(this.ballVx, this.ballVy) < 190 && this.ballZ === 0) {
      const candidates = this.players.filter(p => p.role !== 'GK' && !p.tackled);
      const closest = candidates.reduce((best, p) =>
        Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) <
        Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, this.ball.x, this.ball.y) ? p : best);
      const d = Phaser.Math.Distance.Between(closest.sprite.x, closest.sprite.y, this.ball.x, this.ball.y);
      if (d < 17 && Math.hypot(this.ballVx, this.ballVy) < 100) {
        this.possession = closest.side;
        this.lastTouchSide = closest.side;
        if (closest.side === 'home') this.controlled = closest;
        this.ballVx = 0; this.ballVy = 0;
      }
    }

    this.ballShadow.setPosition(this.ball.x + 3 + this.ballZ * 0.3, this.ball.y + 4 + this.ballZ * 0.3);
    this.ballShadow.setScale(1 - this.ballZ * 0.01);
  }

  private updatePossession(): void {
    if (this.possession === 'home') {
      const carrier = this.controlled;
      if (!carrier.tackled &&
          Phaser.Math.Distance.Between(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y) < 32 &&
          Math.hypot(this.ballVx, this.ballVy) < 120) {
        this.ball.x = carrier.sprite.x + (carrier.vx === 0 ? 14 : Math.sign(carrier.vx) * 14);
        this.ball.y = carrier.sprite.y + (carrier.vy === 0 ? 0 : Math.sign(carrier.vy) * 7);
        this.ballVx = carrier.vx * 0.22;
        this.ballVy = carrier.vy * 0.22;
      }
    }
    this.ball.setPosition(Phaser.Math.Clamp(this.ball.x, 7, FIELD_W - 7), Phaser.Math.Clamp(this.ball.y, 7, FIELD_H - 7));
  }

  // ============ ACTIONS ============
  private passBall(): void {
    const teammate = this.players.filter(p => p.side === 'home' && p !== this.controlled && p.role !== 'GK')
      .sort((a, b) => Phaser.Math.Distance.Between(a.sprite.x, a.sprite.y, this.ball.x, this.ball.y) -
        Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, this.ball.x, this.ball.y))[0];
    if (!teammate) return;
    const angle = Math.atan2(teammate.sprite.y - this.ball.y, teammate.sprite.x - this.ball.x);
    this.kickBall(Math.cos(angle) * 250, Math.sin(angle) * 250, 'home');
    this.setMessage('→ Pass played');
  }

  private shootBall(): void {
    const d = Phaser.Math.Distance.Between(this.controlled.sprite.x, this.controlled.sprite.y, this.ball.x, this.ball.y);
    if (this.possession !== 'home' && d > 42) {
      this.setMessage('Get closer to the ball to shoot');
      return;
    }
    const angle = Math.atan2(FIELD_H / 2 - this.ball.y + Phaser.Math.Between(-20, 20), FIELD_W - 8 - this.ball.x);
    const power = this.ball.x > FIELD_W * 0.68 ? 420 : 360;
    this.kickBall(Math.cos(angle) * power, Math.sin(angle) * power, 'home');
    this.setMessage('💥 SHOT!');
    this.cameraShakeTime = 0.15;
  }

  private tackle(): void {
    const opponent = this.nearestPlayer('away', this.controlled.sprite.x, this.controlled.sprite.y);
    const d = Phaser.Math.Distance.Between(
      this.controlled.sprite.x, this.controlled.sprite.y,
      opponent.sprite.x, opponent.sprite.y
    );

    if (d < 40) {
      // Lunge the controlled player
      this.tweens.add({
        targets: this.controlled.sprite,
        x: opponent.sprite.x,
        y: opponent.sprite.y,
        duration: 150,
        yoyo: false,
        ease: 'Power2',
      });

      const success = Phaser.Math.Between(0, 100) < 65;
      if (success && this.possession === 'away') {
        this.possession = 'home';
        this.lastTouchSide = 'home';
        opponent.tackled = true;
        opponent.tackleTimer = 1.2;
        this.ball.setPosition(this.controlled.sprite.x + 10, this.controlled.sprite.y);
        this.ballVx = 0; this.ballVy = 0;
        this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
        this.setMessage('✓ CLEAN TACKLE!');
        this.spawnTackleEffect(opponent.sprite.x, opponent.sprite.y);
      } else {
        this.setMessage('⚠ Foul! Free kick awarded');
        // Trigger free kick for opponent
        this.triggerFreeKick('away', this.ball.x, this.ball.y);
      }
    } else {
      this.setMessage('Missed challenge!');
    }
  }

  private kickBall(vx: number, vy: number, side: TeamSide): void {
    this.ballVx = vx; this.ballVy = vy;
    this.possession = null;
    this.lastTouchSide = side;
    if (side === 'home') this.controlled.cooldown = 0.25;
  }

  // ============ SET PIECES ============
  private triggerThrowIn(y: number): void {
    this.gameState = 'setpiece';
    this.setPiece = 'throwin';
    this.setPieceTimer = 1.0;
    this.ball.setPosition(Phaser.Math.Clamp(this.ball.x, 30, FIELD_W - 30), y);
    this.ballVx = 0; this.ballVy = 0;
    const throwerSide = this.lastTouchSide === 'home' ? 'away' : 'home';
    this.setMessage(`🙌 THROW-IN: ${throwerSide === 'home' ? 'Rockets' : 'Comets'}`);
  }

  private triggerCorner(forSide: TeamSide, x: number, y: number): void {
    this.gameState = 'setpiece';
    this.setPiece = 'corner';
    this.setPieceTimer = 1.2;
    this.ball.setPosition(x, y);
    this.ballVx = 0; this.ballVy = 0;
    this.lastTouchSide = forSide;
    this.setMessage(`⚑ CORNER: ${forSide === 'home' ? 'Rockets' : 'Comets'}`);
  }

  private triggerFreeKick(forSide: TeamSide, x: number, y: number): void {
    this.gameState = 'setpiece';
    this.setPiece = 'freekick';
    this.setPieceTimer = 1.5;
    this.ball.setPosition(x, y);
    this.ballVx = 0; this.ballVy = 0;
    this.lastTouchSide = forSide;

    // Check if it's in the penalty box → PENALTY
    const inHomeBox = x < 137 && Math.abs(y - FIELD_H / 2) < 125;
    const inAwayBox = x > FIELD_W - 137 && Math.abs(y - FIELD_H / 2) < 125;
    if ((forSide === 'home' && inAwayBox) || (forSide === 'away' && inHomeBox)) {
      this.triggerPenalty(forSide);
      return;
    }
    this.setMessage(`⚽ FREE KICK: ${forSide === 'home' ? 'Rockets' : 'Comets'}`);
  }

  private triggerPenalty(forSide: TeamSide): void {
    this.gameState = 'setpiece';
    this.setPiece = 'penalty';
    this.setPieceTimer = 2.0;
    const spotX = forSide === 'home' ? FIELD_W - 100 : 100;
    this.ball.setPosition(spotX, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.lastTouchSide = forSide;
    this.setMessage(`🎯 PENALTY! ${forSide === 'home' ? 'Rockets' : 'Comets'}`);
    this.showBigText('PENALTY!', 0xff3030);
  }

  private triggerGoalKick(forSide: TeamSide): void {
    this.gameState = 'setpiece';
    this.setPiece = 'goalkick';
    this.setPieceTimer = 1.0;
    const x = forSide === 'home' ? 65 : FIELD_W - 65;
    this.ball.setPosition(x, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.lastTouchSide = forSide;
    this.setMessage(`🥅 GOAL KICK: ${forSide === 'home' ? 'Rockets' : 'Comets'}`);
  }

  private executeSetPiece(): void {
    const taker = this.lastTouchSide;
    const targetX = taker === 'home' ? FIELD_W * 0.7 : FIELD_W * 0.3;
    const targetY = FIELD_H / 2 + Phaser.Math.Between(-80, 80);

    switch (this.setPiece) {
      case 'throwin': {
        const angle = Math.atan2(targetY - this.ball.y, targetX - this.ball.x);
        this.ballVx = Math.cos(angle) * 180;
        this.ballVy = Math.sin(angle) * 180;
        this.ballZ = 5;
        this.ballVz = 80;
        break;
      }
      case 'corner': {
        const angle = Math.atan2(FIELD_H / 2 - this.ball.y, (taker === 'home' ? FIELD_W - 90 : 90) - this.ball.x);
        this.ballVx = Math.cos(angle) * 280;
        this.ballVy = Math.sin(angle) * 280;
        this.ballZ = 3;
        this.ballVz = 60;
        break;
      }
      case 'freekick': {
        const angle = Math.atan2(targetY - this.ball.y, targetX - this.ball.x);
        this.ballVx = Math.cos(angle) * 320;
        this.ballVy = Math.sin(angle) * 320;
        break;
      }
      case 'penalty': {
        const goalX = taker === 'home' ? FIELD_W - 15 : 15;
        const goalY = FIELD_H / 2 + Phaser.Math.Between(-40, 40);
        const angle = Math.atan2(goalY - this.ball.y, goalX - this.ball.x);
        this.ballVx = Math.cos(angle) * 480;
        this.ballVy = Math.sin(angle) * 480;
        this.cameraShakeTime = 0.2;
        break;
      }
      case 'goalkick': {
        const angle = Math.atan2(targetY - this.ball.y, targetX - this.ball.x);
        this.ballVx = Math.cos(angle) * 360;
        this.ballVy = Math.sin(angle) * 360;
        this.ballZ = 5;
        this.ballVz = 120;
        break;
      }
    }
    this.possession = null;
    this.gameState = 'playing';
    this.setPiece = 'none';
    this.kickoffLock = 0.3;
  }

  // ============ GOAL / CELEBRATION ============
  private score(side: TeamSide): void {
    if (side === 'home') this.homeScore++; else this.awayScore++;
    this.updateHud();
    this.gameState = 'celebrating';
    this.celebrationTimer = 3.5;
    this.cameraShakeTime = 0.5;

    const msg = side === 'home' ? '⚽ GOOOOAL! ROCKETS!' : '⚽ GOOOOAL! COMETS!';
    this.setMessage(msg);

    // Big flashing goal text
    this.showBigText('GOOOOAL!', side === 'home' ? 0x2a7ad4 : 0xd4302a);

    // Confetti
    this.spawnConfetti(this.ball.x, this.ball.y, side === 'home' ? 0x2a7ad4 : 0xd4302a);

    // Make scorers celebrate
    this.players.filter(p => p.side === side && p.role !== 'GK').forEach(p => {
      p.celebrating = true;
    });

    // Stop ball
    this.ballVx = 0; this.ballVy = 0;
  }

  private updateCelebration(dt: number): void {
    // Keep confetti floating
    this.confettiParticles.forEach(c => {
      c.y += 80 * dt;
      c.rotation += 0.15;
      c.alpha -= 0.3 * dt;
    });
  }

  private endCelebration(): void {
    this.gameState = 'playing';
    this.players.forEach(p => {
      p.celebrating = false;
      p.sprite.y = p.homeY;
    });
    this.confettiParticles.forEach(c => c.destroy());
    this.confettiParticles = [];
    if (this.goalFlashText) {
      this.goalFlashText.destroy();
      this.goalFlashText = undefined;
    }
    this.kickoff();
  }

  private showBigText(text: string, color: number): void {
    if (this.goalFlashText) this.goalFlashText.destroy();
    this.goalFlashText = this.add.text(FIELD_W / 2, FIELD_H / 2, text, {
      fontFamily: 'Impact, Arial Black, sans-serif',
      fontSize: '72px',
      color: '#' + color.toString(16).padStart(6, '0'),
      stroke: '#ffffff',
      strokeThickness: 6,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(200);

    this.tweens.add({
      targets: this.goalFlashText,
      scale: { from: 0.2, to: 1.3 },
      duration: 400,
      ease: 'Back.easeOut',
      yoyo: true,
      repeat: 2,
    });
  }

  private spawnConfetti(x: number, y: number, mainColor: number): void {
    const colors = [mainColor, 0xffd700, 0xffffff, 0xff69b4, 0x00ff00];
    for (let i = 0; i < 60; i++) {
      const c = this.add.rectangle(
        x + Phaser.Math.Between(-30, 30),
        y + Phaser.Math.Between(-30, 30),
        Phaser.Math.Between(3, 6),
        Phaser.Math.Between(6, 10),
        Phaser.Utils.Array.GetRandom(colors)
      ).setDepth(150);
      this.tweens.add({
        targets: c,
        x: c.x + Phaser.Math.Between(-200, 200),
        y: c.y + Phaser.Math.Between(-150, 50),
        rotation: Phaser.Math.Between(-5, 5),
        duration: 2000,
        ease: 'Cubic.easeOut',
      });
      this.confettiParticles.push(c);
    }
  }

  private spawnTackleEffect(x: number, y: number): void {
    for (let i = 0; i < 8; i++) {
      const dust = this.add.circle(x, y, 3, 0xcccccc, 0.8).setDepth(50);
      const angle = (i / 8) * Math.PI * 2;
      this.tweens.add({
        targets: dust,
        x: x + Math.cos(angle) * 25,
        y: y + Math.sin(angle) * 25,
        alpha: 0,
        scale: 0.3,
        duration: 500,
        onComplete: () => dust.destroy(),
      });
    }
  }

  // ============ KICKOFF ============
  private kickoff(): void {
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.ballZ = 0; this.ballVz = 0;
    this.possession = 'home';
    this.kickoffLock = 1.2;
    this.players.forEach(p => {
      p.sprite.setPosition(p.homeX, p.homeY);
      p.shadow.setPosition(p.homeX + 3, p.homeY + 5);
      p.vx = 0; p.vy = 0;
      p.tackled = false;
      p.tackleTimer = 0;
      p.celebrating = false;
      p.sprite.setRotation(0);
      p.sprite.setAlpha(1);
    });
    this.selectControlled();
    this.ballShadow.setPosition(FIELD_W / 2 + 3, FIELD_H / 2 + 4);
  }

  private resetMatch(): void {
    this.homeScore = 0; this.awayScore = 0; this.remaining = HALF_SECONDS;
    this.half = 1; this.paused = false; this.ended = false; this.lastClockTick = 0;
    this.gameState = 'playing';
    if (this.hint) this.hint.style.display = 'none';
    this.kickoff();
    this.updateHud();
    this.setMessage('🏁 New match — kick-off!');
  }

  private selectControlled(): void {
    this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
    this.players.filter(p => p.side === 'home').forEach(p =>
      p.body.setStrokeStyle(p === this.controlled ? 3 : 2, p === this.controlled ? 0xffe07a : 0xffffff, 1)
    );
  }

  private nearestPlayer(side: TeamSide, x: number, y: number): Footballer {
    return this.players.filter(p => p.side === side && p.role !== 'GK').reduce((best, p) =>
      Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, x, y) <
      Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, x, y) ? p : best);
  }

  // ============ HUD ============
  private updateHud(): void {
    if (this.homeScoreEl) this.homeScoreEl.textContent = String(this.homeScore);
    if (this.awayScoreEl) this.awayScoreEl.textContent = String(this.awayScore);
    if (this.clockEl) this.clockEl.textContent =
      `${String(Math.floor(this.remaining / 60)).padStart(2, '0')}:${String(this.remaining % 60).padStart(2, '0')}`;
    if (this.periodEl) {
      this.periodEl.textContent = this.half === 1 ? 'FIRST HALF'
        : this.half === 2 ? 'SECOND HALF'
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
