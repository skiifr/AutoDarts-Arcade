import { MISS, makeSegment, miss, points, type Segment } from '@arcade/event-schema';
import { useSyncExternalStore } from 'react';

/**
 * Stand-in game state for the visual shell ONLY. It sums points for every game so the
 * screens have something to show. Phase 3 replaces it with the event-sourced engine
 * (ARCHITECTURE §8); Phase 2 replaces `throwDart` with the board adapter.
 */
export interface ShellPlayer {
  id: string;
  name: string;
  colorIndex: number;
  score: number;
  darts: number;
  scoringDarts: number;
  bestTurn: number;
}

export interface ShellDart {
  id: string;
  segment: Segment;
  adjusted?: boolean;
}

export type ShellBanner = 'none' | 'takeout' | 'offline' | 'review' | 'stuck';

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
}

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
};

let state: ShellState = initial;
const listeners = new Set<() => void>();

function set(next: Partial<ShellState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function updatePlayer(index: number, fn: (p: ShellPlayer) => ShellPlayer): ShellPlayer[] {
  return state.players.map((p, i) => (i === index ? fn(p) : p));
}

/** Plausible throws for a pub-level player aiming at 20. */
function randomDart(): Segment {
  const r = Math.random();
  if (r < 0.28) return makeSegment(20, 1, Math.random() < 0.5 ? 'single-outer' : 'single-inner');
  if (r < 0.4) return makeSegment(20, 3);
  if (r < 0.5) return makeSegment(1, 1, 'single-outer');
  if (r < 0.6) return makeSegment(5, 1, 'single-outer');
  if (r < 0.65) return makeSegment(20, 2);
  if (r < 0.71) return miss(Math.random() < 0.5 ? 5 : 1);
  if (r < 0.76) return makeSegment(25, 1);
  if (r < 0.78) return makeSegment(25, 2);
  const n = 1 + Math.floor(Math.random() * 20);
  return makeSegment(n, 1, 'single-outer');
}

export const demo = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  start(gameId: string, names: { name: string; colorIndex: number }[], maxRounds: number) {
    set({
      ...initial,
      gameId,
      maxRounds,
      players: names.map((n, i) => ({
        id: `p${i}`,
        name: n.name,
        colorIndex: n.colorIndex,
        score: 0,
        darts: 0,
        scoringDarts: 0,
        bestTurn: 0,
      })),
    });
  },

  throwDart(segment: Segment = randomDart()) {
    if (state.finished || state.turn.length >= 3 || state.banner === 'takeout') return;
    const dart: ShellDart = { id: id(), segment };
    const turn = [...state.turn, dart];
    set({
      turn,
      lastDartId: dart.id,
      // The board reports "Takeout" status on the third dart (ARCHITECTURE §4.3).
      banner: turn.length === 3 ? 'takeout' : state.banner === 'review' ? 'review' : 'none',
      players: updatePlayer(state.current, (p) => ({
        ...p,
        score: p.score + points(segment),
        darts: p.darts + 1,
        scoringDarts: p.scoringDarts + (points(segment) > 0 ? 1 : 0),
      })),
    });
  },

  /** Board cleared: the turn ends and play moves on. */
  takeout() {
    if (state.finished) return;
    const turnTotal = state.turn.reduce((sum, d) => sum + points(d.segment), 0);
    const players = updatePlayer(state.current, (p) => ({ ...p, bestTurn: Math.max(p.bestTurn, turnTotal) }));
    const wraps = state.current === state.players.length - 1;
    const round = wraps ? state.round + 1 : state.round;
    set({
      players,
      turn: [],
      lastDartId: null,
      banner: 'none',
      current: wraps ? 0 : state.current + 1,
      round: Math.min(round, state.maxRounds),
      finished: wraps && round > state.maxRounds,
    });
  },

  correct(index: number, segment: Segment) {
    const old = state.turn[index];
    if (!old) return;
    const delta = points(segment) - points(old.segment);
    const scored = (points(segment) > 0 ? 1 : 0) - (points(old.segment) > 0 ? 1 : 0);
    set({
      turn: state.turn.map((d, i) => (i === index ? { ...d, segment, adjusted: true } : d)),
      players: updatePlayer(state.current, (p) => ({ ...p, score: p.score + delta, scoringDarts: p.scoringDarts + scored })),
      banner: state.banner === 'review' ? 'none' : state.banner,
    });
  },

  voidDart(index: number) {
    const old = state.turn[index];
    if (!old) return;
    set({
      turn: state.turn.filter((_, i) => i !== index),
      players: updatePlayer(state.current, (p) => ({
        ...p,
        score: p.score - points(old.segment),
        darts: p.darts - 1,
        scoringDarts: p.scoringDarts - (points(old.segment) > 0 ? 1 : 0),
      })),
      banner: state.banner === 'takeout' ? 'none' : state.banner,
    });
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

  finish() {
    const turnTotal = state.turn.reduce((sum, d) => sum + points(d.segment), 0);
    set({
      finished: true,
      banner: 'none',
      players: updatePlayer(state.current, (p) => ({ ...p, bestTurn: Math.max(p.bestTurn, turnTotal) })),
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

export function standings(players: ShellPlayer[]) {
  return [...players].sort((a, b) => b.score - a.score);
}
