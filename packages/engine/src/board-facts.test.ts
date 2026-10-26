import { makeSegment, type ArcadeEvent, type EventOf, type PlayerRef } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import type { HostResult } from './host';
import { makePlayers, makeRig } from './testing/harness';

/** How the host takes the facts the autodarts-local adapter actually produces (the Phase 2/3 integration). */

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);
const S2 = makeSegment(2, 1);
const S3 = makeSegment(3, 1);
const MISS = { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' } as const;

const [A, B] = makePlayers(3) as [PlayerRef, PlayerRef, PlayerRef];

function find<T extends ArcadeEvent['type']>(result: HostResult | undefined, type: T): EventOf<T>[] {
  return result?.status === 'applied' ? result.events.filter((e): e is EventOf<T> => e.type === type) : [];
}

async function started(game = 'test-sum', players = [A, B], options: Record<string, unknown> = { rounds: 3 }) {
  const rig = makeRig();
  await rig.run(rig.cmd.start(game, players, options));
  return rig;
}

describe('unreadable darts (DartDetected.pendingReview)', () => {
  it('scores the stand-in miss and flags its turn at an observed takeout, without pausing', async () => {
    const rig = await started();
    const { board } = rig;
    const out = await rig.run(board.dart(S20), board.dart(MISS, { pendingReview: true }), board.dart(S5), board.takeout());
    expect(find(out[1], 'DartThrown')[0]!.payload.origin).toBe('detected');
    expect(find(out[3], 'TurnEnded')[0]!.payload).toEqual({ playerId: A.playerId, turnIndex: 0, reason: 'takeout', needsReview: true });
    const s = rig.host.getSnapshot()!;
    expect(s.paused).toEqual([]);
    expect(s.needsReview).toEqual([0]);
    expect(s.currentPlayerId).toBe(B.playerId);
    expect(s.turns[0]!.darts.map((d) => [d.segment.label, d.pendingReview])).toEqual([
      ['S20', false],
      ['MISS', true],
      ['S5', false],
    ]);
  });

  it('does not flag a turn whose darts were all readable', async () => {
    const rig = await started();
    const [, end] = await rig.run(rig.board.dart(S20), rig.board.takeout());
    expect(find(end, 'TurnEnded')[0]!.payload.needsReview).toBeUndefined();
  });

  it('flags the turn of a dart the board re-read as unreadable, and unflags it when re-read readable', async () => {
    const rig = await started();
    const { board } = rig;
    const d = board.dart(T20);
    const [, upd] = await rig.run(d, board.update(d.throwId, T20, MISS, { pendingReview: true }));
    expect(find(upd, 'DartCorrected')[0]!.payload).toMatchObject({ segment: MISS, reason: 'source-update' });
    expect(rig.host.getSnapshot()!.dartsThisTurn[0]!.pendingReview).toBe(true);
    const [, end] = await rig.run(board.dart(S1), board.takeout());
    expect(find(end, 'TurnEnded')[0]!.payload.needsReview).toBe(true);

    const e = board.dart(S2);
    await rig.run(e, board.update(e.throwId, S2, MISS, { pendingReview: true }), board.update(e.throwId, MISS, S3));
    expect(rig.host.getSnapshot()!.dartsThisTurn[0]).toMatchObject({ pendingReview: false, segment: S3 });
    const [end2] = await rig.run(board.takeout());
    expect(find(end2, 'TurnEnded')[0]!.payload.needsReview).toBeUndefined();
  });

  it('keeps the flag on a baseline dart and on a held dart released into the next turn', async () => {
    const rig = makeRig();
    const { board, cmd } = rig;
    const [, start] = await rig.run(board.dart(MISS, { pendingReview: true }), cmd.start('test-sum', [A, B], { rounds: 3 }));
    expect(find(start, 'DartDetected')[0]!.payload.pendingReview).toBe(true);
    await rig.run(board.takeout(), board.dart(S20), board.takeout({ inferred: true }), board.dart(MISS, { pendingReview: true }));
    await rig.run(cmd.confirm(0));
    const [end] = await rig.run(board.takeout());
    expect(find(end, 'TurnEnded')[0]!.payload).toMatchObject({ playerId: B.playerId, needsReview: true });
  });
});
