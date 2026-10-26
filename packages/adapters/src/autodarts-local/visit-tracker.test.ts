import { describe, expect, it } from 'vitest';
import { d, manualReset, show, snap, takeoutFinished, takeoutStarted, throwing, tracker } from '../testing/snapshots';
import type { Snapshot } from './snapshot';
import type { ApplyMode, VisitTracker } from './visit-tracker';

const A = d('T20', 0.0303, 0.6166);
const B = d('T20', 0.0002, 0.6127);
const C = d('T5', -0.1236, 0.6093);
const C2 = d('S5', -0.1301, 0.6301); // C re-read across the wire: within 5 mm
const E = d('S12', -0.5368, 0.6165); // a dart of a later visit
const F = d('M12', -0.8196, 0.9863);

/** An online tracker with an empty visit. */
function online(): VisitTracker {
  const t = tracker();
  t.apply(snap('Throw', 'Started'), 'resync');
  return t;
}

function step(t: VisitTracker, s: Snapshot, mode: ApplyMode = 'live'): string[] {
  return show(t.apply(s, mode));
}

describe('§6.2 snapshot diff (live)', () => {
  it('new darts: DartDetected with indexInVisit = position', () => {
    const t = online();
    expect(step(t, throwing(A))).toEqual(['detect 0:T20']);
    expect(step(t, throwing(A, B, C))).toEqual(['detect 1:T20', 'detect 2:T5']);
  });

  it('idempotency: a re-delivered snapshot adds nothing', () => {
    const t = online();
    step(t, throwing(A, B));
    expect(step(t, throwing(A, B))).toEqual([]);
    expect(step(t, throwing(A))).not.toContain('detect 0:T20');
  });

  it('segment differs at a known position: DartUpdated', () => {
    const t = online();
    step(t, throwing(A, B, C));
    expect(step(t, throwing(A, B, C2))).toEqual(['update T5->S5']);
  });

  it('position gone outside a takeout: DartWithdrawn (the board retracted it)', () => {
    const t = online();
    step(t, throwing(A, B, C));
    expect(step(t, throwing(A, B))).toEqual(['withdraw']);
    expect(t.state().known.map((k) => k.segment.label)).toEqual(['T20', 'T20']);
  });

  it('withdrawn first dart: positions shift, logged as updates, nothing re-detected', () => {
    const t = online();
    step(t, throwing(A, C));
    expect(step(t, throwing(C))).toEqual(['update T20->T5', 'withdraw']);
  });

  it('takeout begins on event "Takeout started": TakeoutStarted', () => {
    const t = online();
    step(t, throwing(A, B, C));
    expect(step(t, takeoutStarted(A, B, C))).toEqual(['takeout-start']);
    expect(t.state().inTakeout).toBe(true);
  });

  it('takeout begins on status "Takeout in progress" alone', () => {
    const t = online();
    step(t, throwing(A));
    expect(step(t, snap('Takeout in progress', 'Throw detected', [A]))).toEqual(['takeout-start']);
  });

  it('positions gone during a takeout: no withdrawal (darts come off in any order)', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    expect(step(t, snap('Takeout in progress', 'Takeout started', [B, C]))).toEqual([]);
    expect(t.state().known).toHaveLength(3);
  });

  it('event "Takeout finished": TakeoutFinished, known = [], new visitKey', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    const before = t.state().visitKey;
    expect(step(t, takeoutFinished())).toEqual(['takeout-end']);
    expect(t.state().known).toEqual([]);
    expect(t.state().visitKey).not.toBe(before);
  });

  it('inTakeout and throws empty: TakeoutFinished even without the event', () => {
    const t = online();
    step(t, takeoutStarted(A));
    expect(step(t, snap('Throw', 'Throw detected'))).toEqual(['takeout-end']);
  });

  it('a missing throws key is an empty board', () => {
    const t = online();
    step(t, takeoutStarted(A));
    const s = snap('Throw', 'Takeout finished');
    expect(s.raw.throws).toBeUndefined();
    expect(step(t, s)).toEqual(['takeout-end']);
  });

  it('"Manual reset": VisitReset, every known dart withdrawn, new visitKey', () => {
    const t = online();
    step(t, throwing(A, B));
    const before = t.state().visitKey;
    expect(step(t, manualReset())).toEqual(['reset', 'withdraw', 'withdraw']);
    expect(t.state().visitKey).not.toBe(before);
    expect(step(t, manualReset())).toEqual([]); // idempotent
  });

  it('normalization runs first: M and M12 misses compare equal', () => {
    const t = online();
    step(t, throwing(d('M12', 0.9, 0.5)));
    expect(step(t, throwing(d('M', 0.9, 0.5, true)))).toEqual([]);
  });

  it('a takeout we never saw start ends inferred (darts may be missing)', () => {
    const t = online();
    step(t, throwing(A));
    expect(step(t, takeoutFinished())).toEqual(['takeout-end inferred']);
  });

  it('an empty takeout we never saw start ends inferred; its repeat does nothing', () => {
    const t = online();
    expect(step(t, takeoutFinished())).toEqual(['takeout-end inferred']);
    expect(step(t, takeoutFinished())).toEqual([]);
  });

  it('a takeout first seen with the darts already gone ends inferred', () => {
    const t = online();
    step(t, throwing(A));
    expect(step(t, takeoutStarted())).toEqual(['takeout-start']);
    expect(step(t, takeoutFinished())).toEqual(['takeout-end inferred']);
  });

  it('a different first dart (a takeout lost between frames): inferred, darts recovered', () => {
    const t = online();
    step(t, throwing(A, B, C));
    expect(step(t, throwing(E))).toEqual(['takeout-end inferred', 'detect 0:S12 recovered']);
  });

  it('new darts while we thought a takeout was running: inferred, darts recovered', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    expect(step(t, throwing(E))).toEqual(['takeout-end inferred', 'detect 0:S12 recovered']);
  });

  it('a board restart that drops the list: inferred', () => {
    const t = online();
    step(t, throwing(A));
    expect(step(t, snap('Throw', 'Started'))).toEqual(['takeout-end inferred']);
  });

  it('the board retracts its only dart: withdrawn', () => {
    const t = online();
    step(t, throwing(A));
    expect(step(t, snap('Throw', 'Throw detected'))).toEqual(['withdraw']);
  });

  it('empty takeout (hand in front of the cameras)', () => {
    const t = online();
    expect(step(t, takeoutStarted())).toEqual(['takeout-start']);
    expect(step(t, takeoutFinished())).toEqual(['takeout-end']);
  });

  it('stuck takeout then manual reset (HomeDarts 2.0.2 recording)', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    step(t, takeoutFinished());
    expect(step(t, takeoutStarted())).toEqual(['takeout-start']);
    expect(step(t, manualReset())).toEqual(['reset']);
  });

  it('a called-off takeout: more darts arrive, takeout cleared', () => {
    const t = online();
    step(t, takeoutStarted(A));
    expect(step(t, throwing(A, B))).toEqual(['detect 1:T20']);
    expect(t.state().inTakeout).toBe(false);
  });

  it('darts without coordinates follow the index rule', () => {
    const t = online();
    step(t, throwing(d('T20'), d('S5')));
    expect(step(t, throwing(d('T20'), d('S1')))).toEqual(['update S5->S1']);
  });

  it('a fourth dart is ignored (indexInVisit stays 0..2)', () => {
    const t = online();
    const s = snap('Takeout', 'Throw detected', [A, B, C, E]);
    expect(s.notes[0]).toMatch(/4 darts/);
    expect(step(t, s)).toEqual(['detect 0:T20', 'detect 1:T20', 'detect 2:T5']);
  });

  it('an unreadable dart is a miss with an anomaly attached', () => {
    const t = online();
    const s = snap('Throw', 'Throw detected');
    s.throws.push({ segment: { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' }, fatal: { note: 'x', rawExcerpt: '{}' }, notes: [] });
    expect(step(t, s)).toEqual(['detect 0:MISS anomaly']);
  });
});

describe('§6.4 resync and decision R', () => {
  function withKnown(...darts: Parameters<typeof throwing>): VisitTracker {
    const t = online();
    step(t, throwing(...darts));
    return t;
  }

  it('first contact: darts already on the board are a recovered baseline, no takeout', () => {
    const t = tracker();
    expect(step(t, throwing(A, B), 'resync')).toEqual(['detect 0:T20 recovered', 'detect 1:T20 recovered']);
  });

  it('same prefix, more darts: only the new darts, flagged recovered', () => {
    const t = withKnown(A);
    expect(step(t, throwing(A, B, C), 'resync')).toEqual(['detect 1:T20 recovered', 'detect 2:T5 recovered']);
  });

  it('same darts: nothing', () => {
    const t = withKnown(A, B);
    expect(step(t, throwing(A, B), 'resync')).toEqual([]);
  });

  it('empty: a takeout happened offline, TakeoutFinished{inferred}', () => {
    const t = withKnown(A, B);
    expect(step(t, takeoutFinished(), 'resync')).toEqual(['takeout-end inferred']);
  });

  it('empty with nothing known: a takeout may still have happened, inferred', () => {
    const t = online();
    expect(step(t, takeoutFinished(), 'resync')).toEqual(['takeout-end inferred']);
  });

  it('different prefix: inferred takeout, then the new darts recovered', () => {
    const t = withKnown(A, B, C);
    expect(step(t, throwing(E, F), 'resync')).toEqual(['takeout-end inferred', 'detect 0:S12 recovered', 'detect 1:MISS recovered']);
  });

  it('nothing known and darts present: a whole visit may have passed, inferred', () => {
    const t = online();
    expect(step(t, throwing(E), 'resync')).toEqual(['takeout-end inferred', 'detect 0:S12 recovered']);
  });

  it('first dart still there but a later one re-read offline: same visit, update', () => {
    const t = withKnown(A, B, C);
    expect(step(t, throwing(A, B, C2), 'resync')).toEqual(['update T5->S5']);
  });

  it('first dart re-read offline: prefix differs, inferred (flagged, never guessed)', () => {
    const t = withKnown(C);
    expect(step(t, throwing(C2), 'resync')).toEqual(['takeout-end inferred', 'detect 0:S5 recovered']);
  });

  it('without coordinates the literal prefix rule applies', () => {
    const t = withKnown(d('T20'), d('S5'));
    expect(step(t, throwing(d('T20'), d('S5'), d('D1')), 'resync')).toEqual(['detect 2:D1 recovered']);
    const u = withKnown(d('T20'), d('S5'));
    expect(step(u, throwing(d('T20'), d('S1')), 'resync')).toEqual(['takeout-end inferred', 'detect 0:T20 recovered', 'detect 1:S1 recovered']);
  });

  it('mid-takeout when the connection dropped, still taking out: nothing', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    expect(step(t, snap('Takeout in progress', 'Takeout started', [C]), 'resync')).toEqual([]);
  });

  it('a stuck takeout found on resync is reported as a takeout of the new visit', () => {
    const t = withKnown(A);
    expect(step(t, takeoutStarted(), 'resync')).toEqual(['takeout-end inferred', 'takeout-start']);
  });

  it('the last visit reappears (its takeout was called off): adopted, not counted again', () => {
    const t = online();
    step(t, takeoutStarted(A, B));
    step(t, takeoutFinished());
    expect(step(t, throwing(A, B, C), 'resync')).toEqual(['anomaly', 'detect 2:T5 recovered']);
  });
});

describe('frame classification (late or duplicated frames never retract darts)', () => {
  it.each([
    ['progress', [A], throwing(A, B), 'apply'],
    ['repeat', [A, B], throwing(A, B), 'apply'],
    ['fewer darts', [A, B], throwing(A), 'confirm'],
    ['changed dart', [A, B, C], throwing(A, B, C2), 'confirm'],
    ['different first dart', [A], throwing(E), 'confirm'],
    ['empty without takeout', [A], snap('Throw', 'Throw detected'), 'confirm'],
    ['reset', [A], manualReset(), 'confirm'],
  ] as const)('%s → %s', (_l, known, frame, expected) => {
    const t = online();
    step(t, throwing(...known));
    expect(t.classifyFrame(frame)).toBe(expected);
  });

  it('a late frame of the visit just taken out needs confirmation', () => {
    const t = online();
    step(t, takeoutStarted(A, B, C));
    step(t, takeoutFinished());
    expect(t.classifyFrame(throwing(A, B))).toBe('confirm');
  });

  it('the takeout finishing is plain progress', () => {
    const t = online();
    step(t, takeoutStarted(A));
    expect(t.classifyFrame(takeoutFinished())).toBe('apply');
  });
});
