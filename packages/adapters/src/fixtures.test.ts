import type { BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { AutodartsLocalAdapter } from './autodarts-local/adapter';
import type { EventsSocketHandlers, Transport } from './ports';
import { createUlidSource, seededRandom } from './random';
import { SIM_EPOCH_MS, isoFromEpochMs } from './simulator/iso-time';
import { VirtualScheduler } from './simulator/virtual-scheduler';
import { BoardFactDraftSchemaCheck } from './testing/schema-check';

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
  }
}

/**
 * Golden replay of the community fixtures (fixtures/community/README.md): every frame of
 * a file goes through the full autodarts-local adapter, which first sees an empty board.
 * Ids and times are deterministic, so the normalized output is byte-identical run to run.
 */
const fixtures = import.meta.glob<string>('../../../fixtures/community/*.jsonl', { query: '?raw', import: 'default', eager: true });

const EMPTY_BOARD = '{"connected":true,"event":"Started","numThrows":0,"running":true,"status":"Throw"}';

/**
 * Plays the frames on the socket, 250 ms apart. `GET /api/state` answers with the board's
 * latest state, as a real board would: an empty board before the first frame, then the
 * data of the last state frame played.
 */
function replayTransport(frames: readonly string[], sched: VirtualScheduler): Transport {
  let state = EMPTY_BOARD;
  return {
    get: async (path) => ({ status: 200, body: path === '/api/version' ? '2.0.2' : state }),
    openEvents: (_opts, handlers: EventsSocketHandlers) => {
      sched.setTimeout(() => {
        handlers.onOpen();
        frames.forEach((f, i) =>
          sched.setTimeout(() => {
            try {
              const env = JSON.parse(f) as { type?: unknown; data?: unknown };
              if (env.type === 'state' && typeof env.data === 'object') state = JSON.stringify(env.data);
            } catch {
              // not JSON: the board state is unchanged
            }
            handlers.onMessage(f);
          }, 250 * (i + 1)),
        );
      }, 1);
      return { close: () => {} };
    },
  };
}

async function replay(text: string): Promise<BoardFactDraft[]> {
  const frames = text.split('\n').filter((l) => l.trim().length > 0);
  const sched = new VirtualScheduler();
  const adapter = new AutodartsLocalAdapter({
    transport: replayTransport(frames, sched),
    scheduler: sched,
    clock: () => isoFromEpochMs(SIM_EPOCH_MS + sched.now()),
    ids: createUlidSource({ now: () => SIM_EPOCH_MS + sched.now(), random: seededRandom('golden') }),
    random: seededRandom('golden-jitter'),
  });
  const facts: BoardFactDraft[] = [];
  const check = new BoardFactDraftSchemaCheck();
  adapter.subscribe((f) => {
    check.assert(f);
    facts.push(f);
  });
  adapter.start();
  await sched.advance(250 * frames.length + 1000);
  adapter.stop();
  return facts;
}

const darts = (facts: readonly BoardFactDraft[]): string[] =>
  facts.flatMap((f) => (f.type === 'DartDetected' ? [`${f.payload.indexInVisit}:${f.payload.segment.label}`] : []));

describe('community fixtures: golden normalized output', () => {
  it('finds the fixtures', () => {
    expect(Object.keys(fixtures).length).toBeGreaterThanOrEqual(5);
  });

  for (const [path, text] of Object.entries(fixtures)) {
    const name = path.split('/').pop()?.replace('.jsonl', '') as string;
    it(name, async () => {
      const facts = await replay(text);
      await expect(`${JSON.stringify(facts, null, 2)}\n`).toMatchFileSnapshot(`../../../fixtures/community/${name}.golden.json`);
    });
  }

  it('ARCHITECTURE §4.3: one visit, then an observed takeout', async () => {
    const facts = await replay(fixtures['../../../fixtures/community/architecture-4.3-visit.jsonl'] as string);
    expect(darts(facts)).toEqual(['0:T20', '1:S5', '2:D20']);
    expect(facts.filter((f) => f.type === 'TakeoutFinished').map((f) => f.payload)).toEqual([{ visitKey: expect.any(String) }]);
  });

  it('HomeDarts 2.0.2: inner bull, stuck takeout and manual reset', async () => {
    const facts = await replay(fixtures['../../../fixtures/community/homedarts-2.0.2-ws-frames.jsonl'] as string);
    expect(darts(facts)).toEqual(['0:T20', '1:S20', '2:BULL']);
    expect(facts.map((f) => f.type)).toContain('VisitReset');
    expect(facts.filter((f) => f.type === 'SourceAnomaly')).toEqual([]);
  });

  it('DartLab 2.0.2 shapes: misses as bed Outside keep their sector', async () => {
    const facts = await replay(fixtures['../../../fixtures/community/dartlab-2.0.2-shapes.jsonl'] as string);
    expect(darts(facts)).toEqual(['0:T20', '1:T20', '2:T5', '0:S12', '1:MISS', '2:S20']);
    const m = facts.find((f) => f.type === 'DartDetected' && f.payload.segment.label === 'MISS');
    expect(m?.type === 'DartDetected' && m.payload.segment.missSector).toBe(12);
  });

  it('misses and bulls: every documented spelling', async () => {
    const facts = await replay(fixtures['../../../fixtures/community/community-misses-and-bulls.jsonl'] as string);
    expect(darts(facts)).toEqual(['0:MISS', '1:BULL', '2:25', '0:BULL', '1:MISS', '2:S20']);
    expect(facts.filter((f) => f.type === 'SourceAnomaly')).toEqual([]);
  });

  it('anomalies: reported, never fatal', async () => {
    const facts = await replay(fixtures['../../../fixtures/community/community-anomalies.jsonl'] as string);
    expect(darts(facts)).toEqual(['0:MISS', '1:T19', '2:S3']);
    expect(facts.filter((f) => f.type === 'SourceAnomaly').map((f) => f.payload.note)).toEqual([
      'unknown segment name "X9"',
      expect.stringMatching(/unreadable segment/),
      'unknown bed "TripleOuter"',
      'bouncer: true observed',
      'unknown board status "Hibernating"',
      expect.stringMatching(/^invalid state/),
    ]);
    expect(facts.some((f) => f.type === 'DartUpdated' && f.payload.segment.label === 'D3')).toBe(true);
  });
});
