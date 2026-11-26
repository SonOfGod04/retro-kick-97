// diagnostics.ts — release tooling: frame meter, watchdogs, invariant checks and the soak-test report.
// Pure logic (no Phaser), so it can be unit-tested.

/** Rolling frame-time statistics. */
export class PerfMeter {
  private samples: number[] = [];
  constructor(private maxSamples = 120) {}

  push(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.samples.push(ms);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  avgMs(): number {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  }
  fps(): number {
    const a = this.avgMs();
    return a > 0 ? 1000 / a : 0;
  }
  worstMs(): number {
    return this.samples.length ? Math.max(...this.samples) : 0;
  }
  /** Share of frames slower than limitMs (25 ms = below 40 fps). */
  slowShare(limitMs = 25): number {
    return this.samples.length ? this.samples.filter((s) => s > limitMs).length / this.samples.length : 0;
  }
  reset(): void {
    this.samples = [];
  }
}

/** Fires once when the ball has been loose and almost still for `limit` seconds (a "dropped ball"). */
export class LooseBallWatch {
  private t = 0;
  constructor(private limit = 7) {}
  update(dt: number, looseAndStill: boolean): boolean {
    if (!looseAndStill) { this.t = 0; return false; }
    this.t += dt;
    if (this.t >= this.limit) { this.t = 0; return true; }
    return false;
  }
}

/** How long a game state may last without something happening. Beyond this the game is probably stuck. */
export const STATE_LIMITS: Record<string, number> = { playing: 60, restart: 12, goal: 6, intro: 20, halftime: 12 };

export class StateClock {
  private cur = '';
  private t = 0;
  update(state: string, dt: number): { state: string; seconds: number; stuck: boolean } {
    if (state !== this.cur) { this.cur = state; this.t = 0; }
    this.t += dt;
    const lim = STATE_LIMITS[state];
    return { state, seconds: this.t, stuck: lim !== undefined && this.t > lim };
  }
  reset(): void {
    this.t = 0;
  }
}

export interface Snapshot {
  state: string;
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  players: { x: number; y: number }[];
  remaining: number;
  maxRemaining: number;
  home: number;
  away: number;
  half: number;
}

/** Things that must always be true. Returns a list of problems (empty = healthy). */
export function checkInvariants(s: Snapshot, fieldW: number, fieldH: number): string[] {
  const out: string[] = [];
  const fin = (...n: number[]): boolean => n.every(Number.isFinite);
  const b = s.ball;
  if (!fin(b.x, b.y, b.z, b.vx, b.vy, b.vz)) {
    out.push('ball has a non-finite value');
  } else {
    if (s.state === 'playing' && (b.x < -30 || b.x > fieldW + 30 || b.y < -30 || b.y > fieldH + 30)) out.push('ball far outside the pitch while playing');
    if (b.z < -0.01 || b.z > 400) out.push('ball height out of range');
    if (Math.hypot(b.vx, b.vy) > 1200) out.push('ball speed unrealistic');
  }
  s.players.forEach((p, i) => {
    if (!fin(p.x, p.y)) out.push(`player ${i} has a non-finite position`);
    else if ((s.state === 'playing' || s.state === 'restart') && (p.x < -5 || p.x > fieldW + 5 || p.y < -5 || p.y > fieldH + 5)) {
      out.push(`player ${i} left the pitch while playing`);
    }
  });
  if (!Number.isFinite(s.remaining) || s.remaining < 0 || s.remaining > s.maxRemaining) out.push('match clock out of range');
  if (!Number.isInteger(s.home) || !Number.isInteger(s.away) || s.home < 0 || s.away < 0) out.push('score invalid');
  if (s.half < 1 || s.half > 3) out.push('period invalid');
  return out;
}

/** Collects what happened during an automated soak test and turns it into a pass/fail report. */
export class SoakReport {
  matches = 0;
  goals = 0;
  frames = 0;
  shots = 0;
  fouls = 0;
  corners = 0;
  droppedBalls = 0;
  errorCount = 0;
  readonly violations = new Map<string, number>();
  readonly stuck = new Map<string, number>();
  readonly restarts = new Map<string, number>();
  readonly errors: string[] = [];

  note(problems: string[]): void {
    for (const p of problems) this.violations.set(p, (this.violations.get(p) ?? 0) + 1);
  }
  noteStuck(state: string): void {
    this.stuck.set(state, (this.stuck.get(state) ?? 0) + 1);
  }
  noteRestart(kind: string): void {
    this.restarts.set(kind, (this.restarts.get(kind) ?? 0) + 1);
  }
  noteError(msg: string): void {
    this.errorCount++;
    if (this.errors.length < 10) this.errors.push(msg);
  }
  passed(): boolean {
    return this.violations.size === 0 && this.stuck.size === 0 && this.errorCount === 0;
  }

  lines(perf: { fps: number; worstMs: number; slowShare: number }): string[] {
    const fmt = (m: Map<string, number>): string => [...m.entries()].map(([k, v]) => `${k} ×${v}`).join(', ');
    return [
      `SOAK RESULT: ${this.passed() ? 'PASS' : 'FAIL'}`,
      `matches ${this.matches} · goals ${this.goals} · shots ${this.shots} · fouls ${this.fouls} · corners ${this.corners} · frames ${this.frames}`,
      `restarts: ${this.restarts.size ? fmt(this.restarts) : 'none'} · dropped balls ${this.droppedBalls}`,
      `invariant violations: ${this.violations.size ? fmt(this.violations) : 'none'}`,
      `stuck states: ${this.stuck.size ? fmt(this.stuck) : 'none'}`,
      `errors: ${this.errorCount}${this.errors.length ? ' — ' + this.errors.join(' | ') : ''}`,
      `performance: ${perf.fps.toFixed(0)} fps average · worst frame ${perf.worstMs.toFixed(0)} ms · ${(perf.slowShare * 100).toFixed(1)}% slow frames`,
    ];
  }
}
