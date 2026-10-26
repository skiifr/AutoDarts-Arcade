import { createRng, ulidFromNumber, type GameEffect, type GameModule, type Rng, type ScoredDart, type TurnCtx } from '@arcade/engine';
import {
  BOARD_NUMBERS_CLOCKWISE,
  INNER_BULL,
  MISS,
  OUTER_BULL,
  makeSegment,
  miss,
  points,
  type PlayerRef,
  type Segment,
  type Standing,
} from '@arcade/event-schema';
import { gameById as moduleById, type BaseView } from '@arcade/games';
import type { AroundTheClockView } from '@arcade/games/src/around-the-clock/module';
import type { CountdownView } from '@arcade/games/src/countdown/module';
import { useSyncExternalStore } from 'react';

/**
 * Demo driver for the visual shell: THROWAWAY until Phase 4 wires the engine's session host.
 *
 * Countdown, Cricket, Around the Clock and Siege run their real game module, called the way
 * the host calls it (init; nextPlayer once with an opening ctx; then onDart per dart and
 * onTurnEnd + nextPlayer per visit), all from one Rng made by `createRng(seed)`. The finished
 * visits are kept, and every change refolds the whole game from the seed, so corrections from
 * W4 replay exactly. Territory and Balloon Pop have no rules yet and fall back to a points sum.
 * `throwDart` stands in for the board adapter (Phase 2).
 */
export interface ShellPlayer {
  id: string;
  name: string;
  colorIndex: number;
  /** The game's own number for this player (wall, remaining, points, progress…). */
  score: number;
  /** The game's second line, e.g. "4 destroyed". */
  detail: string;
  out: boolean;
  /** Final place once the game is over. */
  rank?: number;
  darts: number;
  scoringDarts: number;
  bestTurn: number;
}

export interface ShellDart {
  id: string;
  segment: Segment;
  adjusted?: boolean;
  /** False for a dart thrown after the game ended the visit (bust, finish): shown, not scored. */
  scored?: boolean;
}

export type ShellBanner = 'none' | 'takeout' | 'offline' | 'review' | 'stuck';

export interface TurnSummary {
  label: string;
  value: string;
}

export interface ShellState {
  gameId: string;
  players: ShellPlayer[];
  round: number;
  maxRounds: number;
  current: number;
  turn: ShellDart[];
  banner: ShellBanner;
  finished: boolean;
  lastDartId: string | null;
  /** The game's view: BaseView plus its own stage data (a SiegeView for Siege…). */
  view: BaseView | null;
  /** The game ended this visit early: later darts are shown but not scored. */
  turnEnded: 'bust' | 'game-rule' | null;
  /** The "Up now" panel's turn line, in the game's terms. */
  turnSummary: TurnSummary;
  /** False for Territory and Balloon Pop, which run on the points-sum fallback. */
  realRules: boolean;
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────

type Rules = Pick<GameModule<unknown, unknown, BaseView>, 'init' | 'onDart' | 'onTurnEnd' | 'nextPlayer' | 'result' | 'view'>;

interface SumPlayer {
  playerId: string;
  name: string;
  colorIndex: number;
  score: number;
}
interface SumState {
  players: SumPlayer[];
  current: number;
  round: number;
  rounds: number;
  finished: boolean;
}

function sumResult(state: SumState): Standing[] | null {
  if (!state.finished) return null;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  return sorted.map((p) => ({ playerId: p.playerId, rank: sorted.findIndex((q) => q.score === p.score) + 1, score: p.score }));
}

/** The old placeholder: highest points total after the rounds. For games without rules yet. */
const pointsSum: Pick<GameModule<{ rounds: number }, SumState, BaseView>, keyof Rules> = {
  init: ({ players, options }) => ({
    players: players.map((p) => ({ playerId: p.playerId, name: p.displayName, colorIndex: p.colorIndex, score: 0 })),
    current: 0,
    round: 1,
    rounds: options.rounds,
    finished: false,
  }),
  onDart: (state, dart) => ({
    state: { ...state, players: state.players.map((p) => (p.playerId === dart.playerId ? { ...p, score: p.score + dart.points } : p)) },
  }),
  onTurnEnd: (state, ctx) => {
    const next = (state.players.findIndex((p) => p.playerId === ctx.playerId) + 1) % state.players.length;
    if (next !== 0) return { state: { ...state, current: next } };
    if (state.round < state.rounds) return { state: { ...state, current: 0, round: state.round + 1 } };
    return { state: { ...state, current: 0, finished: true } };
  },
  nextPlayer: (state) => (state.finished ? null : state.players[state.current]!.playerId),
  result: sumResult,
  view: (state) => ({
    gameId: 'demo',
    headline: `${state.players[state.current]!.name} to throw`,
    round: state.round,
    maxRounds: state.rounds,
    finished: state.finished,
    current: state.finished ? null : state.players[state.current]!.playerId,
    targets: [20],
    scoreboard: state.players.map((p, seat) => ({
      playerId: p.playerId,
      name: p.name,
      colorIndex: p.colorIndex,
      score: p.score,
      detail: 'demo scoring',
      active: !state.finished && seat === state.current,
      out: false,
    })),
  }),
};

// ── Session and replay ───────────────────────────────────────────────────────────────────

interface Session {
  rules: Rules;
  options: unknown;
  players: PlayerRef[];
  seed: string;
  /** Finished visits, in throwing order. */
  visits: ShellDart[][];
  /** Picks demo darts. Its own stream, so the game's Rng only sees the game's draws. */
  thrower: Rng;
}

interface Replay {
  view: BaseView;
  /** Throwing now, or null once the game is over. */
  playerId: string | null;
  standings: Standing[] | null;
  ended: 'bust' | 'game-rule' | null;
  /** How many of the current visit's darts reached the game. */
  scoredCount: number;
  effects: GameEffect[];
  turnStartView: BaseView;
  stats: { darts: number; scoring: number; best: number }[];
}

function replay(session: Session, current: readonly ShellDart[]): Replay {
  const { rules, players } = session;
  const rng = createRng(session.seed);
  let state = rules.init({ players, options: session.options, rng });
  const opening: TurnCtx = { playerId: players[0]!.playerId, turnIndex: 0, roundIndex: 0, dartsThisTurn: [], rng };
  let playerId = rules.nextPlayer(state, opening);
  let roundIndex = 0;
  let lastSeat = -1;
  let throwCount = 0;
  const stats = players.map(() => ({ darts: 0, scoring: 0, best: 0 }));

  const playVisit = (thrower: string, darts: readonly ShellDart[], turnIndex: number) => {
    const seat = players.findIndex((p) => p.playerId === thrower);
    if (lastSeat >= 0 && seat <= lastSeat) roundIndex++;
    lastSeat = seat;
    const scored: ScoredDart[] = [];
    const effects: GameEffect[] = [];
    let ended: Replay['ended'] = null;
    let total = 0;
    for (const d of darts) {
      const value = points(d.segment);
      stats[seat]!.darts++;
      if (value > 0) stats[seat]!.scoring++;
      // After an early end (or the game's end) darts are recorded but never reach the game.
      if (ended !== null || rules.result(state) !== null) continue;
      const dart: ScoredDart = {
        throwId: ulidFromNumber(++throwCount),
        playerId: thrower,
        turnIndex,
        dartIndex: scored.length as 0 | 1 | 2,
        segment: d.segment,
        points: value,
      };
      const step = rules.onDart(state, dart, { playerId: thrower, turnIndex, roundIndex, dartsThisTurn: [...scored], rng });
      state = step.state;
      scored.push(dart);
      effects.push(...(step.effects ?? []));
      ended = step.endTurn ?? null;
      total += value;
    }
    stats[seat]!.best = Math.max(stats[seat]!.best, total);
    const ctx: TurnCtx = { playerId: thrower, turnIndex, roundIndex, dartsThisTurn: scored, rng };
    return { ctx, effects, ended, scoredCount: scored.length };
  };

  session.visits.forEach((darts, turnIndex) => {
    if (playerId === null) return;
    const { ctx } = playVisit(playerId, darts, turnIndex);
    state = rules.onTurnEnd(state, ctx).state;
    playerId = rules.nextPlayer(state, ctx);
  });

  const turnStartView = rules.view(state);
  const visit = playerId === null ? null : playVisit(playerId, current, session.visits.length);
  return {
    view: rules.view(state),
    playerId,
    standings: rules.result(state),
    ended: visit?.ended ?? null,
    scoredCount: visit?.scoredCount ?? 0,
    effects: visit?.effects ?? [],
    turnStartView,
    stats,
  };
}

const CRICKET_NUMBERS = new Set([15, 16, 17, 18, 19, 20, 25]);

/** The "Up now" turn line in each game's own terms. */
function summarize(gameId: string, r: Replay, turn: readonly ShellDart[], seat: number): TurnSummary {
  const counted = turn.slice(0, r.scoredCount);
  switch (gameId) {
    case 'countdown': {
      const visit = (r.view as CountdownView).visit;
      if (turn.length === 0 || !visit) return { label: 'Turn total', value: '0' };
      return { label: 'Turn total', value: visit.bust ? 'BUST' : String(visit.points) };
    }
    case 'cricket': {
      const marks = counted.reduce((sum, d) => sum + (CRICKET_NUMBERS.has(d.segment.number) ? d.segment.multiplier : 0), 0);
      return { label: 'Marks this turn', value: String(marks) };
    }
    case 'siege': {
      const destroyed = r.effects.reduce((sum, e) => {
        const n = e.data?.destroyed;
        return sum + (typeof n === 'number' ? n : 0);
      }, 0);
      return { label: 'Destroyed', value: String(destroyed) };
    }
    case 'around-the-clock': {
      const now = (r.view as AroundTheClockView).players[seat]?.progress ?? 0;
      const before = (r.turnStartView as AroundTheClockView).players[seat]?.progress ?? 0;
      return { label: 'Moved on', value: `+${now - before}` };
    }
    default:
      return { label: 'Turn total', value: String(counted.reduce((sum, d) => sum + points(d.segment), 0)) };
  }
}

/** A pub-level dart at `target`: mostly the number, sometimes a double or treble, often a neighbour. */
function aimedDart(rng: Rng, target: number): Segment {
  const r = rng.next();
  if (target === 25) {
    if (r < 0.12) return INNER_BULL;
    if (r < 0.38) return OUTER_BULL;
    if (r < 0.9) return makeSegment(rng.int(1, 20), 1, 'single-inner');
    return miss();
  }
  if (r < 0.1) return makeSegment(target, 3);
  if (r < 0.18) return makeSegment(target, 2);
  if (r < 0.62) return makeSegment(target, 1, r < 0.4 ? 'single-inner' : 'single-outer');
  if (r < 0.94) {
    const at = BOARD_NUMBERS_CLOCKWISE.indexOf(target as (typeof BOARD_NUMBERS_CLOCKWISE)[number]);
    return makeSegment(BOARD_NUMBERS_CLOCKWISE[(at + (rng.next() < 0.5 ? 19 : 1)) % 20]!, 1, 'single-outer');
  }
  return miss(target);
}

// ── Store ────────────────────────────────────────────────────────────────────────────────

let nextId = 1;
const id = () => `d${nextId++}`;

const initial: ShellState = {
  gameId: 'siege',
  players: [],
  round: 1,
  maxRounds: 3,
  current: 0,
  turn: [],
  banner: 'none',
  finished: false,
  lastDartId: null,
  view: null,
  turnEnded: null,
  turnSummary: { label: 'Turn total', value: '0' },
  realRules: true,
};

let state: ShellState = initial;
let session: Session | null = null;
/** Games whose lowest score wins, for "End game now" before the rules decide. */
const LOWER_WINS = new Set(['countdown']);
const listeners = new Set<() => void>();

function set(next: Partial<ShellState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Refolds the game with `turn` as the visit in progress and publishes the result. */
function publish(turn: ShellDart[], extra: Partial<ShellState> = {}): Replay | null {
  if (!session) return null;
  const r = replay(session, turn);
  const rank = new Map(r.standings?.map((s) => [s.playerId, s.rank]));
  const seat = r.playerId === null ? state.current : session.players.findIndex((p) => p.playerId === r.playerId);
  const players = session.players.map((p, i): ShellPlayer => {
    const row = r.view.scoreboard[i];
    const stats = r.stats[i]!;
    return {
      id: p.playerId,
      name: p.displayName,
      colorIndex: p.colorIndex,
      score: row?.score ?? 0,
      detail: row?.detail ?? '',
      out: row?.out ?? false,
      rank: rank.get(p.playerId),
      darts: stats.darts,
      scoringDarts: stats.scoring,
      bestTurn: stats.best,
    };
  });
  set({
    players,
    round: r.view.round,
    maxRounds: r.view.maxRounds,
    current: seat,
    turn: turn.map((d, i) => ({ ...d, scored: i < r.scoredCount })),
    view: r.view,
    turnEnded: r.ended,
    turnSummary: summarize(state.gameId, r, turn, seat),
    finished: r.standings !== null || r.playerId === null,
    ...extra,
  });
  return r;
}

export const demo = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** `maxRounds` goes to the module's rounds option when it accepts that value; otherwise its default. */
  start(gameId: string, names: { name: string; colorIndex: number }[], maxRounds: number, seed = `demo-${Date.now().toString(36)}`) {
    const module = moduleById(gameId);
    const rules: Rules = module ?? (pointsSum as Rules);
    let options: unknown = { rounds: maxRounds };
    if (module) {
      // Siege calls it `rounds`, the classics `maxRounds`; zod drops the key a game doesn't use.
      const parsed = module.options.safeParse({ rounds: maxRounds, maxRounds });
      options = parsed.success ? parsed.data : module.options.parse({});
    }
    session = {
      rules,
      options,
      players: names.map((n, i) => ({ playerId: ulidFromNumber(i + 1), displayName: n.name, colorIndex: n.colorIndex, kind: 'guest' })),
      seed,
      visits: [],
      thrower: createRng(`darts:${seed}`),
    };
    state = { ...initial, gameId, realRules: !!module };
    publish([], { banner: 'none', lastDartId: null });
  },

  throwDart(segment?: Segment) {
    if (!session || state.finished || state.turn.length >= 3 || state.banner === 'takeout') return;
    let dartSegment = segment;
    if (!dartSegment) {
      const targets = state.view?.targets ?? [];
      const pick = session.thrower.next() < 0.7 ? 0 : session.thrower.int(0, Math.max(0, targets.length - 1));
      dartSegment = aimedDart(session.thrower, targets[pick] ?? 20);
    }
    const dart: ShellDart = { id: id(), segment: dartSegment };
    const turn = [...state.turn, dart];
    const r = publish(turn, { lastDartId: dart.id });
    // The board reports "Takeout" after the third dart (ARCHITECTURE §4.3); a bust or a
    // finish also waits for the darts to come out.
    const done = turn.length === 3 || (r?.ended ?? null) !== null;
    set({ banner: state.finished ? 'none' : done ? 'takeout' : state.banner === 'review' ? 'review' : 'none' });
  },

  /** Board cleared: the visit ends and play moves on. */
  takeout() {
    if (!session || state.finished) return;
    session.visits.push(state.turn.map((d) => ({ ...d })));
    publish([], { lastDartId: null, banner: 'none' });
  },

  correct(index: number, segment: Segment) {
    const old = state.turn[index];
    if (!old) return;
    publish(
      state.turn.map((d, i) => (i === index ? { ...d, segment, adjusted: true } : d)),
      { banner: state.banner === 'review' ? 'none' : state.banner },
    );
  },

  voidDart(index: number) {
    if (!state.turn[index]) return;
    publish(
      state.turn.filter((_, i) => i !== index),
      { banner: state.banner === 'takeout' ? 'none' : state.banner },
    );
  },

  addDart(segment: Segment = MISS) {
    if (state.turn.length >= 3) return;
    demo.throwDart(segment);
    const last = state.turn[state.turn.length - 1];
    if (last) set({ turn: state.turn.map((d) => (d.id === last.id ? { ...d, adjusted: true } : d)) });
  },

  setBanner(banner: ShellBanner) {
    set({ banner });
  },

  /** "End game now": rank on the scores as they stand. */
  finish() {
    const lower = LOWER_WINS.has(state.gameId);
    const sorted = [...state.players].sort((a, b) => (lower ? a.score - b.score : b.score - a.score));
    set({
      finished: true,
      banner: 'none',
      players: state.players.map((p) => ({ ...p, rank: sorted.findIndex((q) => q.score === p.score) + 1 })),
    });
  },

  rematch() {
    demo.start(
      state.gameId,
      state.players.map((p) => ({ name: p.name, colorIndex: p.colorIndex })),
      state.maxRounds,
    );
  },
};

export function useDemo(): ShellState {
  return useSyncExternalStore(demo.subscribe, demo.getState, demo.getState);
}

/** Best first: by the game's ranking once it has one, otherwise by score. */
export function standings(players: ShellPlayer[]) {
  return [...players].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.score - a.score);
}
