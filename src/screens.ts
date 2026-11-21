// screens.ts — the start, setup, pause, confirm and controls screens, plus the on-screen context hint.
// Screens only describe menu rows; the game provides the actions through ScreenHost.
import type { GameAudio } from './audio';
import { DIFFS, DIFF_ORDER, HALF_OPTIONS, TEAMS, resolveStyles } from './settings';
import type { MatchSettings, TacticName } from './settings';
import { cycleIndex } from './ui';
import type { MenuItem, MenuScreen } from './ui';

/** What the screens may ask the game to do. */
export interface ScreenHost {
  settings: MatchSettings;
  audio: GameAudio;
  startMatch(): void;
  resume(): void;
  restartMatch(): void;
  quitToTitle(): void;
  persist(): void;                         // save the settings
  refreshAudio(): void;                    // refresh the volume text in the arena
  goTitle(): void;
  goSetup(): void;
  goPause(): void;
  goConfirm(kind: 'restart' | 'quit'): void;
  goControls(back: () => void): void;
}

const TACTIC_LIST: TacticName[] = ['balanced', 'press', 'defensive', 'counter', 'possession'];
const TACTIC_LABEL: Record<TacticName, string> = {
  balanced: 'BALANCED', press: 'HIGH PRESS', defensive: 'DEFENSIVE', counter: 'COUNTER', possession: 'POSSESSION',
};

/** The controls, shown by the Controls screen (true = heading). */
export const CONTROLS_LINES: [string, boolean][] = [
  ['MOVE', true],
  ['WASD / arrow keys  ·  SHIFT to sprint', false],
  ['WITH THE BALL', true],
  ['Z shoot — hold to charge power, ↑ / ↓ aim at a corner', false],
  ['C + Z high shot  ·  V + Z curled shot', false],
  ['X pass  ·  C + X lofted pass over defenders', false],
  ['WITHOUT THE BALL', true],
  ['SPACE tackle (a careless tackle is a foul)  ·  X switch player', false],
  ['RESTARTS (YOUR TURN)', true],
  ['Arrows aim  ·  hold C to charge  ·  release to kick  ·  Z lofted', false],
  ['You have 4 seconds, or the ball goes to the opponent', false],
  ['GAME', true],
  ['P / ESC pause  ·  H this help  ·  T CPU tactic  ·  G your tactic', false],
  ['M mute  ·  [ ] volume  ·  N announcer voice  ·  F fullscreen', false],
];

export type HintState = 'intro' | 'playing' | 'restart' | 'goal' | 'halftime' | 'fulltime';

/** The one-line hint under the pitch: it always shows the controls that matter right now. */
export function contextHint(state: HintState, hasBall: boolean, homeRestart: string | null, limited: boolean): string {
  switch (state) {
    case 'intro': return 'ENTER or click to skip the entrance';
    case 'halftime': return 'ENTER or click to continue';
    case 'fulltime': return 'ENTER or click: rematch   ·   ESC: main menu';
    case 'goal': return '';
    case 'restart':
      if (homeRestart) return 'ARROWS aim  ·  hold C to charge, release to kick  ·  Z lofted' + (limited ? '  ·  4 s!' : '');
      return 'Opponent restart — get back and mark';
    default:
      return hasBall
        ? 'Z shoot (hold = power)  ·  X pass  ·  C+X lob  ·  V+Z curl  ·  SHIFT sprint'
        : 'SPACE tackle  ·  X switch player  ·  SHIFT sprint  ·  H help';
  }
}

// ── Building blocks ──────────────────────────────────────────────────────
const action = (label: string, onActivate: () => void): MenuItem => ({ kind: 'action', label: () => label, onActivate });
const spacer = (): MenuItem => ({ kind: 'spacer', label: () => '' });

function soundItem(h: ScreenHost): MenuItem {
  const text = (): string => `SOUND:   ◀  ${h.audio.muted ? 'MUTED' : 'VOLUME ' + Math.round(h.audio.volume * 100) + '%'}  ▶`;
  return {
    kind: 'option', label: text,
    onLeft: () => { h.audio.unlock(); h.audio.changeVolume(-0.1); h.refreshAudio(); },
    onRight: () => { h.audio.unlock(); h.audio.changeVolume(0.1); h.refreshAudio(); },
  };
}

// ── Screens ──────────────────────────────────────────────────────────────
export function buildTitle(h: ScreenHost): MenuScreen {
  const s = h.settings;
  return {
    title: "RETRO KICK '97", big: true,
    subtitle: `${TEAMS[s.homeTeam].name} vs ${TEAMS[s.awayTeam].name}  ·  ${DIFFS[s.difficulty].label}  ·  ${HALF_OPTIONS[s.halfIdx] / 60} min halves`,
    footer: '↑ ↓ select  ·  ← → change  ·  ENTER confirm  ·  the mouse works too',
    items: [
      action('▶   PLAY MATCH', () => h.startMatch()),
      action('TEAMS & MATCH SETTINGS', () => h.goSetup()),
      action('HOW TO PLAY / CONTROLS', () => h.goControls(() => h.goTitle())),
      soundItem(h),
    ],
  };
}

export function buildSetup(h: ScreenHost): MenuScreen {
  const s = h.settings;
  const opt = (name: string, value: () => string, change: (d: number) => void, swatch?: () => number[]): MenuItem => ({
    kind: 'option',
    label: () => `${name}:   ◀  ${value()}  ▶`,
    onLeft: () => { change(-1); h.persist(); },
    onRight: () => { change(1); h.persist(); },
    swatch,
  });
  const tactic = (get: () => TacticName, set: (t: TacticName) => void) => (d: number): void => {
    set(TACTIC_LIST[cycleIndex(TACTIC_LIST.indexOf(get()), d, TACTIC_LIST.length)]);
  };
  return {
    title: 'TEAMS & MATCH SETTINGS',
    subtitle: 'Kits are shown at the end of each team row — a clash is fixed automatically',
    footer: '← → change a value  ·  ENTER start  ·  ESC back',
    onBack: () => h.goTitle(),
    items: [
      opt('YOUR TEAM', () => TEAMS[s.homeTeam].name, (d) => { s.homeTeam = cycleIndex(s.homeTeam, d, TEAMS.length); },
        () => { const r = resolveStyles(s.homeTeam, s.awayTeam); return [r.home.jersey, r.home.shorts, r.home.gk]; }),
      opt('OPPONENT', () => TEAMS[s.awayTeam].name, (d) => { s.awayTeam = cycleIndex(s.awayTeam, d, TEAMS.length); },
        () => { const r = resolveStyles(s.homeTeam, s.awayTeam); return [r.away.jersey, r.away.shorts, r.away.gk]; }),
      opt('DIFFICULTY', () => DIFFS[s.difficulty].label,
        (d) => { s.difficulty = DIFF_ORDER[cycleIndex(DIFF_ORDER.indexOf(s.difficulty), d, DIFF_ORDER.length)]; }),
      opt('HALF LENGTH', () => `${HALF_OPTIONS[s.halfIdx] / 60} MIN`, (d) => { s.halfIdx = cycleIndex(s.halfIdx, d, HALF_OPTIONS.length); }),
      opt('EXTRA TIME', () => (s.extraTime ? 'ON (golden goal)' : 'OFF'), () => { s.extraTime = !s.extraTime; }),
      opt('YOUR TACTIC', () => TACTIC_LABEL[s.homeTactic], tactic(() => s.homeTactic, (t) => { s.homeTactic = t; })),
      opt('CPU TACTIC', () => TACTIC_LABEL[s.awayTactic], tactic(() => s.awayTactic, (t) => { s.awayTactic = t; })),
      spacer(),
      action('▶   START MATCH', () => h.startMatch()),
      action('◀   BACK', () => h.goTitle()),
    ],
  };
}

export function buildPause(h: ScreenHost): MenuScreen {
  return {
    title: 'PAUSED',
    footer: 'ESC or P to resume',
    onBack: () => h.resume(),
    items: [
      action('▶   RESUME', () => h.resume()),
      action('CONTROLS', () => h.goControls(() => h.goPause())),
      soundItem(h),
      action('RESTART MATCH', () => h.goConfirm('restart')),
      action('QUIT TO MAIN MENU', () => h.goConfirm('quit')),
    ],
  };
}

export function buildConfirm(h: ScreenHost, kind: 'restart' | 'quit'): MenuScreen {
  const restart = kind === 'restart';
  return {
    title: restart ? 'RESTART MATCH?' : 'QUIT TO MAIN MENU?',
    subtitle: 'The current score and statistics will be lost.',
    footer: 'ESC to go back',
    onBack: () => h.goPause(),
    items: [
      action(restart ? 'YES, RESTART' : 'YES, QUIT', () => (restart ? h.restartMatch() : h.quitToTitle())),
      action('NO, GO BACK', () => h.goPause()),
    ],
  };
}

export function buildControls(h: ScreenHost, back: () => void): MenuScreen {
  void h;
  const lines: MenuItem[] = CONTROLS_LINES.map(([text, heading]) => ({
    kind: 'info' as const, label: () => text, color: heading ? '#ffd23f' : undefined,
  }));
  return {
    title: 'HOW TO PLAY',
    subtitle: 'Beat the CPU: win the ball, build with passes, finish with the right shot',
    footer: 'ESC to go back',
    onBack: back,
    items: [...lines, spacer(), action('◀   BACK', back)],
  };
}
