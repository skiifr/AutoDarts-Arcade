import { describe, expect, it } from 'vitest';
import { GAMES } from '.';
import { FixtureSchema, playScript, playScriptOnHost, type FixtureRun } from './testing';

const FIXTURES = import.meta.glob('./*/fixtures/*.json', { eager: true, import: 'default' });

/**
 * Plays every `<game>/fixtures/*.json` and checks its expected standings: through the harness,
 * and through the engine's SessionHost as a manual-mode session, which must agree turn for turn.
 */
describe.each(GAMES.map((game) => [game.manifest.id, game] as const))('%s fixtures', (id, game) => {
  const files = Object.entries(FIXTURES)
    .filter(([path]) => path.startsWith(`./${id}/fixtures/`))
    .map(([path, json]) => [path.slice(path.lastIndexOf('/') + 1), json] as const);

  const check = (run: FixtureRun, json: unknown) => {
    const fixture = FixtureSchema.parse(json);
    expect(fixture.expect, 'a fixture states its expected result').toBeDefined();
    expect(run.result.finished).toBe(fixture.expect!.finished);
    expect(run.standings).toEqual(fixture.expect!.standings);
    if (fixture.expect!.turns !== undefined) expect(run.result.turns).toHaveLength(fixture.expect!.turns);
  };

  it('has at least one fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (_file, json) => {
    check(playScript(game, json), json);
  });

  it.each(files)('%s through the SessionHost', async (_file, json) => {
    const run = await playScriptOnHost(game, json);
    check(run, json);
    expect(run.result.turns).toEqual(playScript(game, json).result.turns);
  });
});
