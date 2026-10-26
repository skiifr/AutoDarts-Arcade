import { describe, expect, it } from 'vitest';
import { GAMES, gameById, type BaseView } from '.';
import { aimingThrower, defaultNames, makePlayers, runSession } from './testing';

const games = GAMES.map((game) => [game.manifest.id, game] as const);
const MODULES = import.meta.glob<() => Promise<Record<string, unknown>>>('./*/module.ts');
const RULES = import.meta.glob('./*/rules.md');
const FIXTURES = import.meta.glob('./*/fixtures/*.json');

describe('GAMES registry', () => {
  it('has unique ids', () => {
    const ids = GAMES.map((g) => g.manifest.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds a game by id', () => {
    expect(gameById('countdown')?.manifest.name).toBe('Countdown');
    expect(gameById('nope')).toBeUndefined();
  });
});

describe.each(games)('%s', (id, game) => {
  it('parses its default options', () => {
    expect(() => game.options.parse({})).not.toThrow();
    expect(game.options.parse({})).toEqual(game.options.parse(game.options.parse({})));
  });

  it('has a valid manifest', () => {
    const { manifest } = game;
    expect(manifest.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.players.min).toBeGreaterThanOrEqual(1);
    expect(manifest.players.max).toBeLessThanOrEqual(8);
    expect(manifest.players.min).toBeLessThanOrEqual(manifest.players.max);
    expect(manifest.dartsPerTurn).toBe(3);
  });

  it('lives in its own folder with module.ts, rules.md and fixtures', async () => {
    const load = MODULES[`./${id}/module.ts`];
    expect(load, `${id}/module.ts`).toBeDefined();
    expect(Object.values(await load!())).toContain(game);
    expect(RULES[`./${id}/rules.md`], `${id}/rules.md`).toBeDefined();
    expect(Object.keys(FIXTURES).some((path) => path.startsWith(`./${id}/fixtures/`))).toBe(true);
  });

  it.each([1, 2, 3])('plays seeded game %i to a full ranking, with plain state it never mutates', (n) => {
    for (const count of new Set([game.manifest.players.min, game.manifest.players.max])) {
      const seed = `${id}-${n}-${count}`;
      const spec = { players: makePlayers(defaultNames(count)), seed };
      const strict = runSession(game, { ...spec, darts: aimingThrower(seed), freeze: true, roundTrip: true });
      const plain = runSession(game, { ...spec, darts: aimingThrower(seed) });
      expect(strict.turns).toEqual(plain.turns);
      expect(strict.finished).toBe(true);

      const standings = strict.standings!;
      expect(standings.map((s) => s.playerId).sort()).toEqual(spec.players.map((p) => p.playerId).sort());
      standings.forEach((s, i) => expect(s.rank === i + 1 || s.rank === standings[i - 1]?.rank).toBe(true));

      const view = strict.view as BaseView;
      expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      expect(view).toMatchObject({ gameId: id, finished: true, current: null });
      expect(view.scoreboard).toHaveLength(count);
      expect(typeof view.headline).toBe('string');
    }
  });
});
