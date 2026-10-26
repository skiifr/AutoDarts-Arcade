import type { RandomSource, Scheduler, TimerHandle } from '../ports';
import type { BoardModel, BoardModelOptions } from './board-model';

/** A physical action on the board model, with timing for the fake-board tool. */
export type BoardAction =
  | { do: 'throw'; segment?: string }
  | { do: 'bounce'; segment?: string }
  | { do: 'startTakeout' }
  | { do: 'finishTakeout' }
  /** Start a takeout, then finish it after a realistic 0.6–2 s. */
  | { do: 'takeout' }
  | { do: 'hand' }
  | { do: 'stuck' }
  | { do: 'reset' }
  | { do: 'phantom'; segment?: string }
  | { do: 'withdraw'; index?: number }
  | { do: 'change'; index?: number; segment?: string }
  | { do: 'wait'; ms: number }
  /** Up to three random darts (sometimes a bounce-out), then a takeout. */
  | { do: 'random-visit' };

export interface Scenario {
  name: string;
  description: string;
  steps: BoardAction[];
  loop?: boolean;
  board?: Partial<Omit<BoardModelOptions, 'random' | 'now'>>;
}

const visit = (a: string, b: string, c: string, gap = 1800): BoardAction[] => [
  { do: 'throw', segment: a },
  { do: 'wait', ms: gap },
  { do: 'throw', segment: b },
  { do: 'wait', ms: gap },
  { do: 'throw', segment: c },
  { do: 'wait', ms: 2500 },
  { do: 'takeout' },
  { do: 'wait', ms: 2500 },
];

export const SCENARIOS: Record<string, Scenario> = {
  idle: { name: 'idle', description: 'A ready board with nothing happening; drive it with the keyboard.', steps: [] },
  'random-play': {
    name: 'random-play',
    description: 'Endless random visits at a realistic pace, with the odd bounce-out.',
    steps: [{ do: 'random-visit' }, { do: 'wait', ms: 2000 }],
    loop: true,
  },
  'two-visits': {
    name: 'two-visits',
    description: 'Two visits in the shape of a 2.0.2 capture: T20 T20 T5, then S12 M12 S20 (miss as bed Outside).',
    steps: [{ do: 'wait', ms: 1000 }, ...visit('T20', 'T20', 'T5'), ...visit('SO12', 'M12', 'SI20')],
  },
  'bulls-and-misses': {
    name: 'bulls-and-misses',
    description: 'Outer bull, inner bull and a bare "M" miss, then D16, M3 and S1.',
    steps: [{ do: 'wait', ms: 1000 }, ...visit('25', 'BULL', 'MISS'), ...visit('D16', 'M3', 'SO1')],
    loop: true,
    board: { missStyle: 'bare' },
  },
  'stuck-takeout': {
    name: 'stuck-takeout',
    description: "2.0.2's stuck takeout: a visit, then a takeout that holds on the empty board for 12 s until a manual reset.",
    steps: [
      { do: 'wait', ms: 1000 },
      { do: 'throw', segment: 'T19' },
      { do: 'wait', ms: 1500 },
      { do: 'throw', segment: 'S7' },
      { do: 'wait', ms: 1500 },
      { do: 'stuck' },
      { do: 'wait', ms: 12000 },
      { do: 'reset' },
      { do: 'wait', ms: 3000 },
    ],
    loop: true,
  },
  corrections: {
    name: 'corrections',
    description: 'The board changes its mind: a phantom dart it withdraws, and a dart it re-reads as a neighbour.',
    steps: [
      { do: 'wait', ms: 1000 },
      { do: 'throw', segment: 'T20' },
      { do: 'wait', ms: 1200 },
      { do: 'phantom', segment: 'S1' },
      { do: 'wait', ms: 900 },
      { do: 'withdraw' },
      { do: 'wait', ms: 1200 },
      { do: 'throw', segment: 'SO5' },
      { do: 'wait', ms: 800 },
      { do: 'change', index: 1, segment: 'T5' },
      { do: 'wait', ms: 1500 },
      { do: 'throw', segment: 'D20' },
      { do: 'wait', ms: 2500 },
      { do: 'takeout' },
      { do: 'wait', ms: 3000 },
    ],
    loop: true,
  },
  'bounce-outs': {
    name: 'bounce-outs',
    description: 'Visits where a dart bounces out, so the board lists only two.',
    steps: [
      { do: 'wait', ms: 1000 },
      { do: 'throw', segment: 'S20' },
      { do: 'wait', ms: 1500 },
      { do: 'bounce' },
      { do: 'wait', ms: 1500 },
      { do: 'throw', segment: 'T1' },
      { do: 'wait', ms: 2500 },
      { do: 'takeout' },
      { do: 'wait', ms: 2500 },
    ],
    loop: true,
  },
};

/** Runs one action on the board now. Returns how long the scenario should wait after it. */
export function performAction(
  board: BoardModel,
  action: BoardAction,
  random: RandomSource,
  later: (fn: () => void, ms: number) => void,
): number {
  switch (action.do) {
    case 'throw':
      board.throwDart({ segment: action.segment });
      return 0;
    case 'bounce':
      board.bounceOut(action.segment);
      return 0;
    case 'startTakeout':
      board.startTakeout();
      return 0;
    case 'finishTakeout':
      board.finishTakeout();
      return 0;
    case 'takeout': {
      board.startTakeout();
      const ms = 600 + random() * 1400;
      later(() => board.finishTakeout(), ms);
      return ms;
    }
    case 'hand':
      board.handInFront();
      return 0;
    case 'stuck':
      board.stickTakeout();
      return 0;
    case 'reset':
      board.manualReset();
      return 0;
    case 'phantom':
      board.phantom(action.segment);
      return 0;
    case 'withdraw':
      board.withdraw(action.index);
      return 0;
    case 'change':
      board.changeDetection(action.index, action.segment);
      return 0;
    case 'wait':
      return action.ms;
    case 'random-visit': {
      let t = 0;
      for (let i = 0; i < 3; i++) {
        t += 1200 + random() * 1800;
        const bounce = random() < 0.06;
        later(() => (bounce ? board.bounceOut() : board.throwDart()), t);
      }
      t += 1500 + random() * 1500;
      later(() => board.startTakeout(), t);
      t += 600 + random() * 1400;
      later(() => board.finishTakeout(), t);
      return t;
    }
  }
}

/** Plays a scenario on the board with the given scheduler. */
export function runScenario(
  board: BoardModel,
  scenario: Scenario,
  scheduler: Scheduler,
  random: RandomSource,
): { stop(): void } {
  const timers = new Set<TimerHandle>();
  let stopped = false;
  let cursor = 0;
  const later = (fn: () => void, ms: number): void => {
    const h = scheduler.setTimeout(() => {
      timers.delete(h);
      if (!stopped) fn();
    }, ms);
    timers.add(h);
  };
  const next = (): void => {
    if (stopped) return;
    if (cursor >= scenario.steps.length) {
      if (!scenario.loop || scenario.steps.length === 0) return;
      cursor = 0;
    }
    const action = scenario.steps[cursor++] as BoardAction;
    const wait = performAction(board, action, random, later);
    later(next, wait);
  };
  later(next, 0);
  return {
    stop() {
      stopped = true;
      for (const h of timers) scheduler.clearTimeout(h);
      timers.clear();
    },
  };
}
