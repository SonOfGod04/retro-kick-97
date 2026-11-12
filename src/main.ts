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
      
