import type { AroundTheClockView } from '@arcade/games/src/around-the-clock/module';
import type { CountdownView } from '@arcade/games/src/countdown/module';
import type { CricketView } from '@arcade/games/src/cricket/module';
import type { SiegeView } from '@arcade/games/src/siege/module';
import type { ShellState } from '../demo-session';
import { loadArcadeFonts } from '../fonts';
import { ClockStage, CountdownStage, CricketStage, PreviewStage } from './ClassicStages';
import { SiegeStage } from './SiegeStage';

export { StageBackdrop } from './Backdrops';

// W3 can be the first screen (a deep link or a resumed game), so it asks for the fonts too.
loadArcadeFonts();

export interface StageTexts {
  /** The instruction plaque: "HIT THE INVADERS' NUMBERS", "CHECKOUT ON 141"… */
  instruction: string;
  /** Under it: "DART 2 OF 3". */
  kicker: string;
  /** What the "Up now" number means, if it needs saying. */
  scoreLabel?: string;
  /** Each player's number in this game's terms, by seat. */
  scores: string[];
}

const targetLabel = (n: number) => (n === 25 ? 'the bull' : String(n));

/** The words around the stage, from the game's view: never baked into art. */
export function stageTexts(state: ShellState): StageTexts {
  const kicker = `Dart ${Math.min(3, state.turn.length + 1)} of 3`;
  const scores = state.players.map((p) => String(p.score));
  const view = state.view;
  if (!view) return { instruction: 'Get ready', kicker, scores };
  switch (view.gameId) {
    case 'siege': {
      const v = view as SiegeView;
      const lane = v.lanes.find((l) => l.playerId === v.current);
      return { instruction: lane && lane.invaders.length === 0 ? 'Wave cleared' : "Hit the invaders' numbers", kicker, scoreLabel: 'Wall', scores };
    }
    case 'countdown': {
      const v = view as CountdownView;
      const me = v.players.find((p) => p.playerId === v.current);
      const instruction = !me
        ? v.headline
        : v.visit?.bust && v.visit.playerId === v.current
          ? 'Bust'
          : !me.opened
            ? 'Hit a double to start'
            : v.checkout
              ? `Checkout on ${me.remaining}`
              : `${me.remaining} to go`;
      return { instruction, kicker, scores };
    }
    case 'cricket': {
      const v = view as CricketView;
      return { instruction: `Aim for ${v.targets.slice(0, 3).map(targetLabel).join(' · ')}`, kicker, scoreLabel: 'Points', scores };
    }
    case 'around-the-clock': {
      const v = view as AroundTheClockView;
      const target = v.targets[0];
      return {
        instruction: target === undefined ? 'Finished' : `Hit ${targetLabel(target)}`,
        kicker,
        scoreLabel: 'Next',
        scores: v.players.map((p) => (p.target === 'Done' ? '✓' : p.target)),
      };
    }
    default:
      return { instruction: 'Score as much as you can', kicker, scoreLabel: 'Points', scores };
  }
}

/** The centre stage for the game being played, sized to the box it is given. */
export function GameStage({ state, width, height, accent, takeout }: { state: ShellState; width: number; height: number; accent: string; takeout: boolean }) {
  const view = state.view;
  if (!view || width <= 0 || height <= 0) return null;
  switch (view.gameId) {
    case 'siege':
      return <SiegeStage view={view as SiegeView} width={width} height={height} />;
    case 'countdown':
      return <CountdownStage view={view as CountdownView} width={width} height={height} accent={accent} showRoute={!takeout} />;
    case 'cricket':
      return <CricketStage view={view as CricketView} width={width} height={height} accent={accent} />;
    case 'around-the-clock':
      return <ClockStage view={view as AroundTheClockView} width={width} height={height} accent={accent} />;
    default: {
      const last = state.turn[state.turn.length - 1];
      return <PreviewStage width={width} height={height} accent={accent} lastLabel={last?.segment.label} color={state.players[state.current]?.colorIndex ?? 0} />;
    }
  }
}
