import { makeSegment, type ArcadeEvent, type BoardFactDraft, type EventOf, type PlayerRef } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { SessionHost, type HostResult } from './host';
import { makePlayers, makeRig, types } from './testing/harness';

/**
 * How the host takes the facts the autodarts-local adapter actually produces (the Phase 2/3
 * integration): unreadable darts, re-reads that only move a dart, takeouts the board calls
 * off, inferred takeouts of empty visits, resets, resync correlation, and held darts at the
 * end of a game.
 */

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);
const S2 = makeSegment(2, 1);
const S3 = makeSegment(3, 1);
const MISS = { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' } as const;

const [A, B, C] = makePlayers(3) as [PlayerRef, PlayerRef, PlayerRef];

function find<T extends ArcadeEvent['type']>(result: HostResult | undefined, type: T): EventOf<T>[] {
  return result?.status === 'applied' ? result.events.filter((e): e is EventOf<T> => e.type === type) : [];
}

async function started(game = 'test-sum', players = [A, B, C], options: Record<string, unknown> = { rounds: 3 }) {
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

describe('adapter facts the engine must take as they come', () => {
  it('a DartUpdated that only moves the dart (previous equals segment) is logged but corrects nothing', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    const d = board.dart(S5);
    const [, moved] = await rig.run(d, board.update(d.throwId, S5, S5));
    expect(types(moved)).toEqual(['DartUpdated']);
    let s = rig.host.getSnapshot()!;
    expect(s.dartsThisTurn[0]).toMatchObject({ segment: S5, adjusted: false });
    // Also after a person's correction, and while the dart is held in a review pause.
    await rig.run(cmd.correct(d.throwId, S20));
    const [again] = await rig.run(board.update(d.throwId, S5, S5));
    expect(types(again)).toEqual(['DartUpdated']);
    await rig.run(board.takeout(), board.dart(S1), board.takeout({ inferred: true }));
    const h = board.dart(S2);
    const [, , heldMove] = await rig.run(h, board.update(h.throwId, S2, S2), board.update(h.throwId, S2, S2));
    expect(types(heldMove)).toEqual(['DartUpdated']);
    s = rig.host.getSnapshot()!;
    expect(s.heldDarts.map((x) => x.segment.label)).toEqual(['S2']);
    expect(s.turns[0]!.darts.map((x) => x.segment.label)).toEqual(['S20', 'MISS', 'MISS']);
  });

  it('a dart after TakeoutStarted in the same visit means the takeout was called off: same turn, nothing ended', async () => {
    const rig = await started();
    const { board } = rig;
    const out = await rig.run(board.dart(S20), board.dart(S5), board.takeoutStarted(), board.dart(T20));
    expect(out.map(types)).toEqual([
      ['DartDetected', 'DartThrown'],
      ['DartDetected', 'DartThrown'],
      ['TakeoutStarted'],
      ['DartDetected', 'DartThrown'],
    ]);
    expect(find(out[3], 'DartThrown')[0]!.payload).toMatchObject({ playerId: A.playerId, turnIndex: 0, dartIndex: 2 });
    const [, end] = await rig.run(board.takeoutStarted(), board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    const s = rig.host.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['S20', 'S5', 'T20']);
    expect(s.turns[0]!.needsReview).toBe(false);
  });

  describe('TakeoutFinished{inferred} for a visit with no darts', () => {
    it('during a turn: ends it flagged and pauses for review (nothing to pad)', async () => {
      const rig = await started();
      const [r] = await rig.run(rig.board.takeout({ inferred: true }));
      expect(types(r)).toEqual(['TakeoutFinished', 'TurnEnded', 'GamePaused']);
      expect(rig.host.getSnapshot()!.turns[0]!.darts).toEqual([]);
    });

    it('during a review pause: the turn after the confirmed one ends flagged and pauses again', async () => {
      const rig = await started();
      const { board, cmd } = rig;
      // A's turn ends on an inferred takeout; while the game waits, the board goes away
      // again long enough for a whole visit (B's) to come and go unseen.
      await rig.run(board.dart(S20), board.takeout({ inferred: true }));
      const [second] = await rig.run(board.takeout({ inferred: true }));
      expect(types(second)).toEqual(['TakeoutFinished']);
      expect(rig.host.getSnapshot()!.heldDarts).toEqual([]);
      const [confirm] = await rig.run(cmd.confirm(0));
      expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'TurnEnded', 'GamePaused']);
      expect(find(confirm, 'TurnEnded')[0]!.payload).toEqual({ playerId: B.playerId, turnIndex: 1, reason: 'takeout', needsReview: true });
      expect(find(confirm, 'TurnEnded')[0]!.causationId).toBe(find(second, 'TakeoutFinished')[0]!.eventId);
      let s = rig.host.getSnapshot()!;
      expect(s.phase).toBe('awaiting-review');
      expect(s.awaitingReviewTurn).toBe(1);
      // Darts thrown after it go to C once B's empty turn is confirmed.
      await rig.run(board.dart(T20));
      const [next] = await rig.run(cmd.confirm(1));
      expect(types(next)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown']);
      s = rig.host.getSnapshot()!;
      expect(s.currentPlayerId).toBe(C.playerId);
      expect(s.dartsThisTurn.map((d) => d.segment.label)).toEqual(['T20']);
      // A replay of the log ends in the same state.
      const resumed = await SessionHost.resume(rig.deps, s.sessionId);
      expect(resumed.getSnapshot()).toEqual(s);
    });

    it('during a review pause, before held darts: ends the next turn first, then holds the darts for the one after', async () => {
      const rig = await started();
      const { board, cmd } = rig;
      await rig.run(board.dart(S20), board.takeout({ inferred: true }), board.takeout({ inferred: true }), board.dart(S5, { recovered: true }));
      const [confirm] = await rig.run(cmd.confirm(0));
      expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'TurnEnded', 'GamePaused']);
      expect(rig.host.getSnapshot()!.heldDarts.map((d) => d.segment.label)).toEqual(['S5']);
      const [second] = await rig.run(cmd.confirm(1));
      expect(types(second)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted', 'DartThrown']);
      expect(find(second, 'DartThrown')[0]!.payload.playerId).toBe(C.playerId);
    });

    it('during a review pause, an observed empty takeout (a hand in front of the cameras) is ignored', async () => {
      const rig = await started();
      const { board, cmd } = rig;
      await rig.run(board.dart(S20), board.takeout({ inferred: true }), board.takeout());
      const [confirm] = await rig.run(cmd.confirm(0));
      expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed', 'TurnStarted']);
    });

    it('before the first turn it only clears the baseline; after the game it changes nothing', async () => {
      const rig = makeRig();
      await rig.run(rig.board.dart(S20), rig.cmd.start('test-sum', [A], { rounds: 1 }));
      const [clear] = await rig.run(rig.board.takeout({ inferred: true }));
      expect(types(clear)).toEqual(['TakeoutFinished', 'TurnStarted']);
      await rig.run(rig.board.dart(S1), rig.board.takeout());
      expect(rig.host.getSnapshot()!.phase).toBe('finished');
      const [after] = await rig.run(rig.board.takeout({ inferred: true }));
      expect(types(after)).toEqual(['TakeoutFinished']);
      expect(rig.host.getSnapshot()!.canComplete).toBe(true);
    });
  });

  it('VisitReset then a DartWithdrawn per dart (the adapter order): the turn ends flagged and keeps its darts', async () => {
    const rig = await started();
    const { board } = rig;
    const a = board.dart(S5);
    const b = board.dart(T20);
    const out = await rig.run(a, b, board.reset(), board.withdraw(a.throwId), board.withdraw(b.throwId), board.dart(S1));
    expect(out.slice(2).map(types)).toEqual([
      ['VisitReset', 'TurnEnded', 'TurnStarted'],
      ['DartWithdrawn'],
      ['DartWithdrawn'],
      ['DartDetected', 'DartThrown'],
    ]);
    const s = rig.host.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['S5', 'T20']);
    expect(s.turns[0]!.needsReview).toBe(true);
    expect(s.turns[1]!.darts.map((d) => [d.segment.label, d.position])).toEqual([['S1', 0]]);
  });

  it('keeps every fact of one resync under its correlationId, and the events derived from them point at their fact', async () => {
    const rig = await started();
    const { board } = rig;
    const correlationId = '01JBX0000000000000000000RC';
    const tag = (f: BoardFactDraft): BoardFactDraft => ({ ...f, correlationId });
    const resync = [board.connection('resyncing'), board.takeout({ inferred: true }), board.dart(S5, { recovered: true }), board.connection('online')];
    await rig.run(board.dart(S20), board.connection('offline'), ...resync.map(tag));
    const log = rig.host.getLog();
    const facts = log.filter((e) => e.correlationId === correlationId);
    expect(facts.map((e) => e.type)).toEqual(['SourceConnectionChanged', 'TakeoutFinished', 'DartDetected', 'SourceConnectionChanged']);
    const takeout = facts[1]!;
    expect(log.filter((e) => e.causationId === takeout.eventId).map((e) => e.type)).toEqual(['TurnEnded', 'GamePaused']);
  });
});

describe('held darts when the game ends (review release)', () => {
  it('lists nothing as held once a released dart finishes the game; a correction that reopens it releases the rest', async () => {
    const rig = await started('test-race', [A, B], { target: 60 });
    const { board, cmd } = rig;
    await rig.run(board.dart(S1), board.takeout({ inferred: true }));
    // Held while A's turn waits for review: B's winning visit, then A's next visit.
    const win = board.dart(T20);
    await rig.run(win, board.dart(S2), board.takeout(), board.dart(S5), board.dart(S3));
    expect(rig.host.getSnapshot()!.heldDarts.map((d) => d.segment.label)).toEqual(['T20', 'S2', 'S5', 'S3']);

    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual([
      'TurnReviewed',
      'GameResumed',
      'TurnStarted',
      'DartThrown',
      'GameFinished',
      'DartThrown',
      'DartAdded',
      'TurnEnded',
    ]);
    let s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('finished');
    expect(s.heldDarts).toEqual([]);
    expect(s.turns[1]!.darts.map((d) => [d.segment.label, d.greyedBy])).toEqual([
      ['T20', null],
      ['S2', 'finished'],
      ['MISS', 'finished'],
    ]);

    const [reopen] = await rig.run(cmd.correct(win.throwId, S20));
    expect(types(reopen)).toEqual(['DartCorrected', 'TurnStarted', 'DartThrown', 'DartThrown']);
    s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('playing');
    expect(s.heldDarts).toEqual([]);
    expect(s.currentPlayerId).toBe(A.playerId);
    expect(s.dartsThisTurn.map((d) => d.segment.label)).toEqual(['S5', 'S3']);
  });

  it('lists nothing as held when the turn under review already ended the game', async () => {
    const rig = await started('test-sum', [A], { rounds: 1 });
    const { board, cmd } = rig;
    const [, end] = await rig.run(board.dart(S20), board.takeout({ inferred: true }));
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'GameFinished', 'GamePaused']);
    await rig.run(board.dart(S5));
    expect(rig.host.getSnapshot()!.heldDarts).toEqual([]);
    const [confirm] = await rig.run(cmd.confirm(0));
    expect(types(confirm)).toEqual(['TurnReviewed', 'GameResumed']);
    const s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('finished');
    expect(s.heldDarts).toEqual([]);
    expect(s.canComplete).toBe(true);
  });
});
