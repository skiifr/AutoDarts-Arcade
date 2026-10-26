import { MISS, makeSegment, type PlayerRef } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { healthMetrics } from './metrics';
import { counterIds, makePlayers, makeRig } from './testing/harness';

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);
const [A, B] = makePlayers(2) as [PlayerRef, PlayerRef];

/** A session with one of everything the H1 review counts. */
async function eventfulSession() {
  const rig = makeRig();
  const { board, cmd, host } = rig;
  await rig.run(cmd.start('test-sum', [A, B], { rounds: 5 }));
  const pad = (turn: number, i: number) => host.getSnapshot()!.turns[turn]!.darts[i]!.throwId;

  // Turn 0 (A): S20, S5 then takeout → one automatic miss.
  const d2 = board.dart(S5);
  await rig.run(board.dart(S20), d2, board.takeout());
  await rig.run(cmd.correct(pad(0, 2), T20)); // the miss was a T20 the board missed: missed on-board
  await rig.run(cmd.correct(d2.throwId, S1)); // the board misread S1 as S5: misread

  // Turn 1 (B): one dart, two automatic misses; one was really a bounce-out (not a hardware miss).
  await rig.run(board.dart(S1), board.takeout());
  await rig.run(cmd.add(B.playerId, 1, 2, MISS, 'bounce-out'));

  // Turn 2 (A): a person adds a dart the board never saw; the board's only dart was a false detection.
  const d4 = board.dart(S5);
  await rig.run(cmd.add(A.playerId, 2, 0, S20, 'undetected'), d4, cmd.void(d4.throwId, 'false-detection'), board.takeout());

  // Turn 3 (B): two drop-outs (three offline reports), one recovered dart → needsReview.
  await rig.run(
    board.connection('offline'),
    board.connection('online'),
    board.connection('offline'),
    board.connection('offline'),
    board.connection('resyncing'),
    board.dart(S20, { recovered: true }),
    board.connection('online'),
    board.takeout(),
  );

  // Turn 4 (A): the board gets stuck twice; an inferred takeout → needsReview.
  await rig.run(
    board.status('stuck-takeout'),
    board.status('stuck-takeout'),
    board.status('ready'),
    board.status('stuck-takeout'),
    board.dart(S1),
    board.takeout({ inferred: true }),
    cmd.confirm(4),
  );

  // Turn 5 (B): manual mode, which says nothing about the board. It follows a review pause, so
  // whether B was really up is a guess: needsReview.
  await rig.run(cmd.add(B.playerId, 5, 0, S20, 'manual-mode'), cmd.add(B.playerId, 5, 1, S20, 'manual-mode'), cmd.skip());
  return rig;
}

describe('healthMetrics (ROADMAP H1)', () => {
  it('derives the H1 detection-quality signals from the log', async () => {
    const rig = await eventfulSession();
    const m = healthMetrics(rig.host.getLog());
    expect(m).toEqual({
      sessions: 1,
      // 3 + 3 + 3 + 3 + 1 live darts in turns 0–4; the manual-mode turn is left out.
      darts: 13,
      detectedDarts: 6,
      missedOnBoardDarts: 2,
      missedOnBoardRate: 2 / 13,
      misreadDarts: 1,
      misreadRate: 1 / 6,
      bounceOuts: 1,
      falseDetections: 1,
      needsReviewTurns: 3,
      reconnects: 2,
      disconnects: 2,
      stuckTakeouts: 2,
    });
  });

  it('adds up across several sessions', async () => {
    const one = (await eventfulSession()).host.getLog();
    const rig = makeRig({ ids: counterIds('0F') });
    await rig.run(rig.cmd.start('test-sum', [A]), rig.board.dart(S20), rig.board.dart(S20), rig.board.dart(S20), rig.board.takeout());
    const m = healthMetrics([...one, ...rig.host.getLog()]);
    expect(m.sessions).toBe(2);
    expect(m.darts).toBe(16);
    expect(m.detectedDarts).toBe(9);
    expect(m.missedOnBoardRate).toBe(2 / 16);
  });

  it('reports null rates when there is nothing to divide by', () => {
    const m = healthMetrics([]);
    expect(m.missedOnBoardRate).toBeNull();
    expect(m.misreadRate).toBeNull();
    expect(m.sessions).toBe(0);
  });

  it('does not count a board update or a person-corrected miss that stays a miss', async () => {
    const rig = makeRig();
    const { board, cmd, host } = rig;
    await rig.run(cmd.start('test-sum', [A]));
    const d = board.dart(S5);
    await rig.run(d, board.update(d.throwId, S5, S1), board.takeout());
    await rig.run(cmd.correct(host.getSnapshot()!.turns[0]!.darts[1]!.throwId, { ...MISS, missSector: 12 }));
    const m = healthMetrics(host.getLog());
    expect(m).toMatchObject({ darts: 3, detectedDarts: 1, missedOnBoardDarts: 0, misreadDarts: 0 });
  });
});
