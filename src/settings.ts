// settings.ts — teams, kits, difficulty and match settings. Pure data and logic (no Phaser).

export type TeamSide = 'home' | 'away';
export type TacticName = 'balanced' | 'press' | 'defensive' | 'counter' | 'possession';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface TeamPreset {
  name: string; short: string;
  jersey: number; jerseyDark: number; shorts: number; socks: number;
  accent: number;                       // used for banners, scoreboard names, highlights
}

/** A team as it appears in the current match (kit may be changed to avoid a clash). */
export interface TeamStyle extends TeamPreset {
  gk: number;                           // goalkeeper shirt colour
  fans: number[];                       // supporter shirt colours
}

export const TEAMS: TeamPreset[] = [
  { name: 'Rockets',             short: 'ROCKETS', jersey: 0x2d7fff, jerseyDark: 0x0a4fb5, shorts: 0x0a4fb5, socks: 0xffffff, accent: 0x4da3ff },
  { name: 'Comets',              short: 'COMETS',  jersey: 0xff3b47, jerseyDark: 0xb01822, shorts: 0xb01822, socks: 0xffffff, accent: 0xff6b6b },
  { name: 'Lagos Eagles',        short: 'EAGLES',  jersey: 0x1fa65a, jerseyDark: 0x0f6b38, shorts: 0xffffff, socks: 0x1fa65a, accent: 0x3ddc84 },
  { name: 'Abuja Lions',         short: 'LIONS',   jersey: 0xf2b705, jerseyDark: 0xa87c00, shorts: 0x1a1a1a, socks: 0xf2b705, accent: 0xffd23f },
  { name: 'Kano Stars',          short: 'STARS',   jersey: 0xf5f5f5, jerseyDark: 0xb5b5b5, shorts: 0x1b8a4a, socks: 0xffffff, accent: 0xffffff },
  { name: 'Port Harcourt Waves', short: 'WAVES',   jersey: 0x14b8c4, jerseyDark: 0x0b7c85, shorts: 0x0b7c85, socks: 0xffffff, accent: 0x5ee6f0 },
  { name: 'Ibadan Hawks',        short: 'HAWKS',   jersey: 0x8e44ad, jerseyDark: 0x5b2c70, shorts: 0x5b2c70, socks: 0xffffff, accent: 0xc39bd3 },
];

// ── Colour helpers ───────────────────────────────────────────────────────
export function scaleColor(c: number, f: number): number {
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * f)));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

export function colorDistance(a: number, b: number): number {
  return Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
}

const GK_COLORS = [0x9b59b6, 0xff9800, 0x2ecc71, 0xf1c40f, 0xe84393, 0xd35400, 0x16a085, 0x7f8c8d];

/** First goalkeeper colour that stands out from both teams; otherwise the best available one. */
export function pickGkColor(own: number, opp: number, exclude: number[]): number {
  let best = GK_COLORS[0];
  let bestScore = -1;
  for (const c of GK_COLORS) {
    if (exclude.includes(c)) continue;
    const s = Math.min(colorDistance(c, own), colorDistance(c, opp));
    if (s >= 130) return c;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function styleFrom(p: TeamPreset): TeamStyle {
  return { ...p, gk: 0, fans: [p.jersey, p.jerseyDark, 0xffffff, scaleColor(p.jersey, 1.25)] };
}

/** Builds both teams' styles. If the two shirts are too similar, the away team plays in an alternative kit. */
export function resolveStyles(homeIdx: number, awayIdx: number): { home: TeamStyle; away: TeamStyle } {
  const home = styleFrom(TEAMS[homeIdx]);
  let away = styleFrom(TEAMS[awayIdx]);
  if (colorDistance(home.jersey, away.jersey) < 120) {
    const alts = [0xf0f0f0, 0x222831, 0xf2b705, 0x2d7fff];
    let best = alts[0];
    let bs = -1;
    for (const a of alts) {
      const s = colorDistance(a, home.jersey);
      if (s > bs) { bs = s; best = a; }
    }
    away = {
      ...away, jersey: best, jerseyDark: scaleColor(best, 0.7), shorts: scaleColor(best, 0.55),
      fans: [best, scaleColor(best, 0.7), 0xffffff, scaleColor(best, 1.2)],
    };
  }
  home.gk = pickGkColor(home.jersey, away.jersey, []);
  away.gk = pickGkColor(away.jersey, home.jersey, [home.gk]);
  return { home, away };
}

/** The styles of the current match. Mutated by setStyles(); importers always see the latest values. */
export const STYLE: { home: TeamStyle; away: TeamStyle } = resolveStyles(0, 1);

export function setStyles(homeIdx: number, awayIdx: number): void {
  const r = resolveStyles(homeIdx, awayIdx);
  STYLE.home = r.home;
  STYLE.away = r.away;
}

// ── Difficulty (it only changes the CPU opponent) ──────────────────────────
export interface DiffParams {
  label: string;
  cpuSpeed: number;                     // CPU movement speed multiplier
  gkReact: [number, number];            // CPU keeper reaction time range (s)
  gkErr: number;                        // CPU keeper misjudgement (px)
  think: number;                        // seconds between CPU ball-carrier decisions
  tackleWin: number;                    // CPU tackle: roll below this wins the ball (out of 100)
  foul: number;                         // CPU tackle: roll below this is a foul (out of 100)
  shotErr: number;                      // extra random error on CPU shots (rad)
}

export const DIFFS: Record<Difficulty, DiffParams> = {
  easy:   { label: 'EASY',   cpuSpeed: 0.85, gkReact: [0.20, 0.32], gkErr: 11,  think: 0.40, tackleWin: 45, foul: 14, shotErr: 0.06 },
  normal: { label: 'NORMAL', cpuSpeed: 1.0,  gkReact: [0.12, 0.20], gkErr: 6,   think: 0.28, tackleWin: 60, foul: 10, shotErr: 0 },
  hard:   { label: 'HARD',   cpuSpeed: 1.1,  gkReact: [0.09, 0.14], gkErr: 3.5, think: 0.20, tackleWin: 70, foul: 8,  shotErr: 0 },
};
export const DIFF_ORDER: Difficulty[] = ['easy', 'normal', 'hard'];

// ── Match settings ───────────────────────────────────────────────────────
export const HALF_OPTIONS = [60, 120, 180, 300];      // seconds per half
const TACTIC_NAMES: TacticName[] = ['balanced', 'press', 'defensive', 'counter', 'possession'];

export interface MatchSettings {
  homeTeam: number;
  awayTeam: number;
  difficulty: Difficulty;
  halfIdx: number;                      // index into HALF_OPTIONS
  extraTime: boolean;                   // golden-goal extra time when level after the second half
  homeTactic: TacticName;
  awayTactic: TacticName;
}

export function defaultSettings(): MatchSettings {
  return { homeTeam: 0, awayTeam: 1, difficulty: 'normal', halfIdx: 1, extraTime: true, homeTactic: 'balanced', awayTactic: 'balanced' };
}

const isIdx = (v: unknown, n: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n;

/** Accepts anything (e.g. a corrupt saved value) and returns valid settings; invalid fields fall back to defaults. */
export function sanitizeSettings(raw: unknown): MatchSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    homeTeam: isIdx(r.homeTeam, TEAMS.length) ? r.homeTeam : d.homeTeam,
    awayTeam: isIdx(r.awayTeam, TEAMS.length) ? r.awayTeam : d.awayTeam,
    difficulty: DIFF_ORDER.includes(r.difficulty as Difficulty) ? (r.difficulty as Difficulty) : d.difficulty,
    halfIdx: isIdx(r.halfIdx, HALF_OPTIONS.length) ? r.halfIdx : d.halfIdx,
    extraTime: typeof r.extraTime === 'boolean' ? r.extraTime : d.extraTime,
    homeTactic: TACTIC_NAMES.includes(r.homeTactic as TacticName) ? (r.homeTactic as TacticName) : d.homeTactic,
    awayTactic: TACTIC_NAMES.includes(r.awayTactic as TacticName) ? (r.awayTactic as TacticName) : d.awayTactic,
  };
}

/**
 * URL options (handy for testing): ?team=3&opp=2&level=hard&half=60&extra=0&tactic=press&home=counter
 * team/opp = team index, half = seconds, tactic = CPU tactic, home = your tactic. Invalid values are ignored.
 */
export function settingsFromQuery(qs: URLSearchParams, base: MatchSettings): MatchSettings {
  const out: MatchSettings = { ...base };
  const num = (k: string): number | null => {
    const v = qs.get(k);
    if (v === null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const team = num('team');
  if (team !== null && isIdx(team, TEAMS.length)) out.homeTeam = team;
  const opp = num('opp');
  if (opp !== null && isIdx(opp, TEAMS.length)) out.awayTeam = opp;
  const level = qs.get('level');
  if (level && DIFF_ORDER.includes(level as Difficulty)) out.difficulty = level as Difficulty;
  const half = num('half');
  if (half !== null && HALF_OPTIONS.includes(half)) out.halfIdx = HALF_OPTIONS.indexOf(half);
  const extra = qs.get('extra');
  if (extra === '0' || extra === '1') out.extraTime = extra === '1';
  const tac = qs.get('tactic');
  if (tac && TACTIC_NAMES.includes(tac as TacticName)) out.awayTactic = tac as TacticName;
  const home = qs.get('home');
  if (home && TACTIC_NAMES.includes(home as TacticName)) out.homeTactic = home as TacticName;
  return out;
}

const STORAGE_KEY = 'rk97.settings';

export function loadSettings(): MatchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : defaultSettings();
  } catch (_e) {
    return defaultSettings();
  }
}

export function saveSettings(s: MatchSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_e) { /* storage unavailable */ }
}
