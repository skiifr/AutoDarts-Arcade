import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gameRegistry } from '@arcade/engine';
import { GAMES, gameById, type BaseView } from '@arcade/games';
import {
  FixtureSchema,
  aimingThrower,
  defaultNames,
  makePlayers,
  parseVisits,
  runOnHost,
  type Fixture,
  type NamedStanding,
  type SessionResult,
} from '@arcade/games/src/testing';

const USAGE = `Usage: yarn play-headless --game <id> [options]

Plays a game through the engine's SessionHost, with an in-memory event log, as a
manual-mode session: each dart is an AddDart command and each visit ends with
SkipTurn. Prints the turn log and standings. Without --script, a seeded pub-level
thrower aims at whatever the game's view suggests.

  -g, --game <id>        ${GAMES.map((g) => g.manifest.id).join(' | ')}
  -p, --players <n>      number of players (default: the game's minimum)
      --names <a,b,...>  player names in turn order (sets the player count)
  -s, --seed <seed>      seed for the game's Rng and the random thrower (default: random)
      --script <file>    play the visits of a fixture-style JSON script instead
  -o, --option <k=v>     set a game option, e.g. -o start=301 -o doubleOut=false (repeatable)
      --max-turns <n>    stop after n turns (default 1000)
      --record <file>    save the game as a fixture-style script, with its result as "expect"
      --json             print the result as JSON instead of the turn log
      --log              print the session's event log as JSON lines instead of the turn log
  -h, --help             show this help`;

class UsageError extends Error {}

/** Paths are relative to where `yarn play-headless` was run, not to the repo root. */
const fromCwd = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

/** Runs the CLI and resolves to the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await play(argv);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (error instanceof UsageError || code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`${(error as Error).message}\nRun \`yarn play-headless --help\` for usage.`);
      return 2;
    }
    throw error;
  }
}

function parseOption(text: string): [string, unknown] {
  const at = text.indexOf('=');
  if (at <= 0) throw new UsageError(`--option expects key=value, got "${text}"`);
  const raw = text.slice(at + 1);
  try {
    return [text.slice(0, at), JSON.parse(raw)];
  } catch {
    return [text.slice(0, at), raw];
  }
}

function readScript(path: string): { script: Fixture; game?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fromCwd(path), 'utf8'));
  } catch (error) {
    throw new UsageError(`Cannot read script ${path}: ${(error as Error).message}`);
  }
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new UsageError(`Script ${path} is not valid:\n${issues}`);
  }
  const game = (raw as { game?: unknown }).game;
  return { script: parsed.data, game: typeof game === 'string' ? game : undefined };
}

async function play(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      game: { type: 'string', short: 'g' },
      players: { type: 'string', short: 'p' },
      names: { type: 'string' },
      seed: { type: 'string', short: 's' },
      script: { type: 'string' },
      option: { type: 'string', short: 'o', multiple: true },
      'max-turns': { type: 'string' },
      record: { type: 'string' },
      json: { type: 'boolean' },
      log: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.json && values.log) throw new UsageError('--json and --log both print to stdout; pick one.');

  const loaded = values.script ? readScript(values.script) : undefined;
  const id = values.game ?? loaded?.game;
  if (!id) throw new UsageError('Missing --game.');
  const game = gameById(id);
  if (!game) throw new UsageError(`Unknown game "${id}".`);
  const { manifest } = game;

  let names: string[];
  if (loaded) {
    if (values.players || values.names) throw new UsageError('A script names its own players; drop --players/--names.');
    names = loaded.script.players;
  } else if (values.names) {
    names = values.names.split(',').map((n) => n.trim()).filter(Boolean);
  } else {
    if (values.players && !/^\d+$/.test(values.players)) throw new UsageError('--players expects a whole number.');
    names = defaultNames(values.players ? Number(values.players) : manifest.players.min);
  }
  if (names.length < manifest.players.min || names.length > manifest.players.max) {
    throw new UsageError(`${manifest.name} takes ${manifest.players.min}–${manifest.players.max} players.`);
  }

  const raw = { ...loaded?.script.options, ...Object.fromEntries((values.option ?? []).map(parseOption)) };
  const options = game.options.safeParse(raw);
  if (!options.success) {
    const issues = options.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new UsageError(`Invalid options for ${manifest.id}:\n${issues}`);
  }

  const seed = values.seed ?? loaded?.script.seed ?? (loaded ? 'arcade' : randomBytes(3).toString('hex'));
  if (seed === '') throw new UsageError('--seed must not be empty.');
  const maxTurns = values['max-turns'] ? Number(values['max-turns']) : undefined;
  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) {
    throw new UsageError('--max-turns expects a positive whole number.');
  }

  const players = makePlayers(names);
  const result = await runOnHost(game, {
    players,
    options: options.data,
    seed,
    darts: loaded ? parseVisits(loaded.script.visits) : aimingThrower(seed),
    maxTurns,
    games: gameRegistry(GAMES),
  });
  const nameOf = (playerId: string) => players.find((p) => p.playerId === playerId)!.displayName;
  const standings: NamedStanding[] | null =
    result.standings?.map((s) => ({ player: nameOf(s.playerId), rank: s.rank, score: s.score })) ?? null;

  if (values.record) {
    const recorded: Fixture = {
      description: `Recorded ${manifest.name} game (seed ${seed}).`,
      players: names,
      options: options.data as Record<string, unknown>,
      seed,
      visits: result.turns.map((t) => t.darts.filter((d) => !d.padded).map((d) => d.label)),
      expect: { finished: result.finished, turns: result.turns.length, standings: standings ?? [] },
    };
    writeFileSync(fromCwd(values.record), `${compactJson(recorded)}\n`);
  }

  if (values.log) {
    for (const event of result.log) console.log(JSON.stringify(event));
  } else if (values.json) {
    console.log(
      JSON.stringify(
        {
          game: manifest.id,
          version: manifest.version,
          seed,
          options: options.data,
          finished: result.finished,
          turns: result.turns.map((t) => ({
            round: t.roundIndex + 1,
            player: t.name,
            darts: t.darts,
            endTurn: t.endTurn,
            effects: t.effects,
          })),
          standings,
        },
        null,
        2,
      ),
    );
  } else {
    printLog(manifest.name, seed, options.data, result, names, standings);
  }
  if (values.record) console.error(`Recorded to ${values.record}`);

  const expected = loaded?.script.expect;
  if (!expected) return 0;
  const matches =
    expected.finished === result.finished &&
    JSON.stringify(expected.standings) === JSON.stringify(standings ?? []) &&
    (expected.turns === undefined || expected.turns === result.turns.length);
  const human = !values.json && !values.log;
  if (human) console.log(`\nExpected result: ${matches ? 'matches' : 'DIFFERS'}`);
  if (!matches && human) {
    for (const s of expected.standings) console.log(`  ${s.rank}. ${s.player.padEnd(12)} ${s.score}`);
  }
  return matches ? 0 : 1;
}

/** Pretty JSON that keeps anything short (a visit, a standing) on one line. */
function compactJson(value: unknown, indent = ''): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  };
  const flat = inline(value);
  if (indent.length + flat.length <= 100 || value === null || typeof value !== 'object') return flat;
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => inner + compactJson(v, inner))
    : Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${items.join(',\n')}\n${indent}${close}`;
}

function printLog(
  name: string,
  seed: string,
  options: unknown,
  result: SessionResult,
  names: readonly string[],
  standings: NamedStanding[] | null,
): void {
  const width = Math.max(...names.map((n) => n.length));
  console.log(`${name} · ${names.length} player${names.length === 1 ? '' : 's'} · seed ${seed}`);
  console.log(`Options: ${JSON.stringify(options)}\n`);
  for (const turn of result.turns) {
    const darts = turn.darts
      .map((d) => (d.padded ? '-' : d.scored ? d.label : `(${d.label})`).padEnd(7))
      .join('');
    const effects = [...new Set(turn.effects.map((e) => e.kind))].join(' ');
    const board = (turn.view as Partial<BaseView>).scoreboard?.map((r) => `${r.name} ${r.score}`).join(' · ') ?? '';
    console.log(`R${String(turn.roundIndex + 1).padEnd(3)} ${turn.name.padEnd(width)}  ${darts.padEnd(21)} ${effects.padEnd(16)} ${board}`);
  }
  const view = result.view as Partial<BaseView>;
  console.log('');
  if (!standings) {
    console.log(`Stopped after ${result.turns.length} turns, before the game finished. ${view.headline ?? ''}`);
    return;
  }
  console.log(view.headline ?? 'Finished');
  console.log('Standings');
  for (const s of standings) console.log(`  ${s.rank}. ${s.player.padEnd(width)}  ${s.score}`);
}
