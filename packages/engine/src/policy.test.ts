import { DEFAULT_HOUSE_RULES, MISS, makeSegment, type ArcadeEvent, type EventOf, type PlayerRef } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import type { HostResult } from './host';
import { makePlayers, makeRig, types } from './testing/harness';

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);
const S2 = makeSegment(2, 1);
const S3 = makeSegment(3, 1);
const D10 = makeSegment(10, 2);

const [A, B] = makePlayers(2) as [PlayerRef, PlayerRef];

function events(result: HostResult | undefined): ArcadeEvent[] {
  return result?.status === 'applied' ? [...result.events] : [];
}

function find<T extends ArcadeEvent['type']>(result: HostResult | undefined, type: T): EventOf<T>[] {
  return events(result).filter((e): e is EventOf<T> => e.type === type);
}

function labels(rig: ReturnType<typeof makeRig>, turnIndex: number): string[] {
  return rig.host.getSnapshot()!.turns[turnIndex]!.darts.map((d) => d.segment.label);
}

async function started(game: string, players = [A, B], options: Record<string, unknown> = {}, houseRules = DEFAULT_HOUSE_RULES) {
  const rig = makeRig({ houseRules });
  const [r] = await rig.run(rig.cmd.start(game, players, options));
  expect(r!.status).toBe('applied');
  return rig;
}

describe('turn policy (ARCHITECTURE §8.3, §6.3)', () => {
  it('attributes darts 1–3 to the current player with dartIndex 0–2', async () => {
    const rig = await started('test-sum');
    const out = await rig.run(rig.board.dart(T20), rig.board.dart(S5), rig.board.dart(S1));
    const thrown = out.flatMap((r) => find(r, 'DartThrown'));
    expect(thrown.map((e) => [e.payload.playerId, e.payload.turnIndex, e.payload.dartIndex, e.payload.origin])).toEqual([
      [A.playerId, 0, 0, 'detected'],
      [A.playerId, 0, 1, 'detected'],
      [A.playerId, 0, 2, 'detected'],
    ]);
    const s = rig.host.getSnapshot()!;
    expect(s.currentPlayerId).toBe(A.playerId);
    expect(s.dartsThisTurn.map((d) => [d.segment.label, d.position, d.scored])).toEqual([
      ['T20', 0, true],
      ['S5', 1, true],
      ['S1', 2, true],
    ]);
    expect(s.view).toEqual({ scores: { [A.playerId]: 66, [B.playerId]: 0 } });
  });

  it('ends the turn at takeout and starts the next player, counting a round on wrap-around', async () => {
    const rig = await started('test-sum', [A, B], { rounds: 3 });
    const { board } = rig;
    await rig.run(board.dart(T20), board.dart(T20), board.dart(T20), board.takeoutStarted());
    const [end1] = await rig.run(board.takeout());
    expect(types(end1)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    expect(find(end1, 'TurnEnded')[0]!.payload).toEqual({ playerId: A.playerId, turnIndex: 0, reason: 'takeout' });
    expect(find(end1, 'TurnStarted')[0]!.payload).toEqual({ playerId: B.playerId, turnIndex: 1, roundIndex: 0 });
    const [, , , end2] = await rig.run(board.dart(S1), board.dart(S1), board.dart(S1), board.takeout());
    expect(find(end2, 'TurnStarted')[0]!.payload).toEqual({ playerId: A.playerId, turnIndex: 2, roundIndex: 1 });
    expect(rig.host.getSnapshot()!.roundIndex).toBe(1);
  });

  it('pads a short visit with misses at an observed takeout (missingDartsAreMisses)', async () => {
    const rig = await started('test-sum');
    const [, end] = await rig.run(rig.board.dart(T20), rig.board.takeout());
    const pads = find(end, 'DartAdded');
    expect(pads.map((e) => [e.payload.dartIndex, e.payload.segment.label, e.payload.reason, e.source.kind])).toEqual([
      [1, 'MISS', 'undetected', 'engine'],
      [2, 'MISS', 'undetected', 'engine'],
    ]);
    expect(rig.host.getSnapshot()!.turns[0]!.darts.map((d) => d.padded)).toEqual([false, true, true]);
  });

  it('does not pad when missingDartsAreMisses is off', async () => {
    const rig = await started('test-sum', [A, B], {}, { missingDartsAreMisses: false, emptyTakeoutSkipsTurn: false });
    const [, end] = await rig.run(rig.board.dart(T20), rig.board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    expect(labels(rig, 0)).toEqual(['T20']);
  });

  it('ignores a takeout with no darts by default', async () => {
    const rig = await started('test-sum');
    const [end] = await rig.run(rig.board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished']);
    expect(rig.host.getSnapshot()!.currentPlayerId).toBe(A.playerId);
  });

  it('counts an empty takeout as a skipped turn when emptyTakeoutSkipsTurn is on', async () => {
    const rig = await started('test-sum', [A, B], {}, { missingDartsAreMisses: true, emptyTakeoutSkipsTurn: true });
    const [end] = await rig.run(rig.board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    expect(find(end, 'TurnEnded')[0]!.payload.reason).toBe('manual-skip');
    expect(rig.host.getSnapshot()!.currentPlayerId).toBe(B.playerId);
  });

  it('greys out darts after a bust; the turn still ends only at takeout', async () => {
    const rig = await started('test-ceiling', [A, B], { ceiling: 60 });
    const out = await rig.run(rig.board.dart(T20), rig.board.dart(S5), rig.board.dart(S20));
    expect(out.map(types)).toEqual([
      ['DartDetected', 'DartThrown'],
      ['DartDetected', 'DartThrown'],
      ['DartDetected', 'DartThrown'],
    ]);
    let s = rig.host.getSnapshot()!;
    expect(s.currentTurn!.closedBy).toBe('bust');
    expect(s.dartsThisTurn.map((d) => [d.segment.label, d.scored, d.greyedBy])).toEqual([
      ['T20', true, null],
      ['S5', true, null],
      ['S20', false, 'bust'],
    ]);
    expect(s.view).toEqual({ scores: { [A.playerId]: 0, [B.playerId]: 0 }, busts: 1 });
    const [end] = await rig.run(rig.board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    s = rig.host.getSnapshot()!;
    expect(s.turns[0]!.endReason).toBe('takeout');
    expect(s.currentPlayerId).toBe(B.playerId);
  });

  it('pauses for board-offline mid-turn, still scores darts recovered meanwhile, and resumes online', async () => {
    const rig = await started('test-sum');
    const { board } = rig;
    const out = await rig.run(
      board.dart(S20),
      board.connection('offline'),
      board.connection('offline'),
      board.connection('resyncing'),
      board.dart(S5, { recovered: true }),
      board.connection('online'),
    );
    expect(out.map(types)).toEqual([
      ['DartDetected', 'DartThrown'],
      ['SourceConnectionChanged', 'GamePaused'],
      ['SourceConnectionChanged'],
      ['SourceConnectionChanged'],
      ['DartDetected', 'DartThrown'],
      ['SourceConnectionChanged', 'GameResumed'],
    ]);
    expect(find(out[1], 'GamePaused')[0]!.payload.reason).toBe('board-offline');
    expect(find(out[4], 'DartThrown')[0]!.payload.origin).toBe('recovered');
    const s = rig.host.getSnapshot()!;
    expect(s.paused).toEqual([]);
    expect(s.board.connection).toBe('online');
    expect(s.view).toEqual({ scores: { [A.playerId]: 25, [B.playerId]: 0 } });
  });

  it('manual mode: AddDart{manual-mode} scores live and SkipTurn ("Next player") ends the turn without padding', async () => {
    const rig = await started('test-sum');
    const { cmd } = rig;
    const effects: string[] = [];
    rig.host.subscribeEffects((fx) => effects.push(...fx.map((e) => (e.type === 'game' ? e.effect.kind : e.type))));
    const out = await rig.run(
      cmd.add(A.playerId, 0, 0, T20, 'manual-mode'),
      cmd.add(A.playerId, 0, 1, S5, 'manual-mode'),
      cmd.skip(),
    );
    expect(out.map(types)).toEqual([['DartAdded'], ['DartAdded'], ['TurnEnded', 'TurnStarted']]);
    expect(find(out[2], 'TurnEnded')[0]!.payload.reason).toBe('manual-skip');
    expect(labels(rig, 0)).toEqual(['T20', 'S5']);
    expect(effects).toEqual(['big-hit', 'hit']);
    expect(rig.host.getSnapshot()!.currentPlayerId).toBe(B.playerId);
  });

  it('records board updates as source-update corrections; a person’s correction wins over a later update', async () => {
    const rig = await started('test-sum');
    const { board, cmd } = rig;
    const d = board.dart(S5);
    const [, upd] = await rig.run(d, board.update(d.throwId, S5, S1));
    expect(find(upd, 'DartCorrected')[0]!.payload).toEqual({ throwId: d.throwId, previous: S5, segment: S1, reason: 'source-update' });
    expect(rig.host.getSnapshot()!.dartsThisTurn[0]).toMatchObject({ adjusted: true, points: 1 });
    await rig.run(cmd.correct(d.throwId, S20));
    const [late] = await rig.run(board.update(d.throwId, S1, S2));
    expect(types(late)).toEqual(['DartUpdated']);
    expect(labels(rig, 0)).toEqual(['S20']);
  });

  it('voids a dart the board withdraws', async () => {
    const rig = await started('test-sum');
    const d = rig.board.dart(S5);
    const [, w] = await rig.run(d, rig.board.withdraw(d.throwId));
    expect(find(w, 'DartVoided')[0]!.payload).toEqual({ throwId: d.throwId, reason: 'source-withdrawn' });
    const s = rig.host.getSnapshot()!;
    expect(s.dartsThisTurn).toEqual([]);
    expect(s.currentTurn!.voidedDarts.map((v) => v.reason)).toEqual(['source-withdrawn']);
  });

  it('ends and flags the turn when the board is reset mid-visit, without voiding or padding its darts', async () => {
    const rig = await started('test-sum');
    const { board } = rig;
    const d1 = board.dart(S5);
    const d2 = board.dart(S1);
    const [, , reset, w1, w2] = await rig.run(d1, d2, board.reset(), board.withdraw(d1.throwId), board.withdraw(d2.throwId));
    expect(types(reset)).toEqual(['VisitReset', 'TurnEnded', 'TurnStarted']);
    expect(find(reset, 'TurnEnded')[0]!.payload).toMatchObject({ reason: 'takeout', needsReview: true });
    expect(types(w1)).toEqual(['DartWithdrawn']);
    expect(types(w2)).toEqual(['DartWithdrawn']);
    const s = rig.host.getSnapshot()!;
    expect(labels(rig, 0)).toEqual(['S5', 'S1']);
    expect(s.needsReview).toEqual([0]);
  });

  it('greys a fourth dart in one visit and flags the turn', async () => {
    const rig = await started('test-sum');
    const { board } = rig;
    const [, , , fourth, end] = await rig.run(board.dart(S1), board.dart(S2), board.dart(S3), board.dart(S20), board.takeout());
    expect(find(fourth, 'DartThrown')[0]!.payload.dartIndex).toBe(2);
    expect(rig.host.getSnapshot()!.turns[0]!.darts.map((d) => d.greyedBy)).toEqual([null, null, null, 'overflow']);
    expect(find(end, 'TurnEnded')[0]!.payload.needsReview).toBe(true);
    expect(rig.host.getSnapshot()!.view).toEqual({ scores: { [A.playerId]: 6, [B.playerId]: 0 } });
  });

  it('does not let the takeout of an earlier, skipped visit end the next player’s turn', async () => {
    const rig = await started('test-sum', [A, B], {}, { missingDartsAreMisses: true, emptyTakeoutSkipsTurn: true });
    const { board, cmd } = rig;
    const [, , late] = await rig.run(board.dart(S20), cmd.skip(), board.takeout());
    expect(types(late)).toEqual(['TakeoutFinished']);
    expect(rig.host.getSnapshot()!.currentPlayerId).toBe(B.playerId);
  });
});

describe('baseline darts (§6.3: already on the board when the game starts)', () => {
  it('records them as baseline, never scores them, and starts the first turn once the board is clear', async () => {
    const rig = makeRig();
    const { board, cmd, host } = rig;
    const before = await rig.run(board.dart(S20), board.dart(T20));
    expect(before.map((r) => r.status)).toEqual(['not-recorded', 'not-recorded']);
    const [start] = await rig.run(cmd.start('test-sum', [A, B]));
    expect(types(start)).toEqual(['SessionStarted', 'DartDetected', 'DartDetected']);
    let s = host.getSnapshot()!;
    expect(s.phase).toBe('awaiting-clear-board');
    expect(s.baselineDarts).toBe(2);
    expect(s.currentTurn).toBeNull();
    const [extra, clear] = await rig.run(board.dart(S5), board.takeout());
    expect(types(extra)).toEqual(['DartDetected']);
    expect(types(clear)).toEqual(['TakeoutFinished', 'TurnStarted']);
    s = host.getSnapshot()!;
    expect(s.phase).toBe('playing');
    expect(s.baselineDarts).toBe(0);
    expect(s.view).toEqual({ scores: { [A.playerId]: 0, [B.playerId]: 0 } });
    await rig.run(board.dart(S1));
    expect(labels(rig, 0)).toEqual(['S1']);
  });

  it('forgets darts that were taken out before the game started', async () => {
    const rig = makeRig();
    await rig.run(rig.board.dart(S20), rig.board.takeout());
    const [start] = await rig.run(rig.cmd.start('test-sum', [A, B]));
    expect(types(start)).toEqual(['SessionStarted', 'TurnStarted']);
  });

  it('starts when the board withdraws every baseline dart, or on SkipTurn ("start anyway")', async () => {
    const rig = makeRig();
    const d = rig.board.dart(S20);
    await rig.run(d, rig.cmd.start('test-sum', [A, B]));
    const [w] = await rig.run(rig.board.withdraw(d.throwId));
    expect(types(w)).toEqual(['DartWithdrawn', 'TurnStarted']);

    const rig2 = makeRig();
    await rig2.run(rig2.board.dart(S20), rig2.cmd.start('test-sum', [A, B]));
    const [skip, dart] = await rig2.run(rig2.cmd.skip(), rig2.board.dart(S1));
    expect(types(skip)).toEqual(['TurnStarted']);
    expect(types(dart)).toEqual(['DartDetected', 'DartThrown']);
  });
});

describe('end of the game', () => {
  it('records GameFinished when the game says so and starts no further turn', async () => {
    const rig = await started('test-sum', [A], { rounds: 1 });
    const [, end, after] = await rig.run(rig.board.dart(T20), rig.board.takeout(), rig.board.dart(S20));
    expect(types(end)).toEqual(['TakeoutFinished', 'DartAdded', 'DartAdded', 'TurnEnded', 'GameFinished']);
    expect(find(end, 'GameFinished')[0]!.payload).toEqual({
      standings: [{ playerId: A.playerId, rank: 1, score: 60 }],
      provisional: true,
    });
    expect(types(after)).toEqual(['DartDetected']);
    const s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('finished');
    expect(s.finished).toEqual({ standings: [{ playerId: A.playerId, rank: 1, score: 60 }], provisional: true });
    expect(s.canComplete).toBe(true);
  });

  it('finishes on the winning dart, greys the rest of the visit, and ends the turn at takeout', async () => {
    const rig = await started('test-race', [A, B], { target: 60 });
    const { board } = rig;
    const [win, after, end] = await rig.run(board.dart(T20), board.dart(S5), board.takeout());
    expect(types(win)).toEqual(['DartDetected', 'DartThrown', 'GameFinished']);
    expect(types(after)).toEqual(['DartDetected', 'DartThrown']);
    expect(types(end)).toEqual(['TakeoutFinished', 'DartAdded', 'TurnEnded']);
    const s = rig.host.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => [d.segment.label, d.greyedBy])).toEqual([
      ['T20', null],
      ['S5', 'finished'],
      ['MISS', 'finished'],
    ]);
    expect(s.turns[0]!.closedBy).toBe('finished');
    expect(s.currentTurn).toBeNull();
  });

  it('withdraws the finish when a correction undoes it, resumes play, and records the finish again later', async () => {
    const rig = await started('test-race', [A, B], { target: 60 });
    const { board, cmd } = rig;
    const t20 = board.dart(T20);
    await rig.run(t20, board.dart(S5), board.takeout());
    const [undo] = await rig.run(cmd.correct(t20.throwId, S20));
    expect(types(undo)).toEqual(['DartCorrected', 'TurnStarted']);
    let s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('playing');
    expect(s.finished).toBeNull();
    expect(s.currentPlayerId).toBe(B.playerId);
    expect(s.turns[0]!.darts.map((d) => d.scored)).toEqual([true, true, true]);
    expect(s.view).toMatchObject({ scores: { [A.playerId]: 25, [B.playerId]: 0 } });
    const [redo] = await rig.run(cmd.correct(t20.throwId, T20));
    expect(types(redo)).toEqual(['DartCorrected', 'GameFinished']);
    s = rig.host.getSnapshot()!;
    expect(s.phase).toBe('finished');
    expect(s.turns[1]!.afterFinish).toBe(true);
  });

  it('records the new standings when a correction changes them after the finish', async () => {
    const rig = await started('test-sum', [A, B], { rounds: 1 });
    const { board, cmd } = rig;
    const b = board.dart(S5);
    await rig.run(board.dart(S20), board.takeout(), b, board.takeout());
    const [fix] = await rig.run(cmd.correct(b.throwId, T20));
    expect(types(fix)).toEqual(['DartCorrected', 'GameFinished']);
    expect(find(fix, 'GameFinished')[0]!.payload.standings[0]).toEqual({ playerId: B.playerId, rank: 1, score: 60 });
    const [same] = await rig.run(cmd.correct(b.throwId, makeSegment(15, 3)));
    expect(types(same)).toEqual(['DartCorrected', 'GameFinished']);
  });
});

describe('corrections', () => {
  it('inserts an added dart at its slot and moves later darts up', async () => {
    const rig = await started('test-sum', [A, B], {}, { missingDartsAreMisses: false, emptyTakeoutSkipsTurn: false });
    const { board, cmd } = rig;
    await rig.run(board.dart(S1), board.dart(S3));
    const [add] = await rig.run(cmd.add(A.playerId, 0, 1, S2));
    expect(types(add)).toEqual(['DartAdded']);
    expect(labels(rig, 0)).toEqual(['S1', 'S2', 'S3']);
    expect((rig.host.getSnapshot()!.gameState as { trail: string[] }).trail).toEqual(['0:0:S1', '0:1:S2', '0:2:S3']);
  });

  it('lets an added dart replace an automatic miss in a full visit', async () => {
    const rig = await started('test-sum');
    const { board, cmd } = rig;
    await rig.run(board.dart(S1), board.takeout());
    expect(labels(rig, 0)).toEqual(['S1', 'MISS', 'MISS']);
    const [add] = await rig.run(cmd.add(A.playerId, 0, 0, S20));
    expect(types(add)).toEqual(['DartVoided', 'DartAdded']);
    expect(labels(rig, 0)).toEqual(['S20', 'S1', 'MISS']);
    expect(rig.host.getSnapshot()!.turns[0]!.voidedDarts).toHaveLength(1);
  });

  it('relabels an automatic miss as a bounce-out with one AddDart', async () => {
    const rig = await started('test-sum');
    await rig.run(rig.board.dart(S1), rig.board.dart(S1), rig.board.takeout());
    await rig.run(rig.cmd.add(A.playerId, 0, 2, MISS, 'bounce-out'));
    expect(rig.host.getSnapshot()!.turns[0]!.darts.map((d) => d.origin)).toEqual(['detected', 'detected', 'bounce-out']);
  });

  it('refuses a fourth dart in a full visit with no automatic miss, and adds to unknown turns or players', async () => {
    const rig = await started('test-sum');
    const { board, cmd } = rig;
    await rig.run(board.dart(S1), board.dart(S2), board.dart(S3));
    const [full, unknown, wrong] = await rig.run(
      cmd.add(A.playerId, 0, 2, S20),
      cmd.add(A.playerId, 5, 0, S20),
      cmd.add(B.playerId, 0, 0, S20),
    );
    expect(full).toMatchObject({ status: 'rejected', reason: 'turn-full' });
    expect(unknown).toMatchObject({ status: 'rejected', reason: 'unknown-turn' });
    expect(wrong).toMatchObject({ status: 'rejected', reason: 'wrong-player' });
  });

  it('re-pads a visit when a dart is voided after an observed takeout, but not for an automatic miss', async () => {
    const rig = await started('test-sum');
    const { board, cmd } = rig;
    const mid = board.dart(S2);
    await rig.run(board.dart(S1), mid, board.dart(S3), board.takeout());
    const [v] = await rig.run(cmd.void(mid.throwId, 'false-detection'));
    expect(types(v)).toEqual(['DartVoided', 'DartAdded']);
    expect(labels(rig, 0)).toEqual(['S1', 'S3', 'MISS']);
    const pad = rig.host.getSnapshot()!.turns[0]!.darts[2]!;
    const [v2] = await rig.run(cmd.void(pad.throwId));
    expect(types(v2)).toEqual(['DartVoided']);
    expect(labels(rig, 0)).toEqual(['S1', 'S3']);
  });

  it('rejects corrections of unknown or voided darts, and treats a same-value correction as a no-op', async () => {
    const rig = await started('test-sum');
    const { board, cmd } = rig;
    const d = board.dart(S1);
    await rig.run(d, cmd.void(d.throwId));
    const [unknown, voided, again] = await rig.run(cmd.correct(board.dart(S1).throwId, S2), cmd.correct(d.throwId, S2), cmd.void(d.throwId));
    expect(unknown).toMatchObject({ status: 'rejected', reason: 'unknown-dart' });
    expect(voided).toMatchObject({ status: 'rejected', reason: 'dart-voided' });
    expect(again).toMatchObject({ status: 'rejected', reason: 'dart-voided' });
    const e = board.dart(D10);
    await rig.run(e);
    const [same] = await rig.run(cmd.correct(e.throwId, D10));
    expect(same).toEqual({ status: 'noop' });

  });
});
