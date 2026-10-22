import Phaser from 'phaser';
import './style.css';

const FIELD_W = 900;
const FIELD_H = 520;
const HALF_SECONDS = 120;

type TeamSide = 'home' | 'away';
interface Footballer {
  sprite: Phaser.GameObjects.Arc;
  shadow: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text; // Add this line
  side: TeamSide;
  role: 'GK' | 'DEF' | 'MID' | 'FWD';
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  number: number;
  cooldown: number;
}

class RetroKickScene extends Phaser.Scene {
  private players: Footballer[] = [];
  private ball!: Phaser.GameObjects.Arc;
  private ballShadow!: Phaser.GameObjects.Arc;
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
  private messageUntil = 999999;
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
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,X,Z,SPACE,SHIFT,P,ENTER') as Record<string, Phaser.Input.Keyboard.Key>;
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
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      document.getElementById('restart-button')?.replaceWith(document.getElementById('restart-button')!.cloneNode(true));
    });
  }

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
    // Penalty boxes and six-yard boxes.
    g.strokeRect(19, 135, 118, 250);
    g.strokeRect(19, 190, 49, 140);
    g.strokeRect(FIELD_W - 137, 135, 118, 250);
    g.strokeRect(FIELD_W - 68, 190, 49, 140);
    g.strokeCircle(112, FIELD_H / 2, 3).strokeCircle(FIELD_W - 112, FIELD_H / 2, 3);
    // Goals sit just outside the end lines.
    g.fillStyle(0xd8e3dc, 1).fillRect(0, FIELD_H / 2 - 52, 22, 104);
    g.fillStyle(0xd8e3dc, 1).fillRect(FIELD_W - 22, FIELD_H / 2 - 52, 22, 104);
    g.lineStyle(2, 0xffffff, 0.8);
    for (let y = FIELD_H / 2 - 44; y <= FIELD_H / 2 + 44; y += 22) {
      g.lineBetween(0, y, 20, y);
      g.lineBetween(FIELD_W - 20, y, FIELD_W, y);
    }
    // Small stadium-style side details.
    g.fillStyle(0xf4d06f, 1);
    g.fillTriangle(10, 9, 22, 9, 10, 21);
    g.fillTriangle(FIELD_W - 10, FIELD_H - 9, FIELD_W - 22, FIELD_H - 9, FIELD_W - 10, FIELD_H - 21);
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

  home.forEach((p, i) => {
    this.addPlayer('home', p[0], p[1], p[2], i + 1);
  });

  away.forEach((p, i) => {
    this.addPlayer('away', p[0], p[1], p[2], i + 1);
  });
}

  
private addPlayer(
  side: TeamSide,
  x: number,
  y: number,
  role: Footballer['role'],
  number: number
): void {
  const color = side === 'home' ? 0x3aa9ff : 0xff5a5f;

  const shadow = this.add.circle(
    x + 3, y + 5, role === 'GK' ? 15 : 13, 0x071b14, 0.3
  );

  const sprite = this.add.circle(
    x, y, role === 'GK' ? 13 : 12, color, 1
  ).setStrokeStyle(3, 0xf7f3df, 1);

  const label = this.add.text(x, y, String(number), {
    fontFamily: 'Arial, sans-serif',
    fontSize: role === 'GK' ? '11px' : '10px',
    color: '#10202a',
    fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(5);

  const player: Footballer = {
    sprite,
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
  };

  sprite.setData('footballer', player);
  this.players.push(player);
}
  private createBall(): void {
    this.ballShadow = this.add.circle(FIELD_W / 2 + 2, FIELD_H / 2 + 4, 8, 0x071b14, 0.35).setDepth(10);
    this.ball = this.add.circle(FIELD_W / 2, FIELD_H / 2, 6, 0xf8f7ed, 1).setStrokeStyle(2, 0x17211e, 1).setDepth(11);
    this.ball.setData('unused', true);
  }

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
    if (time - this.lastClockTick >= 1000) {
      this.lastClockTick = time;
      this.remaining = Math.max(0, this.remaining - 1);
      this.updateHud();
      if (this.remaining === 0) {
        if (this.half === 1) {
          this.half = 2;
          this.remaining = HALF_SECONDS;
          this.kickoff();
          this.setMessage('Half-time! Second half begins');
        } else {
          this.ended = true;
          this.setMessage(this.homeScore === this.awayScore ? 'Full-time — it ends level!' : this.homeScore > this.awayScore ? 'Full-time — Rockets win!' : 'Full-time — Comets win!');
          if (this.hint) {
            this.hint.textContent = 'FULL-TIME · CLICK TO PLAY AGAIN';
            this.hint.style.display = 'block';
          }
        }
      }
    }
    this.kickoffLock = Math.max(0, this.kickoffLock - dt);
    this.updateUser(dt);
    this.updateCpu(dt);
    this.updateBall(dt);
    this.updatePossession();
    this.updateHud();
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

    // AI keeps the other six teammates in shape and nudges them toward useful support positions.
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

  private movePlayer(p: Footballer, dt: number, userControlled = false): void {
    const oldX = p.sprite.x;
    const oldY = p.sprite.y;
    p.sprite.x = Phaser.Math.Clamp(p.sprite.x + p.vx * dt, 31, FIELD_W - 31);
    p.sprite.y = Phaser.Math.Clamp(p.sprite.y + p.vy * dt, 31, FIELD_H - 31);
    p.shadow.setPosition(p.sprite.x + 3, p.sprite.y + 5);
    // Keep number labels attached using small per-player text objects created at their initial positions.
    const label = this.children.list.find(o => o instanceof Phaser.GameObjects.Text && o.getData('playerNumber') === p.number && Math.abs((o as Phaser.GameObjects.Text).x - oldX) < 0.1 && Math.abs((o as Phaser.GameObjects.Text).y - oldY) < 0.1) as Phaser.GameObjects.Text | undefined;
    if (label) label.setPosition(p.sprite.x, p.sprite.y);
    if (userControlled && this.possession === 'home' && Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) < 22 && this.kickoffLock <= 0) {
      this.ball.x = p.sprite.x + (p.vx === 0 ? 13 : Math.sign(p.vx) * 15);
      this.ball.y = p.sprite.y + (p.vy === 0 ? 0 : Math.sign(p.vy) * 8);
      this.ballVx = p.vx * 0.25;
      this.ballVy = p.vy * 0.25;
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

  private updateBall(dt: number): void {
    this.ball.x += this.ballVx * dt;
    this.ball.y += this.ballVy * dt;
    this.ballVx *= Math.pow(0.986, dt * 60);
    this.ballVy *= Math.pow(0.986, dt * 60);
    if (this.ball.y < 25 || this.ball.y > FIELD_H - 25) {
      this.ball.y = Phaser.Math.Clamp(this.ball.y, 25, FIELD_H - 25);
      this.ballVy *= -0.72;
    }
    if (this.ball.x < 24 && Math.abs(this.ball.y - FIELD_H / 2) > 52) {
      this.ball.x = 24; this.ballVx *= -0.7;
    }
    if (this.ball.x > FIELD_W - 24 && Math.abs(this.ball.y - FIELD_H / 2) > 52) {
      this.ball.x = FIELD_W - 24; this.ballVx *= -0.7;
    }
    if (this.ball.x < 18 && Math.abs(this.ball.y - FIELD_H / 2) <= 52) this.score('away');
    if (this.ball.x > FIELD_W - 18 && Math.abs(this.ball.y - FIELD_H / 2) <= 52) this.score('home');

    // Gentle collection by the nearest outfield player; keep possession readable.
    if (this.kickoffLock <= 0 && Math.hypot(this.ballVx, this.ballVy) < 190) {
      const candidates = this.players.filter(p => p.role !== 'GK');
      const closest = candidates.reduce((best, p) =>
        Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.ball.x, this.ball.y) <
        Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, this.ball.x, this.ball.y) ? p : best);
      const d = Phaser.Math.Distance.Between(closest.sprite.x, closest.sprite.y, this.ball.x, this.ball.y);
      if (d < 17 && Math.hypot(this.ballVx, this.ballVy) < 100) {
        this.possession = closest.side;
        if (closest.side === 'home') this.controlled = closest;
        this.ballVx = 0; this.ballVy = 0;
      }
    }
    this.ballShadow.setPosition(this.ball.x + 3, this.ball.y + 4);
  }

  private updatePossession(): void {
    if (this.possession === 'home') {
      const carrier = this.controlled;
      if (Phaser.Math.Distance.Between(carrier.sprite.x, carrier.sprite.y, this.ball.x, this.ball.y) < 32 && Math.hypot(this.ballVx, this.ballVy) < 120) {
        this.ball.x = carrier.sprite.x + (carrier.vx === 0 ? 14 : Math.sign(carrier.vx) * 14);
        this.ball.y = carrier.sprite.y + (carrier.vy === 0 ? 0 : Math.sign(carrier.vy) * 7);
        this.ballVx = carrier.vx * 0.22;
        this.ballVy = carrier.vy * 0.22;
      }
    }
    this.ball.setPosition(Phaser.Math.Clamp(this.ball.x, 7, FIELD_W - 7), Phaser.Math.Clamp(this.ball.y, 7, FIELD_H - 7));
  }

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

  private tackle(): void {
    const opponent = this.nearestPlayer('away', this.controlled.sprite.x, this.controlled.sprite.y);
    const d = Phaser.Math.Distance.Between(this.controlled.sprite.x, this.controlled.sprite.y, opponent.sprite.x, opponent.sprite.y);
    if (d < 37 && this.possession === 'away') {
      this.possession = 'home';
      this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
      this.setMessage('Clean tackle!');
    } else {
      this.setMessage('Challenge!');
    }
  }

  private kickBall(vx: number, vy: number, side: TeamSide): void {
    this.ballVx = vx; this.ballVy = vy;
    this.possession = null;
    if (side === 'home') this.controlled.cooldown = 0.25;
  }

  private score(side: TeamSide): void {
    if (side === 'home') this.homeScore++; else this.awayScore++;
    this.updateHud();
    this.setMessage(side === 'home' ? 'GOAL! Rockets find the net!' : 'GOAL! Comets hit back!');
    this.kickoff();
  }

  private kickoff(): void {
    this.ball.setPosition(FIELD_W / 2, FIELD_H / 2);
    this.ballVx = 0; this.ballVy = 0;
    this.possession = 'home';
    this.kickoffLock = 1.2;
    this.players.forEach(p => {
      p.sprite.setPosition(p.homeX, p.homeY);
      p.shadow.setPosition(p.homeX + 3, p.homeY + 5);
      p.vx = 0; p.vy = 0;
    });
    this.selectControlled();
    this.ballShadow.setPosition(FIELD_W / 2 + 3, FIELD_H / 2 + 4);
  }

  private resetMatch(): void {
    this.homeScore = 0; this.awayScore = 0; this.remaining = HALF_SECONDS;
    this.half = 1; this.paused = false; this.ended = false; this.lastClockTick = 0;
    if (this.hint) this.hint.style.display = 'none';
    this.kickoff();
    this.updateHud();
    this.setMessage('New match — kick-off!');
  }

  private selectControlled(): void {
    this.controlled = this.nearestPlayer('home', this.ball.x, this.ball.y);
    this.players.filter(p => p.side === 'home').forEach(p => p.sprite.setStrokeStyle(p === this.controlled ? 4 : 2, p === this.controlled ? 0xffe07a : 0xf7f3df, 1));
  }

  private nearestPlayer(side: TeamSide, x: number, y: number): Footballer {
    return this.players.filter(p => p.side === side && p.role !== 'GK').reduce((best, p) =>
      Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, x, y) < Phaser.Math.Distance.Between(best.sprite.x, best.sprite.y, x, y) ? p : best);
  }

  private updateHud(): void {
    if (this.homeScoreEl) this.homeScoreEl.textContent = String(this.homeScore);
    if (this.awayScoreEl) this.awayScoreEl.textContent = String(this.awayScore);
    if (this.clockEl) this.clockEl.textContent = `${String(Math.floor(this.remaining / 60)).padStart(2, '0')}:${String(this.remaining % 60).padStart(2, '0')}`;
    if (this.periodEl) this.periodEl.textContent = this.half === 1 ? 'FIRST HALF' : 'SECOND HALF';
    if (this.statusEl && this.message) this.statusEl.innerHTML = `<span class="status-icon">▶</span> ${this.message}`;
  }

  private setMessage(message: string): void {
    this.message = message;
    this.messageUntil = this.time.now + 2200;
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
