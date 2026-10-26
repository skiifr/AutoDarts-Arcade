import type { GameModule } from '@arcade/engine';
import { z } from 'zod';
import type { PlayerRef } from '@arcade/event-schema';
import { parseVisits } from './darts';
import { runSession, type SessionResult, type SessionSpec } from './harness';
import { runOnHost } from './host';
import { makePlayers } from './players';

/**
 * A scripted session (`<game>/fixtures/*.json`). Visits are listed in throwing order and
 * use dart labels (T20, D16, S5, 25, BULL, MISS). A short visit is padded with misses;
 * darts after a bust or a finish are shown but not scored.
 */
export const FixtureSchema = z.object({
  description: z.string().min(1),
  /** Display names in turn order. */
  players: z.array(z.string().min(1)).min(1).max(8),
  options: z.record(z.string(), z.unknown()).default({}),
  seed: z.string().min(1).optional(),
  visits: z.array(z.array(z.string()).max(3)),
  expect: z
    .object({
      finished: z.boolean(),
      /** Number of turns played, when it matters to the fixture. */
      turns: z.int().min(0).optional(),
      standings: z.array(z.object({ player: z.string(), rank: z.int().min(1), score: z.number() })),
    })
    .optional(),
});
export type Fixture = z.infer<typeof FixtureSchema>;

export interface NamedStanding {
  player: string;
  rank: number;
  score: number;
}

export interface FixtureRun<State = unknown, View = unknown> {
  result: SessionResult<State, View>;
  /** Standings with display names instead of ids, in rank order. */
  standings: NamedStanding[] | null;
}

function scriptSpec(input: unknown, extra: { seed?: string }): SessionSpec {
  const fixture = FixtureSchema.parse(input);
  return {
    players: makePlayers(fixture.players),
    options: fixture.options,
    seed: fixture.seed ?? extra.seed,
    darts: parseVisits(fixture.visits),
  };
}

function named<State, View>(players: readonly PlayerRef[], result: SessionResult<State, View>): FixtureRun<State, View> {
  const nameOf = (id: string) => players.find((p) => p.playerId === id)!.displayName;
  const standings = result.standings?.map((s) => ({ player: nameOf(s.playerId), rank: s.rank, score: s.score })) ?? null;
  return { result, standings };
}

/** Plays a scripted session (a fixture or a headless-runner script) through the harness. */
export function playScript<State, View>(
  game: GameModule<unknown, State, View>,
  input: unknown,
  extra: { seed?: string } = {},
): FixtureRun<State, View> {
  const spec = scriptSpec(input, extra);
  return named(spec.players, runSession(game, spec));
}

/** Plays a scripted session through the engine's `SessionHost` (`runOnHost`). */
export async function playScriptOnHost<State, View>(
  game: GameModule<unknown, State, View>,
  input: unknown,
  extra: { seed?: string } = {},
): Promise<FixtureRun<State, View>> {
  const spec = scriptSpec(input, extra);
  return named(spec.players, await runOnHost(game, spec));
}
