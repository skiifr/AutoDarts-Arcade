import { makeSegment, type ArcadeEvent, type EventOf, type PlayerRef } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import type { HostResult } from './host';
import { makePlayers, makeRig, types } from './testing/harness';

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);
const S2 = makeSegment(2, 1);
const S3 = makeSegment(3, 1);

const [A, B, C] = makePlayers(3) as [PlayerRef, PlayerRef, PlayerRef];

function find<T extends ArcadeEvent['type']>(result: HostResult | undefined, type: T): EventOf<T>[] {
  return result?.status === 'applied' ? result.events.filter((e): e is EventOf<T> => e.type === type) : [];
}

async function started(players = [A, B, C], options: Record<string, unknown> = { rounds: 3 }) {
  const rig = makeRig();
  await rig.run(rig.cmd.start('test-sum', players, options));
  return rig;
}

describe('owner decision R: uncertain history is flagged, never guessed', () => {
  it('scores recovered darts of the same visit as recovered and flags the turn at takeout, without pausing', async () => {
    const rig = await started();
    const { board } = rig;
    const out = await rig.run(
      board.dart(S20),
      board.connection('offline'),
      board.connection('resyncing'),
      board.dart(S5, { recovered: true }),
      board.connection('online'),
      board.takeout(),
    );
    expect(find(out[3], 'DartThrown')[0]!.payload.origin).toBe('recovered');
    expect(types(out[5])).toEqual(['TakeoutFinished', 'DartAdded', 'TurnEnded', 'TurnStarted']);
    expect(find(out[5], 'TurnEnded')[0]!.payload).toEqual({
      playerId: A.playerId,
      turnIndex: 0,
      reason: 'takeout',
      needsReview: true,
    });
    const s = rig.host.getSnapshot()!;
    expect(s.paused).toEqual([]);
    expect(s.needsReview).toEqual([0]);
    expect(s.turns[0]!.darts.map((d) => [d.segment.label, d.origin, d.scored])).toEqual([
      ['S20', 'detected', true],
      ['S5', 'recovered', true],
      ['MISS', 'undetected', true],
    ]);
  });

  it('on an inferred takeout ends the turn flagged, does not pad, pauses for review and starts no turn', async () => {
    const rig = await started();
    const { board } = rig;
    const [, inferred] = await rig.run(board.dart(S20), board.takeout({ inferred: true }));
    expect(types(inferred)).toEqual(['TakeoutFinished', 'TurnEnded', 'GamePaused']);
    expect(find(inferred, 'TurnEnded')[0]!.payload).toEqual({
      playerId: A.playerId,
      turnIndex: 0,
      reason: 'takeout',
      needsReview: true,
    });
    expect(find(inferred, 'GamePaused')[0]!.payload).toEqual({ reason: 'review' });
    const s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('awaiting-review');
    expect(s.awaitingReviewTurn).toBe(0);
    expect(s.currentTurn).toBeNull();
    expect(s.nextPlayerId).toBe(B.playerId);
    expect(s.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['S20']);
  });

  it('flags the turn at an inferred takeout even when no dart was seen', async () => {
    const rig = await started();
    const [inferred] = await rig.run(rig.board.takeout({ inferred: true }));
    expect(types(inferred)).toEqual(['TakeoutFinished', 'TurnEnded', 'GamePaused']);
    expect(rig.host.getSnapshot()!.needsReview).toEqual([0]);
  });

  it('ConfirmTurn records TurnReviewed, then GameResumed{review}, then starts the next turn', async () => {
    const rig = await started();
    await rig.run(rig.board.dart(S20), rig.board.takeout({ inferred: true }));
    const confirm = rig.cmd.confirm(0);
    const [r] = await rig.run(confirm);
    expect(types(r)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted']);
    const evs = r!.status === 'applied' ? r!.events : [];
    expect(evs[0]!.payload).toEqual({ playerId: A.playerId, turnIndex: 0 });
    expect(evs[1]!.payload).toEqual({ reason: 'review' });
    expect(evs[2]!.payload).toEqual({ playerId: B.playerId, turnIndex: 1, roundIndex: 0 });
    for (const e of evs) expect(e.causationId).toBe(confirm.commandId);
    const s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('playing');
    expect(s.needsReview).toEqual([]);
    expect(s.reviewedTurns).toEqual([0]);
    expect(s.turns[0]!.reviewed).toBe(true);
  });

  it('holds board darts that arrive during the review pause and gives them to the next turn when it starts', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    const out = await rig.run(
      board.dart(S20),
      board.connection('offline'),
      board.connection('resyncing'),
      board.takeout({ inferred: true }),
      board.dart(T20, { recovered: true }),
      board.dart(S1, { recovered: true }),
      board.connection('online'),
      board.dart(S2),
    );
    expect(types(out[3])).toEqual(['TakeoutFinished', 'TurnEnded', 'GamePaused']);
    expect(types(out[4])).toEqual(['DartDetected']);
    expect(types(out[5])).toEqual(['DartDetected']);
    expect(types(out[7])).toEqual(['DartDetected']);
    let s = rig.host.getSnapshot()!;
    expect(s.heldDarts.map((d) => [d.segment.label, d.recovered])).toEqual([
      ['T20', true],
      ['S1', true],
      ['S2', false],
    ]);
    expect(s.paused).toEqual(['review']);

    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown', 'DartThrown', 'DartThrown']);
    expect(find(confirm, 'DartThrown').map((e) => [e.payload.playerId, e.payload.dartIndex, e.payload.origin])).toEqual([
      [B.playerId, 0, 'recovered'],
      [B.playerId, 1, 'recovered'],
      [B.playerId, 2, 'detected'],
    ]);
    s = rig.host.getSnapshot()!;
    expect(s.heldDarts).toEqual([]);
    expect(s.currentPlayerId).toBe(B.playerId);
    expect(s.dartsThisTurn.map((d) => d.segment.label)).toEqual(['T20', 'S1', 'S2']);
    // Their attribution was a guess, so B's turn is flagged too.
    const [end] = await rig.run(board.takeout());
    expect(find(end, 'TurnEnded')[0]!.payload.needsReview).toBe(true);
  });

  it('ends a held visit that was taken out during the pause, and starts the following one', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(
      board.dart(S20),
      board.takeout({ inferred: true }),
      board.dart(S1),
      board.dart(S2),
      board.takeout(),
      board.dart(S3),
    );
    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual([
      'TurnReviewed',
      'GameResumed',
      'TurnStarted',
      'DartThrown',
      'DartThrown',
      'DartAdded',
      'TurnEnded',
      'TurnStarted',
      'DartThrown',
    ]);
    const s = rig.host.getSnapshot()!;
    expect(s.turns.map((t) => [t.playerId, t.darts.map((d) => d.segment.label), t.needsReview])).toEqual([
      [A.playerId, ['S20'], true],
      [B.playerId, ['S1', 'S2', 'MISS'], false],
      [C.playerId, ['S3'], false],
    ]);
  });

  it('stops releasing at another inferred takeout and pauses for that review', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(board.dart(S20), board.takeout({ inferred: true }), board.dart(S1), board.takeout({ inferred: true }), board.dart(S2));
    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown', 'TurnEnded', 'GamePaused']);
    let s = rig.host.getSnapshot()!;
    expect(s.awaitingReviewTurn).toBe(1);
    expect(s.heldDarts.map((d) => d.segment.label)).toEqual(['S2']);
    const [second] = await rig.run(cmd.confirm(1));
    expect(types(second)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown']);
    s = rig.host.getSnapshot()!;
    expect(s.currentPlayerId).toBe(C.playerId);
    expect(s.dartsThisTurn.map((d) => d.segment.label)).toEqual(['S2']);
  });

  it('keeps held darts up to date with board updates and withdrawals', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(board.dart(S20), board.takeout({ inferred: true }));
    const a = board.dart(S1);
    const b = board.dart(S2);
    await rig.run(a, b, board.update(a.throwId, S1, T20), board.withdraw(b.throwId));
    expect(rig.host.getSnapshot()!.heldDarts.map((d) => d.segment.label)).toEqual(['T20']);
    await rig.run(cmd.confirm(0));
    expect(rig.host.getSnapshot()!.dartsThisTurn.map((d) => d.segment.label)).toEqual(['T20']);
  });

  it('on release, ignores a visit end the board reported before the held darts arrived', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    // An adapter anomaly: darts carrying the key of the visit that was just (inferred) taken out.
    const late = board.dart(S1);
    await rig.run(board.dart(S20), board.takeout({ inferred: true }), late);
    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown']);
    expect(rig.host.getSnapshot()!.phase).toBe('playing');
  });

  it('lets a person correct a review turn before confirming it', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    const d = board.dart(S5);
    await rig.run(d, board.takeout({ inferred: true }));
    const out = await rig.run(
      cmd.correct(d.throwId, S20),
      cmd.add(A.playerId, 0, 1, T20, 'undetected'),
      cmd.add(A.playerId, 0, 2, S1, 'bounce-out'),
    );
    expect(out.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    let s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('awaiting-review');
    expect(s.turns[0]!.darts.map((x) => x.segment.label)).toEqual(['S20', 'T20', 'S1']);
    expect(s.view).toEqual({ scores: { [A.playerId]: 81, [B.playerId]: 0, [C.playerId]: 0 } });
    await rig.run(cmd.confirm(0));
    s = rig.host.getSnapshot()!;
    expect(s.currentPlayerId).toBe(B.playerId);
  });

  it('refuses CloseSession{completed} while a flagged turn is unreviewed; abandoned is always allowed', async () => {
    const rig = await started([A], { rounds: 1 });
    const { board, cmd } = rig;
    await rig.run(board.dart(S20, { recovered: true }), board.takeout());
    let s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('finished');
    expect(s.finished!.provisional).toBe(true);
    expect(s.canComplete).toBe(false);
    const [refused, rematch] = await rig.run(cmd.close('completed'), cmd.rematch());
    expect(refused).toMatchObject({ status: 'rejected', reason: 'needs-review' });
    expect(rematch).toMatchObject({ status: 'rejected', reason: 'needs-review' });

    await rig.run(cmd.confirm(0));
    s = rig.host.getSnapshot()!;
    expect(s.canComplete).toBe(true);
    const [done] = await rig.run(cmd.close('completed'));
    expect(types(done)).toEqual(['SessionClosed']);
    s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('closed');
    expect(s.finished!.provisional).toBe(false);

    const rig2 = await started();
    await rig2.run(rig2.board.dart(S20), rig2.board.takeout({ inferred: true }));
    const [abandoned] = await rig2.run(rig2.cmd.close('abandoned'));
    expect(types(abandoned)).toEqual(['SessionClosed']);
  });

  it('refuses CloseSession{completed} before the game is over', async () => {
    const rig = await started();
    const [r] = await rig.run(rig.cmd.close('completed'));
    expect(r).toMatchObject({ status: 'rejected', reason: 'not-finished' });
  });

  it('rejects ConfirmTurn for a turn that is unknown, not flagged or already reviewed', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(board.dart(S20), board.takeout({ inferred: true }), cmd.confirm(0), board.dart(S1), board.takeout());
    const [unknown, notFlagged, again] = await rig.run(cmd.confirm(9), cmd.confirm(1), cmd.confirm(0));
    expect(unknown).toMatchObject({ status: 'rejected', reason: 'unknown-turn' });
    expect(notFlagged).toMatchObject({ status: 'rejected', reason: 'not-flagged' });
    expect(again).toMatchObject({ status: 'rejected', reason: 'already-reviewed' });
  });

  it('confirming an older flagged turn does not lift a review pause held for a later one', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(board.dart(S20, { recovered: true }), board.takeout(), board.dart(S1), board.takeout({ inferred: true }));
    expect(rig.host.getSnapshot()!.needsReview).toEqual([0, 1]);
    const [older] = await rig.run(cmd.confirm(0));
    expect(types(older)).toEqual(['TurnReviewed']);
    expect(rig.host.getSnapshot()!.phase).toBe('awaiting-review');
  });
});
