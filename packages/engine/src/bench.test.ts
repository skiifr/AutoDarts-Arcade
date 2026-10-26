/**
 * Micro-benchmark, not a pass/fail timing test (ROADMAP Phase 3: "refolding a 1,000-dart log
 * takes ≤ 5 ms on a Fire OS stick"). It prints the numbers so they can be compared with the
 * same measurement on device.
 */
import { MISS, makeSegment, type ArcadeEvent, type Segment } from '@arcade/event-schema';
import { expect, it } from 'vitest';
import { foldSession } from './fold';
import { SessionFolder } from './folder';
import { SessionHost } from './host';
import type { LogStore } from './ports';
import { makePlayers, makeRig, registry } from './testing/harness';

declare const console: { log(...args: unknown[]): void };
declare const performance: { now(): number };

const SEGMENTS: Segment[] = [makeSegment(20, 1), makeSegment(20, 3), makeSegment(1, 1), makeSegment(5, 1), MISS, makeSegment(25, 1)];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < 5; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function thousandDartLog(): Promise<ArcadeEvent[]> {
  const rig = makeRig({ fold: { freezeGameStates: false } });
  // Ceiling keeps a constant-size state, like a real game (Sum's trail grows with every dart).
  await rig.run(rig.cmd.start('test-ceiling', makePlayers(4), { rounds: 84, ceiling: 180 }));
  for (let i = 0; i < 1000; i++) {
    await rig.host.ingest(rig.board.dart(SEGMENTS[i % SEGMENTS.length]!));
    if (i % 3 === 2) await rig.host.ingest(rig.board.takeout());
  }
  return [...rig.host.getLog()];
}

it('reports the refold time of a 1,000-dart log', async () => {
  const log = await thousandDartLog();
  const darts = log.filter((e) => e.type === 'DartThrown');
  expect(darts).toHaveLength(1000);
  const turns = foldSession(log, registry).turns.length;

  const fullCached = measure(() => foldSession(log, registry), 40);
  const fullUncached = measure(() => foldSession(log, registry, { snapshotEvery: 0 }), 40);

  // A correction of the very first dart: the worst case, a replay of every turn.
  const folder = SessionFolder.fromLog(log, registry);
  const first = darts[0]!;
  let flip = 0;
  const correction = measure(() => {
    const previous = SEGMENTS[flip % 2]!;
    const segment = SEGMENTS[++flip % 2]!;
    folder.apply({
      ...first,
      eventId: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ',
      seq: folder.lastSeq + 1,
      type: 'DartCorrected',
      payload: { throwId: first.payload.throwId, previous, segment, reason: 'user' },
    } as ArcadeEvent);
    folder.snapshot();
  }, 40);

  // A live dart through the whole host (decide, fold, snapshot), with a store that costs nothing.
  const store: LogStore = { append: async () => {}, load: async () => log, listSessions: async () => [] };
  const host = await SessionHost.resume({ store, clock: () => log.at(-1)!.receivedAt, ids: idsFrom(9000), games: registry }, log[0]!.sessionId);
  const rig = makeRig();
  const t0 = performance.now();
  const liveDarts = 60;
  for (let i = 0; i < liveDarts; i++) {
    await host.ingest(rig.board.dart(SEGMENTS[i % SEGMENTS.length]!));
    if (i % 3 === 2) await host.ingest(rig.board.takeout());
  }
  const perLiveDart = (performance.now() - t0) / liveDarts;

  // W4 preview (dry run on a copy of the live state), for the first dart and for the last turn.
  const cmd = rig.cmd;
  const lastTurn = host.getSnapshot()!.turns.at(-2)!;
  const previewFirst = measure(() => void host.preview(cmd.correct(first.payload.throwId, SEGMENTS[3]!)), 40);
  const previewLast = measure(() => void host.preview(cmd.correct(lastTurn.darts[0]!.throwId, SEGMENTS[3]!)), 40);

  const ms = (n: number) => `${n.toFixed(3)} ms`;
  console.log(
    [
      `[engine bench] 1,000-dart log: ${log.length} events, ${turns} turns`,
      `  full refold (foldSession), snapshot every 8 turns: ${ms(fullCached)} median`,
      `  full refold (foldSession), no snapshot cache:      ${ms(fullUncached)} median`,
      `  correction of dart 1 on a live folder (apply + snapshot): ${ms(correction)} median`,
      `  live dart through the host (incl. takeouts, no-op store): ${ms(perLiveDart)} mean`,
      `  W4 preview of a correction to dart 1:        ${ms(previewFirst)} median`,
      `  W4 preview of a correction to the last turn: ${ms(previewLast)} median`,
    ].join('\n'),
  );
});

function idsFrom(start: number): () => string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = start;
  return () => {
    let v = ++n;
    let out = '';
    for (let i = 0; i < 24; i++) {
      out = CROCKFORD[v % 32] + out;
      v = Math.floor(v / 32);
    }
    return `0B${out}`;
  };
}
