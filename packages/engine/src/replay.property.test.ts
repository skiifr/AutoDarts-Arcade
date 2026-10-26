/**
 * Property tests (ROADMAP Phase 3 acceptance): replay equivalence for corrections, voids and
 * additions; determinism; crash-resume at any cut point; the snapshot cache changing nothing;
 * and a gap-free, valid log for any session.
 */
import {
  INNER_BULL,
  MISS,
  OUTER_BULL,
  makeSegment,
  parseArcadeEvent,
  type ArcadeCommand,
  type BoardFactDraft,
  type HouseRules,
  type Segment,
} from '@arcade/event-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldSession } from './fold';
import type { FoldOptions } from './folder';
import { SessionHost } from './host';
import { ulidFromNumber } from './ids';
import type { SessionState } from './state';
import { Board, Commands, makePlayers, makeRig, registry, type TestRig } from './testing/harness';

// ── Generated sessions ──────────────────────────────────────────────────────

interface VisitSpec {
  darts: Segment[];
  /** observed takeout; inferred takeout (then a person confirms); or "Next player" then takeout. */
  end: 'observed' | 'inferred' | 'skip';
  /** The board drops out mid-visit; the visit's darts arrive as recovered. */
  offline: boolean;
  /** The board changes its mind about one dart. */
  update: { index: number; segment: Segment } | null;
}

interface SessionSpec {
  game: 'test-sum' | 'test-ceiling' | 'test-lucky';
  players: number;
  rounds: number;
  houseRules: HouseRules;
  visits: VisitSpec[];
}

const segmentArb: fc.Arbitrary<Segment> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(MISS) },
  {
    weight: 6,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 20 }), fc.constantFrom<1 | 2 | 3>(1, 2, 3))
      .map(([n, m]) => makeSegment(n, m)),
  },
  { weight: 1, arbitrary: fc.constantFrom(OUTER_BULL, INNER_BULL) },
);

const visitArb: fc.Arbitrary<VisitSpec> = fc.record({
  darts: fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
  end: fc.constantFrom<VisitSpec['end']>('observed', 'observed', 'observed', 'observed', 'inferred', 'skip'),
  offline: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
  update: fc.option(fc.record({ index: fc.nat(2), segment: segmentArb }), { freq: 4 }),
});

const specArb: fc.Arbitrary<SessionSpec> = fc.record({
  game: fc.constantFrom<SessionSpec['game']>('test-sum', 'test-ceiling', 'test-lucky'),
  players: fc.integer({ min: 1, max: 3 }),
  rounds: fc.integer({ min: 1, max: 4 }),
  houseRules: fc.record({ missingDartsAreMisses: fc.boolean(), emptyTakeoutSkipsTurn: fc.boolean() }),
  visits: fc.array(visitArb, { minLength: 1, maxLength: 12 }),
});

const fracArb = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

type Step =
  | { kind: 'fact'; fact: BoardFactDraft; throwId?: string }
  | { kind: 'command'; command: ArcadeCommand }
  /** Confirm whatever turn is awaiting review (a person pressing OK on the W3 banner). */
  | { kind: 'confirm' }
  /** Where an omitted dart would have been. */
  | { kind: 'marker'; throwId: string }
  /** A command built from the state at that moment (a person picking a dart on W4). */
  | { kind: 'dynamic'; make: (s: SessionState | null, cmd: Commands) => ArcadeCommand | null };

function throwIdOf(visit: number, dart: number): string {
  return ulidFromNumber(visit * 8 + dart + 1, '5T');
}

function updatedThrowIds(spec: SessionSpec): Set<string> {
  const out = new Set<string>();
  spec.visits.forEach((v, vi) => {
    if (v.update && v.update.index < v.darts.length) out.add(throwIdOf(vi, v.update.index));
  });
  return out;
}

interface Mods {
  segment?: ReadonlyMap<string, Segment>;
  omit?: string;
  extra?: { visit: number; at: number; throwId: string; segment: Segment };
  /** A command inserted at a random point after the step of `after` (a dart or a marker). */
  insert?: { after: string; frac: number; make: (cmd: Commands) => ArcadeCommand };
}

function materialize(spec: SessionSpec, mods: Mods = {}): Step[] {
  const board = new Board();
  const cmd = new Commands();
  const fact = (f: BoardFactDraft): Step => ({ kind: 'fact', fact: f });
  const steps: Step[] = [
    { kind: 'command', command: cmd.start(spec.game, makePlayers(spec.players), { rounds: spec.rounds }, spec.houseRules) },
  ];
  spec.visits.forEach((v, vi) => {
    const darts = v.darts.map((segment, di) => {
      const throwId = throwIdOf(vi, di);
      return { throwId, segment: mods.segment?.get(throwId) ?? segment };
    });
    if (mods.extra?.visit === vi) darts.splice(mods.extra.at, 0, { throwId: mods.extra.throwId, segment: mods.extra.segment });
    if (v.offline) steps.push(fact(board.connection('offline')), fact(board.connection('resyncing')));
    for (const d of darts) {
      if (d.throwId === mods.omit) steps.push({ kind: 'marker', throwId: d.throwId });
      else steps.push({ kind: 'fact', fact: board.dart(d.segment, { throwId: d.throwId, recovered: v.offline }), throwId: d.throwId });
    }
    if (v.offline) steps.push(fact(board.connection('online')));
    if (v.update && v.update.index < v.darts.length) {
      const target = darts.find((d) => d.throwId === throwIdOf(vi, v.update!.index))!;
      if (target.throwId !== mods.omit) steps.push(fact(board.update(target.throwId, target.segment, v.update.segment)));
    }
    if (v.end === 'observed') steps.push(fact(board.takeoutStarted()), fact(board.takeout()));
    else if (v.end === 'inferred') steps.push(fact(board.takeout({ inferred: true })), { kind: 'confirm' });
    else steps.push({ kind: 'command', command: cmd.skip() }, fact(board.takeout()));
  });
  if (mods.insert) {
    const anchor = steps.findIndex((s) => (s.kind === 'fact' || s.kind === 'marker') && s.throwId === mods.insert!.after);
    const at = anchor + 1 + Math.floor(mods.insert.frac * (steps.length - anchor));
    steps.splice(at, 0, { kind: 'command', command: mods.insert.make(cmd) });
  }
  return steps;
}

async function runSteps(host: SessionHost, steps: readonly Step[], confirms: Commands): Promise<void> {
  for (const step of steps) {
    if (step.kind === 'fact') await host.ingest(step.fact);
    else if (step.kind === 'command') await host.dispatch(step.command);
    else if (step.kind === 'confirm') {
      const turn = host.getSnapshot()?.awaitingReviewTurn;
      if (turn !== null && turn !== undefined) await host.dispatch(confirms.confirm(turn));
    } else if (step.kind === 'dynamic') {
      const command = step.make(host.getSnapshot(), confirms);
      if (command) await host.dispatch(command);
    }
  }
}

// ── Chaos sessions: everything the host handles, in any order ──────────────

type ChaosAction =
  | { a: 'dart'; segment: Segment; recovered: boolean }
  | { a: 'update'; segment: Segment }
  | { a: 'withdraw' | 'takeout' | 'inferred' | 'reset' | 'offline' | 'resyncing' | 'online' | 'stuck' }
  | { a: 'confirm' | 'skip' | 'pause' | 'resume' | 'complete' }
  | { a: 'manual'; segment: Segment }
  | { a: 'correct'; pick: number; segment: Segment }
  | { a: 'void'; pick: number }
  | { a: 'add'; pick: number; slot: number; segment: Segment; reason: 'undetected' | 'bounce-out' };

interface ChaosSpec {
  game: 'test-sum' | 'test-ceiling' | 'test-lucky' | 'test-race';
  players: number;
  amount: number;
  houseRules: HouseRules;
  baseline: Segment[];
  actions: ChaosAction[];
}

const chaosActionArb: fc.Arbitrary<ChaosAction> = fc.oneof(
  { weight: 12, arbitrary: fc.record({ a: fc.constant('dart' as const), segment: segmentArb, recovered: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('update' as const), segment: segmentArb }) },
  { weight: 5, arbitrary: fc.record({ a: fc.constant('takeout' as const) }) },
  { weight: 2, arbitrary: fc.record({ a: fc.constant('inferred' as const) }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant('confirm' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      a: fc.constantFrom('withdraw', 'reset', 'offline', 'resyncing', 'online', 'stuck') as fc.Arbitrary<
        'withdraw' | 'reset' | 'offline' | 'resyncing' | 'online' | 'stuck'
      >,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      a: fc.constantFrom('skip', 'pause', 'resume', 'complete') as fc.Arbitrary<'skip' | 'pause' | 'resume' | 'complete'>,
    }),
  },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('manual' as const), segment: segmentArb }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('correct' as const), pick: fc.nat(), segment: segmentArb }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('void' as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      a: fc.constant('add' as const),
      pick: fc.nat(),
      slot: fc.nat(2),
      segment: segmentArb,
      reason: fc.constantFrom<'undetected' | 'bounce-out'>('undetected', 'bounce-out'),
    }),
  },
);

const chaosArb: fc.Arbitrary<ChaosSpec> = fc.record({
  game: fc.constantFrom<ChaosSpec['game']>('test-sum', 'test-ceiling', 'test-lucky', 'test-race'),
  players: fc.integer({ min: 2, max: 3 }),
  amount: fc.integer({ min: 1, max: 4 }),
  houseRules: fc.record({ missingDartsAreMisses: fc.boolean(), emptyTakeoutSkipsTurn: fc.boolean() }),
  baseline: fc.array(segmentArb, { maxLength: 2 }),
  actions: fc.array(chaosActionArb, { minLength: 5, maxLength: 80, size: 'medium' }),
});

function materializeChaos(spec: ChaosSpec): Step[] {
  const board = new Board();
  const cmd = new Commands();
  const fact = (f: BoardFactDraft): Step => ({ kind: 'fact', fact: f });
  const onBoard: { throwId: string; segment: Segment }[] = [];
  const steps: Step[] = [];
  const dart = (segment: Segment, recovered: boolean) => {
    const f = board.dart(segment, { recovered });
    onBoard.push({ throwId: f.throwId, segment });
    steps.push({ kind: 'fact', fact: f, throwId: f.throwId });
  };
  for (const segment of spec.baseline) dart(segment, false);
  const options = spec.game === 'test-race' ? { target: spec.amount * 40 } : { rounds: spec.amount };
  steps.push({ kind: 'command', command: cmd.start(spec.game, makePlayers(spec.players), options, spec.houseRules) });
  const liveDarts = (s: SessionState | null) => s?.turns.flatMap((t) => t.darts) ?? [];
  for (const act of spec.actions) {
    switch (act.a) {
      case 'dart':
        dart(act.segment, act.recovered);
        break;
      case 'update': {
        const last = onBoard.at(-1);
        if (last) {
          steps.push(fact(board.update(last.throwId, last.segment, act.segment)));
          last.segment = act.segment;
        }
        break;
      }
      case 'withdraw': {
        const last = onBoard.pop();
        if (last) steps.push(fact(board.withdraw(last.throwId)));
        break;
      }
      case 'takeout':
        steps.push(fact(board.takeout()));
        onBoard.length = 0;
        break;
      case 'inferred':
        steps.push(fact(board.takeout({ inferred: true })));
        onBoard.length = 0;
        break;
      case 'reset':
        steps.push(fact(board.reset()), ...onBoard.map((d) => fact(board.withdraw(d.throwId))));
        onBoard.length = 0;
        break;
      case 'offline':
      case 'resyncing':
      case 'online':
        steps.push(fact(board.connection(act.a)));
        break;
      case 'stuck':
        steps.push(fact(board.status('stuck-takeout')));
        break;
      case 'confirm':
        steps.push({ kind: 'confirm' });
        break;
      case 'skip':
        steps.push({ kind: 'command', command: cmd.skip() });
        break;
      case 'pause':
        steps.push({ kind: 'command', command: cmd.pause('menu') });
        break;
      case 'resume':
        steps.push({ kind: 'command', command: cmd.resume() });
        break;
      case 'complete':
        steps.push({ kind: 'command', command: cmd.close('completed') });
        break;
      case 'manual':
        steps.push({
          kind: 'dynamic',
          make: (s, c) =>
            s?.currentTurn ? c.add(s.currentTurn.playerId, s.currentTurn.turnIndex, s.currentTurn.darts.length, act.segment, 'manual-mode') : null,
        });
        break;
      case 'correct':
        steps.push({
          kind: 'dynamic',
          make: (s, c) => {
            const darts = liveDarts(s);
            return darts.length ? c.correct(darts[act.pick % darts.length]!.throwId, act.segment) : null;
          },
        });
        break;
      case 'void':
        steps.push({
          kind: 'dynamic',
          make: (s, c) => {
            const darts = liveDarts(s);
            return darts.length ? c.void(darts[act.pick % darts.length]!.throwId, 'false-detection') : null;
          },
        });
        break;
      case 'add':
        steps.push({
          kind: 'dynamic',
          make: (s, c) => {
            const turn = s?.turns.length ? s.turns[act.pick % s.turns.length]! : null;
            return turn ? c.add(turn.playerId, turn.turnIndex, act.slot, act.segment, act.reason) : null;
          },
        });
        break;
    }
  }
  return steps;
}

/** Either kind of generated session, as steps. */
const stepsArb: fc.Arbitrary<Step[]> = fc.oneof(specArb.map((spec) => materialize(spec)), chaosArb.map(materializeChaos));

async function play(steps: readonly Step[], fold?: FoldOptions): Promise<TestRig> {
  const rig = makeRig(fold ? { fold } : {});
  await runSteps(rig.host, steps, new Commands('3K'));
  return rig;
}

/** The game-relevant state: what is scored, in what order, and what the game made of it. */
function project(s: SessionState) {
  return {
    phase: s.phase,
    gameState: s.gameState,
    view: s.view,
    standings: s.standings,
    finished: s.finished?.standings ?? null,
    turns: s.turns.map((t) => ({
      playerId: t.playerId,
      turnIndex: t.turnIndex,
      roundIndex: t.roundIndex,
      ended: t.ended,
      closedBy: t.closedBy,
      afterFinish: t.afterFinish,
      points: t.points,
      darts: t.darts.map((d) => ({ label: d.segment.label, bed: d.segment.bed, scored: d.scored, greyedBy: d.greyedBy })),
    })),
  };
}

function attributedIn(s: SessionState): Set<string> {
  return new Set(s.turns.flatMap((t) => t.darts.map((d) => d.throwId)));
}

function allDarts(spec: SessionSpec): { visit: number; dart: number; throwId: string; segment: Segment }[] {
  return spec.visits.flatMap((v, vi) => v.darts.map((segment, di) => ({ visit: vi, dart: di, throwId: throwIdOf(vi, di), segment })));
}

const RUNS = { numRuns: 120 };

// ── Properties ──────────────────────────────────────────────────────────────

describe('replay equivalence (ROADMAP Phase 3)', () => {
  it('throwing a wrong value and correcting it to v ends where throwing v would have', async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.nat(), segmentArb, fracArb, async (spec, pick, wrong, frac) => {
        const a = await play(materialize(spec));
        const sa = a.host.getSnapshot()!;
        const scored = attributedIn(sa);
        const updated = updatedThrowIds(spec);
        const candidates = allDarts(spec).filter((d) => scored.has(d.throwId) && !updated.has(d.throwId));
        fc.pre(candidates.length > 0);
        const k = candidates[pick % candidates.length]!;
        const b = await play(
          materialize(spec, {
            segment: new Map([[k.throwId, wrong]]),
            insert: { after: k.throwId, frac, make: (cmd) => cmd.correct(k.throwId, k.segment) },
          }),
        );
        expect(project(b.host.getSnapshot()!)).toEqual(project(sa));
      }),
      RUNS,
    );
  });

  it('a false detection voided later ends where no false detection would have', async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.nat(), fc.nat(), segmentArb, fracArb, async (spec, pick, at, phantom, frac) => {
        const a = await play(materialize(spec));
        const sa = a.host.getSnapshot()!;
        const scored = attributedIn(sa);
        // The phantom must land in a visit that is played (not after the end) and stay within 3 darts.
        const visits = spec.visits.map((v, vi) => ({ v, vi })).filter(({ v, vi }) => v.darts.length <= 2 && scored.has(throwIdOf(vi, 0)));
        fc.pre(visits.length > 0);
        const { v, vi } = visits[pick % visits.length]!;
        const x = ulidFromNumber(vi + 1, '6X');
        const b = await play(
          materialize(spec, {
            extra: { visit: vi, at: at % (v.darts.length + 1), throwId: x, segment: phantom },
            insert: { after: x, frac, make: (cmd) => cmd.void(x, 'false-detection') },
          }),
        );
        expect(project(b.host.getSnapshot()!)).toEqual(project(sa));
      }),
      RUNS,
    );
  });

  it('a missed dart added later ends where detecting it would have', async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.nat(), fracArb, async (spec, pick, frac) => {
        const a = await play(materialize(spec));
        const sa = a.host.getSnapshot()!;
        const scored = attributedIn(sa);
        const updated = updatedThrowIds(spec);
        // An empty visit is a different thing (an ignored takeout), so its visit keeps another dart.
        const candidates = allDarts(spec).filter(
          (d) => scored.has(d.throwId) && !updated.has(d.throwId) && spec.visits[d.visit]!.darts.length >= 2,
        );
        fc.pre(candidates.length > 0);
        const k = candidates[pick % candidates.length]!;
        const turn = sa.turns.find((t) => t.darts.some((d) => d.throwId === k.throwId))!;
        const position = turn.darts.findIndex((d) => d.throwId === k.throwId);
        const b = await play(
          materialize(spec, {
            omit: k.throwId,
            insert: {
              after: k.throwId,
              frac,
              make: (cmd) => cmd.add(turn.playerId, turn.turnIndex, position, k.segment, 'undetected'),
            },
          }),
        );
        expect(project(b.host.getSnapshot()!)).toEqual(project(sa));
      }),
      RUNS,
    );
  });
});

describe('determinism', () => {
  it('the same log and seed always fold to the identical state, with or without the snapshot cache', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArb, async (steps) => {
        const rig = await play(steps);
        const log = rig.host.getLog();
        const live = rig.host.getSnapshot();
        const roundTripped = JSON.parse(JSON.stringify(log)).map((e: unknown) => parseArcadeEvent(e));
        expect(foldSession(log, registry)).toStrictEqual(live);
        expect(foldSession(roundTripped, registry)).toStrictEqual(live);
        for (const snapshotEvery of [0, 1, 3]) {
          expect(foldSession(log, registry, { snapshotEvery })).toStrictEqual(live);
        }
      }),
      { numRuns: 80 },
    );
  });

  it('a live host gives the same state whatever its snapshot cache', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArb, async (steps) => {
        const base = (await play(steps, { snapshotEvery: 8 })).host.getSnapshot();
        for (const snapshotEvery of [0, 1, 2]) {
          expect((await play(steps, { snapshotEvery })).host.getSnapshot()).toStrictEqual(base);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('a different seed can change a randomised game; the same seed never does', async () => {
    const steps = materialize({
      game: 'test-lucky',
      players: 2,
      rounds: 4,
      houseRules: { missingDartsAreMisses: true, emptyTakeoutSkipsTurn: false },
      visits: Array.from({ length: 8 }, (_, i) => ({ darts: [makeSegment((i % 20) + 1, 1)], end: 'observed', offline: false, update: null })),
    });
    const log = (await play(steps)).host.getLog();
    const seeds = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const reseeded = log.map((e) => (e.type === 'SessionStarted' ? { ...e, payload: { ...e.payload, rngSeed: seed } } : e));
      const lucky = (foldSession(reseeded, registry).gameState as { luckyHistory: number[] }).luckyHistory;
      expect((foldSession(reseeded, registry).gameState as { luckyHistory: number[] }).luckyHistory).toEqual(lucky);
      seeds.add(lucky.join());
    }
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('dry-run preview', () => {
  it('previews exactly what the command then does, and leaves the live state untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        stepsArb,
        fc.constantFrom('correct', 'void', 'add', 'skip', 'confirm'),
        fc.nat(),
        segmentArb,
        async (steps, kind, pick, segment) => {
          const rig = await play(steps);
          const s = rig.host.getSnapshot();
          fc.pre(s !== null && s.phase !== 'closed');
          const cmd = new Commands('3P');
          const darts = s!.turns.flatMap((t) => t.darts);
          const turn = s!.turns.length ? s!.turns[pick % s!.turns.length]! : null;
          let command: ArcadeCommand | null = null;
          if (kind === 'correct' && darts.length) command = cmd.correct(darts[pick % darts.length]!.throwId, segment);
          if (kind === 'void' && darts.length) command = cmd.void(darts[pick % darts.length]!.throwId);
          if (kind === 'add' && turn) command = cmd.add(turn.playerId, turn.turnIndex, pick % 3, segment);
          if (kind === 'skip') command = cmd.skip();
          if (kind === 'confirm') command = cmd.confirm(turn?.turnIndex ?? 0);
          fc.pre(command !== null);

          const preview = rig.host.preview(command);
          expect(rig.host.getSnapshot()).toBe(s);
          const result = await rig.host.dispatch(command);
          if (preview.status === 'rejected') {
            expect(result).toMatchObject({ status: 'rejected', reason: preview.reason });
          } else {
            const applied = result.status === 'applied' ? result.events.map((e) => e.type) : [];
            expect(applied).toEqual(preview.events.map((e) => e.type));
            expect(project(rig.host.getSnapshot()!)).toEqual(project(preview.state));
          }
          expect(foldSession(rig.host.getLog(), registry)).toStrictEqual(rig.host.getSnapshot());
        },
      ),
      RUNS,
    );
  });
});

describe('crash-resume', () => {
  it('rebuilding a host from the log at any cut point gives the same state, and play continues identically', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArb, fracArb, async (steps, frac) => {
        const reference = await play(steps);

        const rig = makeRig();
        const confirms = new Commands('3K');
        const cut = Math.floor(frac * (steps.length + 1));
        await runSteps(rig.host, steps.slice(0, cut), confirms);
        let host = rig.host;
        const before = host.getSnapshot();
        if (before) {
          host = await SessionHost.resume(rig.deps, before.sessionId);
          expect(host.getSnapshot()).toStrictEqual(before);
        }
        await runSteps(host, steps.slice(cut), confirms);
        expect(host.getSnapshot()).toStrictEqual(reference.host.getSnapshot());
        expect(host.getLog()).toEqual(reference.host.getLog());
      }),
      RUNS,
    );
  });
});

describe('log invariants', () => {
  it('any session produces a gap-free, schema-valid log with unique ids and each dart attributed once', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArb, async (steps) => {
        const rig = await play(steps);
        const log = rig.host.getLog();
        expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
        for (const e of log) parseArcadeEvent(e);
        expect(new Set(log.map((e) => e.eventId)).size).toBe(log.length);
        const attributed = log.flatMap((e) => (e.type === 'DartThrown' || e.type === 'DartAdded' ? [e.payload.throwId] : []));
        expect(new Set(attributed).size).toBe(attributed.length);
        expect(await rig.store.load(log[0]!.sessionId)).toEqual(log);
      }),
      RUNS,
    );
  });
});


