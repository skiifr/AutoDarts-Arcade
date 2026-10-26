import { describe, expect, it } from 'vitest';
import { d, manualReset, show, snap, takeoutFinished, takeoutStarted, throwing, tracker } from '../testing/snapshots';
import { rebuildVisitState } from './rebuild';
import { SAME_DART_TOLERANCE, type Snapshot } from './snapshot';
import { MIN_UNSEEN_VISIT_MS, type ApplyMode, type TrackerFact, type VisitTracker } from './visit-tracker';

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

function step(t: VisitTracker, s: Snapshot, mode: ApplyMode = 'live', awayMs?: number): string[] {
  return show(t.apply(s, mode, awayMs));
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

  it('withdrawn first dart: that dart is withdrawn, the other keeps its id, nothing re-detected', () => {
    const t = online();
    const [first, second] = t.apply(throwing(A, C), 'live');
    const facts = t.apply(throwing(C), 'live');
    expect(show(facts)).toEqual(['withdraw']);
    expect(facts[0]?.type === 'DartWithdrawn' && facts[0].payload.throwId).toBe(first?.type === 'DartDetected' && first.payload.throwId);
    expect(t.state().known.map((k) => [k.throwId, k.segment.label])).toEqual([[second?.type === 'DartDetected' && second.payload.throwId, 'T5']]);
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

  describe('a takeout called off with the same darts (finding 4)', () => {
    // A hand in front of the cameras starts a takeout; it leaves with the darts still in, and the
    // board returns to throwing. If the takeout stayed "on", a later withdrawal was swallowed as
    // a partial removal and the withdrawn phantom was scored.
    it.each([
      ['event "Throw detected"', snap('Throw', 'Throw detected', [A, C])],
      ['the event still "Takeout started": the status decides', snap('Throw', 'Takeout started', [A, C])],
    ])('%s: the takeout is off; a later withdrawal is a withdrawal', (_label, calledOff) => {
      const t = online();
      step(t, throwing(A));
      step(t, throwing(A, C));
      expect(step(t, takeoutStarted(A, C))).toEqual(['takeout-start']);
      expect(t.classifyFrame(calledOff)).toBe('confirm'); // a late frame must not call it off
      expect(step(t, calledOff)).toEqual([]);
      expect(t.state().inTakeout).toBe(false);
      expect(step(t, throwing(A))).toEqual(['withdraw']); // the board retracts the phantom
      expect(step(t, takeoutStarted(A))).toEqual(['takeout-start']);
      expect(step(t, takeoutFinished())).toEqual(['takeout-end']);
      expect(t.state().recentVisits[0]?.map((k) => k.segment.label)).toEqual(['T20']);
    });

    it('three darts: the board returns to "Takeout"', () => {
      const t = online();
      step(t, throwing(A, B, C));
      step(t, takeoutStarted(A, B, C));
      expect(step(t, snap('Takeout', 'Throw detected', [A, B, C]))).toEqual([]);
      expect(t.state().inTakeout).toBe(false);
      expect(step(t, throwing(A, B))).toEqual(['withdraw']);
    });

    it('called off with a dart gone: the board dropped it, so it is withdrawn, and the rest flagged', () => {
      const t = online();
      step(t, throwing(A, B, C));
      step(t, takeoutStarted(A, B, C));
      expect(step(t, throwing(A, B))).toEqual(['withdraw', 'update T20->T20 review', 'update T20->T20 review']);
      expect(t.state().inTakeout).toBe(false);
    });

    it('called off while we were away: the takeout is off after the resync', () => {
      const t = online();
      step(t, throwing(A, C));
      step(t, takeoutStarted(A, C));
      expect(step(t, throwing(A, C), 'resync', 3000)).toEqual([]);
      expect(t.state().inTakeout).toBe(false);
      expect(step(t, throwing(A))).toEqual(['withdraw']);
    });
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

  it('an unreadable dart is a miss pending review, with an anomaly attached', () => {
    const t = online();
    const s = snap('Throw', 'Throw detected');
    s.throws.push({ segment: { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' }, fatal: { note: 'x', rawExcerpt: '{}' }, notes: [] });
    const [fact] = t.apply(s, 'live');
    expect(show([fact!])).toEqual(['detect 0:MISS review anomaly']);
    expect(fact?.type === 'DartDetected' && fact.payload.pendingReview).toBe(true);
    // A readable dart carries no flag.
    const [next] = t.apply(throwing(A, A), 'live').filter((f) => f.type === 'DartDetected');
    expect(next?.type === 'DartDetected' && next.payload.pendingReview).toBeUndefined();
  });

  it('a dart re-read as unreadable is updated to a miss pending review', () => {
    const t = online();
    step(t, throwing(C));
    const s = snap('Throw', 'Throw detected');
    s.throws.push({ segment: { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' }, coords: C.coords, fatal: { note: 'x', rawExcerpt: '{}' }, notes: [] });
    const [fact] = t.apply(s, 'live');
    expect(show([fact!])).toEqual(['update T5->MISS review']);
    expect(fact?.type === 'DartUpdated' && fact.payload.pendingReview).toBe(true);
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

  it('empty with nothing known, after an outage of unknown length: a takeout may have happened, inferred', () => {
    const t = online();
    expect(step(t, takeoutFinished(), 'resync')).toEqual(['takeout-end inferred']);
  });

  it('different prefix: inferred takeout, then the new darts recovered', () => {
    const t = withKnown(A, B, C);
    expect(step(t, throwing(E, F), 'resync')).toEqual(['takeout-end inferred', 'detect 0:S12 recovered', 'detect 1:MISS recovered']);
  });

  it('nothing known and darts present, after an outage of unknown length: a whole visit may have passed, inferred', () => {
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
});

describe('Wi-Fi blips: a takeout is inferred only when the board was away long enough for one', () => {
  const S = MIN_UNSEEN_VISIT_MS;
  const nothingKnown = () => online();
  const nothingKnownInEmptyTakeout = () => {
    const t = online();
    step(t, takeoutStarted()); // a hand in front of the cameras, seen to start
    return t;
  };
  const known = () => {
    const t = online();
    step(t, throwing(A));
    return t;
  };

  it.each([
    // [situation, tracker, snapshot, away ms, facts]
    ['nothing known, empty board, blip', nothingKnown, takeoutFinished(), 2000, []],
    ['nothing known, empty board, just under the threshold', nothingKnown, takeoutFinished(), S - 1, []],
    ['nothing known, empty board, at the threshold', nothingKnown, takeoutFinished(), S, ['takeout-end inferred']],
    ['nothing known, empty board, long outage', nothingKnown, takeoutFinished(), 60_000, ['takeout-end inferred']],
    ['nothing known, empty board, unknown outage', nothingKnown, takeoutFinished(), undefined, ['takeout-end inferred']],
    ['nothing known, a dart thrown in a blip: same visit', nothingKnown, throwing(E), S - 1, ['detect 0:S12 recovered']],
    ['nothing known, a dart after a long outage', nothingKnown, throwing(E), S, ['takeout-end inferred', 'detect 0:S12 recovered']],
    ['empty takeout seen to start, over after a blip: nothing', nothingKnownInEmptyTakeout, takeoutFinished(), S - 1, []],
    ['empty takeout seen to start, a dart after a blip', nothingKnownInEmptyTakeout, throwing(E), S - 1, ['detect 0:S12 recovered']],
    ['empty takeout seen to start, over after a long outage', nothingKnownInEmptyTakeout, takeoutFinished(), S, ['takeout-end inferred']],
    ['known darts missing, the shortest blip', known, takeoutFinished(), 1, ['takeout-end inferred']],
    ['known darts missing, long outage', known, takeoutFinished(), 60_000, ['takeout-end inferred']],
    ['known darts replaced, blip', known, throwing(E), 1, ['takeout-end inferred', 'detect 0:S12 recovered']],
    ['known darts still there, more thrown, long outage', known, throwing(A, B), 60_000, ['detect 1:T20 recovered']],
  ] as const)('%s', (_label, make, snapshot, away, facts) => {
    const t = make();
    expect(step(t, snapshot, 'resync', away)).toEqual(facts);
  });

  it('a short outage leaves the visit as it was, so its later darts and takeout are plain live facts', () => {
    const t = online();
    expect(step(t, takeoutFinished(), 'resync', 1500)).toEqual([]);
    const key = t.state().visitKey;
    expect(step(t, throwing(A))).toEqual(['detect 0:T20']);
    expect(t.state().visitKey).toBe(key);
  });

  it('after a short outage an empty takeout seen to start is over if the board no longer shows it, still on if it does', () => {
    const over = nothingKnownInEmptyTakeout();
    step(over, takeoutFinished(), 'resync', 1000);
    expect(over.state().inTakeout).toBe(false);
    const still = nothingKnownInEmptyTakeout();
    expect(step(still, takeoutStarted(), 'resync', 1000)).toEqual([]);
    expect(still.state().inTakeout).toBe(true);
  });
});

describe("darts where the last visit's darts were: counted, flagged, never dropped (decision R)", () => {
  // Chaos seed 7489: two different S4 darts in consecutive visits, 0.0020 apart (≈ 0.34 mm).
  const P = d('S4', 0.7111183707578469, 0.4444793126583797);
  const Q = d('S4', 0.7117440837186804, 0.44260195786078516);
  const T3 = d('T3', -0.0826, -0.5946);
  const A20 = d('S20', 0.031, 0.63); // A re-read across the wire
  const nearA = d('T20', 0.0303 + SAME_DART_TOLERANCE * 0.9, 0.6166);
  const pastA = d('T20', 0.0303 + SAME_DART_TOLERANCE * 1.1, 0.6166);
  const S = MIN_UNSEEN_VISIT_MS;

  /** An online tracker whose last visit, `prev`, was seen taken out. */
  function after(...prev: Parameters<typeof throwing>): VisitTracker {
    const t = online();
    step(t, throwing(...prev));
    step(t, takeoutStarted(...prev));
    step(t, takeoutFinished());
    return t;
  }

  it.each([
    // [situation, previous visit, snapshot, mode, away ms, facts]
    ['a new dart 0.34 mm from the last first dart (seed 7489)', [P, T3], throwing(Q), 'live', undefined, ['anomaly', 'detect 0:S4 review']],
    ['within the tolerance', [A, B], throwing(nearA), 'live', undefined, ['anomaly', 'detect 0:T20 review']],
    ['just past the tolerance: a plain new dart', [A, B], throwing(pastA), 'live', undefined, ['detect 0:T20']],
    ['the same place, another segment: a plain new dart', [A, B], throwing(A20), 'live', undefined, ['detect 0:S20']],
    ['the whole last visit back', [A, B], throwing(A, B), 'live', undefined, ['anomaly', 'detect 0:T20 review', 'detect 1:T20 review']],
    ['the last visit back and a new dart: only the matches flagged', [A, B], throwing(A, B, C), 'live', undefined, ['anomaly', 'detect 0:T20 review', 'detect 1:T20 review', 'detect 2:T5']],
    ['only a later dart matches: not the last visit', [A, B], throwing(E, B), 'live', undefined, ['detect 0:S12', 'detect 1:T20']],
    ['no coordinates: never taken for the last visit', [d('T20'), d('S5')], throwing(d('T20')), 'live', undefined, ['detect 0:T20']],
    ['resync after a blip', [A, B], throwing(A, B, C), 'resync', S - 1, ['anomaly', 'detect 0:T20 recovered review', 'detect 1:T20 recovered review', 'detect 2:T5 recovered']],
    ['resync after a long outage: the matches prove nothing, a takeout is inferred', [A, B], throwing(A, B, C), 'resync', 60_000, ['takeout-end inferred', 'anomaly', 'detect 0:T20 recovered review', 'detect 1:T20 recovered review', 'detect 2:T5 recovered']],
    ['resync after an outage of unknown length', [P, T3], throwing(Q), 'resync', undefined, ['takeout-end inferred', 'anomaly', 'detect 0:S4 recovered review']],
  ] as const)('%s', (_label, prev, snapshot, mode, away, facts) => {
    const t = after(...prev);
    expect(step(t, snapshot, mode, away)).toEqual(facts);
  });

  it('the anomaly names the darts it matched', () => {
    const t = after(P, T3);
    const [anomaly] = t.apply(throwing(Q), 'live');
    expect(anomaly?.type === 'SourceAnomaly' && anomaly.payload).toEqual({
      note: expect.stringMatching(/1 dart\(s\) where the previous visit's darts were: counted pending review/),
      rawExcerpt: 'S4',
    });
  });

  it('a suspected ghost stays pending review when the board re-reads it; an ordinary dart does not', () => {
    const t = after(A, B);
    step(t, throwing(A, B));
    expect(step(t, throwing(A20, B))).toEqual(['update T20->S20 review']);
    const u = online();
    step(u, throwing(A, B));
    expect(step(u, throwing(A20, B))).toEqual(['update T20->S20']);
  });

  it('the suspicion survives a crash: rebuildVisitState restores it from the log', () => {
    const t = online();
    const facts: TrackerFact[] = [];
    for (const s of [throwing(A, B), takeoutStarted(A, B), takeoutFinished(), throwing(A, B, C)]) facts.push(...t.apply(s, 'live'));
    const restored = rebuildVisitState(facts, () => '01JBX00000000000000000000V');
    expect(restored.known.map((k) => k.suspectedGhost ?? false)).toEqual([true, true, false]);
    expect(restored.known).toEqual(t.state().known);
    const resumed = tracker(restored);
    expect(step(resumed, throwing(A20, B, C))).toEqual(['update T20->S20 review']);
  });

  it('an adopted ghost is in the log, so a crash puts every later dart back in its place (finding 5)', () => {
    // Before ghosts were emitted, the log lacked the ghost's DartDetected and the rebuilt
    // visit had the later darts at the wrong positions.
    const t = online();
    const facts: TrackerFact[] = [];
    for (const s of [throwing(A, B), takeoutStarted(A, B), takeoutFinished(), throwing(A), throwing(A, C)]) facts.push(...t.apply(s, 'live'));
    const restored = rebuildVisitState(facts, () => '01JBX00000000000000000000V');
    expect(restored.known.map((k) => [k.indexInVisit, k.segment.label, k.suspectedGhost ?? false])).toEqual([
      [0, 'T20', true],
      [1, 'T5', false],
    ]);
    expect(restored.known).toEqual(t.state().known);
    expect(restored.visitKey).toBe(t.state().visitKey);
    const resumed = tracker(restored);
    for (const s of [throwing(A, C, E), throwing(C, E), throwing(C2, E), takeoutStarted(C2, E), takeoutFinished()]) {
      expect(step(resumed, s)).toEqual(step(t, s));
    }
  });
});

describe('crash-resume edges the log cannot show exactly: never fewer flags', () => {
  const ids = (): string => '01JBX00000000000000000000V';

  it('the last dart out before "Takeout finished": the resumed tracker knows the takeout still showing is not a new one', () => {
    const t = online();
    const log: { type: string; payload: unknown }[] = [];
    // As the adapter logs it: each snapshot's facts, then the board status when it changes.
    const status = (s: string) => ({ type: 'BoardStatusChanged', payload: { status: s } });
    log.push(...t.apply(throwing(A), 'live'), status('throwing'));
    log.push(...t.apply(takeoutStarted(A), 'live'), status('takeout'));
    log.push(...t.apply(takeoutStarted(), 'live')); // still "takeout": nothing new logged
    const restored = rebuildVisitState(log, ids);
    expect(restored.takeoutTail).toBe(true);
    expect(step(tracker(restored), takeoutStarted(), 'resync', 1000)).toEqual([]);
    // After a normal end, the board's status change says the takeout is over.
    log.push({ type: 'BoardStatusChanged', payload: { status: 'ready' } });
    expect(rebuildVisitState(log, ids).takeoutTail).toBeUndefined();
  });

  it('a takeout called off with 3 darts logs nothing: the resumed tracker ends it on the next snapshot, flagging if darts went missing', () => {
    const t = online();
    const log: TrackerFact[] = [];
    for (const s of [throwing(A, B, C), takeoutStarted(A, B, C), snap('Takeout', 'Throw detected', [A, B, C])]) log.push(...t.apply(s, 'live'));
    const restored = rebuildVisitState(log, ids);
    expect([t.state().inTakeout, restored.inTakeout]).toEqual([false, true]);
    expect(step(t, throwing(A, B), 'resync', 1000)).toEqual(['withdraw']);
    expect(step(tracker(restored), throwing(A, B), 'resync', 1000)).toEqual(['withdraw', 'update T20->T20 review', 'update T20->T20 review']);
    expect(step(tracker(restored), snap('Takeout', 'Throw detected', [A, B, C]), 'resync', 1000)).toEqual([]);
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

describe('a takeout first seen with darts already pulled: they were removed, not withdrawn (finding 1)', () => {
  // T20 T19 T18; Wi-Fi drops; the takeout starts and one dart is pulled; the link returns while
  // the takeout is still in progress. The pulled dart was thrown; the board may also have
  // withdrawn it before the takeout began. It is kept and flagged, never withdrawn silently.
  const X = d('T20', 0.0303, 0.6166);
  const Y = d('T19', -0.1886, -0.5806);
  const Z = d('T18', 0.3521, 0.4855);

  it.each([
    ['resync, middle dart pulled', 'resync', [X, Z], ['update T19->T19 review', 'takeout-start']],
    ['resync, first dart pulled', 'resync', [Y, Z], ['update T20->T20 review', 'takeout-start']],
    ['resync, two darts pulled', 'resync', [Z], ['update T20->T20 review', 'update T19->T19 review', 'takeout-start']],
    ['resync, none pulled yet', 'resync', [X, Y, Z], ['takeout-start']],
    ['live (the takeout frame was lost), middle dart pulled', 'live', [X, Z], ['update T19->T19 review', 'takeout-start']],
    ['live, first dart pulled', 'live', [Y, Z], ['update T20->T20 review', 'takeout-start']],
  ] as const)('%s', (_label, mode, listed, facts) => {
    const t = online();
    step(t, throwing(X, Y, Z));
    expect(step(t, takeoutStarted(...listed), mode, 3000)).toEqual(facts);
    expect(t.state().known.map((k) => k.segment.label)).toEqual(['T20', 'T19', 'T18']);
    // The last dart out ends the visit; the board's own "Takeout finished" adds nothing, and the
    // takeout still showing on the empty board is not a new (empty) takeout.
    expect(step(t, takeoutStarted())).toEqual(['takeout-end']);
    expect(step(t, takeoutFinished())).toEqual([]);
    expect(t.state().recentVisits[0]?.map((k) => k.segment.label)).toEqual(['T20', 'T19', 'T18']);
  });

  it('a flagged dart stays flagged: rebuildVisitState restores the doubt', () => {
    const t = online();
    const facts: TrackerFact[] = [];
    facts.push(...t.apply(throwing(X, Y, Z), 'live'));
    facts.push(...t.apply(takeoutStarted(X, Z), 'resync', 3000));
    const restored = rebuildVisitState(facts, () => '01JBX00000000000000000000V');
    expect(restored.known).toEqual(t.state().known);
    expect(restored.inTakeout).toBe(true);
  });

  it('a dart the takeout first seen does not know: a dart thrown offline, recovered', () => {
    const t = online();
    step(t, throwing(X, Y));
    expect(step(t, takeoutStarted(X, Y, Z), 'resync', 3000)).toEqual(['detect 2:T18 recovered', 'takeout-start']);
  });

  it('other darts in a takeout first seen: a visit ended offline, inferred', () => {
    const t = online();
    step(t, throwing(X, Y));
    expect(step(t, takeoutStarted(E), 'resync', 3000)).toEqual(['takeout-end inferred', 'detect 0:S12 recovered', 'takeout-start']);
  });
});

describe('each dart keeps its id when the board withdraws another (finding 2)', () => {
  // Identity by position re-mapped every later dart after a withdrawal, so the board's changes
  // landed on the wrong physical dart: the host voided the real T20 when the board withdrew a
  // phantom the player had already voided, and a dart took its neighbour's reading.
  const P = d('S20', 0.0452, 0.8317); // a phantom
  const R = d('T20', 0.0303, 0.6166); // the real dart
  const S1 = d('S1', 0.2391, 0.7313);
  const S5 = d('S5', -0.2402, 0.7395);

  /** Facts of one snapshot, each dart named by the order it was first detected in (#1, #2, …). */
  function named(t: VisitTracker, names: Map<string, string>, s: Snapshot, mode: ApplyMode = 'live', away?: number): string[] {
    const review = (p: { pendingReview?: true }): string => (p.pendingReview ? ' review' : '');
    return t.apply(s, mode, away).map((f) => {
      switch (f.type) {
        case 'DartDetected':
          names.set(f.payload.throwId, `#${names.size + 1}`);
          return `detect ${names.get(f.payload.throwId)} ${f.payload.segment.label}${f.payload.recovered ? ' recovered' : ''}${review(f.payload)}`;
        case 'DartUpdated':
          return `update ${names.get(f.payload.throwId)} ${f.payload.previous.label}->${f.payload.segment.label}${review(f.payload)}`;
        case 'DartWithdrawn':
          return `withdraw ${names.get(f.payload.throwId)}`;
        default:
          return show([f])[0] as string;
      }
    });
  }

  function play(...snaps: Snapshot[]): { t: VisitTracker; names: Map<string, string>; last: string[] } {
    const t = online();
    const names = new Map<string, string>();
    let last: string[] = [];
    for (const s of snaps) last = named(t, names, s);
    return { t, names, last };
  }

  it('phantom, then a real dart; the board withdraws the phantom: the phantom is withdrawn', () => {
    const { t, names, last } = play(throwing(P), throwing(P, R), throwing(R));
    expect(last).toEqual(['withdraw #1']);
    expect(t.state().known.map((k) => `${names.get(k.throwId)} ${k.segment.label}`)).toEqual(['#2 T20']);
  });

  it('S1, S5; the board withdraws S1: S5 keeps its id and its reading', () => {
    const { t, names, last } = play(throwing(S1), throwing(S1, S5), throwing(S5));
    expect(last).toEqual(['withdraw #1']);
    // The next dart takes the free index; nothing else moves.
    expect(named(t, names, throwing(S5, E))).toEqual(['detect #3 S12']);
    expect(t.state().known.map((k) => `${names.get(k.throwId)}@${k.indexInVisit}`)).toEqual(['#2@1', '#3@0']);
  });

  it('a withdrawal and a re-read in one snapshot each hit their own dart', () => {
    const { last } = play(throwing(A, B, C), throwing(B, C2));
    expect(last).toEqual(['withdraw #1', 'update #3 T5->S5']);
  });

  it('a non-last dart withdrawn while we were away: withdrawn after the resync', () => {
    const t = online();
    const names = new Map<string, string>();
    named(t, names, throwing(A, B, C));
    expect(named(t, names, throwing(B, C), 'resync', 3000)).toEqual(['withdraw #1']);
  });

  it('rebuildVisitState keeps each dart where it is', () => {
    const t = online();
    const facts: TrackerFact[] = [];
    for (const s of [throwing(S1), throwing(S1, S5), throwing(S5), throwing(S5, E)]) facts.push(...t.apply(s, 'live'));
    const restored = rebuildVisitState(facts, () => '01JBX00000000000000000000V');
    expect(restored.known).toEqual(t.state().known);
    const resumed = tracker(restored);
    expect(show(resumed.apply(throwing(E), 'live'))).toEqual(show(t.apply(throwing(E), 'live')));
  });

  describe('without coordinates the board’s choice cannot be checked: the darts left are flagged', () => {
    const s1 = d('S1');
    const s5 = d('S5');
    const s3 = d('S3');
    const s20 = d('S20');
    it.each([
      ['the first of two withdrawn', [s1, s5], [s5], ['withdraw #1', 'update #2 S5->S5 review']],
      ['one of two alike withdrawn', [s5, s5], [s5], ['withdraw #2', 'update #1 S5->S5 review']],
      ['the last withdrawn: plain', [s1, s5], [s1], ['withdraw #2']],
      ['a removal and a re-read at once', [s1, s5, s3], [s1, s20], ['withdraw #3', 'update #1 S1->S1 review', 'update #2 S5->S20 review']],
      ['two re-reads at once', [s1, s5], [s20, s3], ['update #1 S1->S20 review', 'update #2 S5->S3 review']],
      ['one re-read: plain', [s1, s5], [s1, s20], ['update #2 S5->S20']],
    ] as const)('%s', (_label, before, after, facts) => {
      const { last } = play(throwing(...before), throwing(...after));
      expect(last).toEqual(facts);
    });

    it('a dart flagged so stays flagged', () => {
      const { t, names } = play(throwing(s5, s5), throwing(s5));
      expect(named(t, names, throwing(s20))).toEqual(['update #1 S5->S20 review']);
      expect(named(t, names, throwing(s20))).toEqual([]);
    });
  });
});
