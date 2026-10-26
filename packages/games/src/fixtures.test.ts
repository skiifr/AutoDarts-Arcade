import { describe, expect, it } from 'vitest';
import { GAMES } from '.';
import { FixtureSchema, playScript } from './testing';

const FIXTURES = import.meta.glob('./*/fixtures/*.json', { eager: true, import: 'default' });

/** Plays every `<game>/fixtures/*.json` through the harness and checks its expected standings. */
describe.each(GAMES.map((game) => [game.manifest.id, game] as const))('%s fixtures', (id, game) => {
  const files = Object.entries(FIXTURES)
    .filter(([path]) => path.startsWith(`./${id}/fixtures/`))
    .map(([path, json]) => [path.slice(path.lastIndexOf('/') + 1), json] as const);

  it('has at least one fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (_file, json) => {
    const fixture = FixtureSchema.parse(json);
    expect(fixture.expect, 'a fixture states its expected result').toBeDefined();
    const run = playScript(game, fixture);
    expect(run.result.finished).toBe(fixture.expect!.finished);
    expect(run.standings).toEqual(fixture.expect!.standings);
    if (fixture.expect!.turns !== undefined) expect(run.result.turns).toHaveLength(fixture.expect!.turns);
  });
});
