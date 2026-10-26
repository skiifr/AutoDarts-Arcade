import { describe, expect, it } from 'vitest';
import {
  ArcadeCommandSchema,
  ArcadeEventSchema,
  BOARD_FACT_TYPES,
  DEFAULT_HOUSE_RULES,
  GAME_FACT_TYPES,
  arcadeEventJsonSchema,
  isBoardFact,
  makeSegment,
  parseArcadeEvent,
} from './index';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Deterministic, valid ULIDs for fixtures. */
function ulid(n: number): string {
  let out = '';
  let v = n;
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

const SESSION = ulid(1);
const PLAYER_A = ulid(2);
const PLAYER_B = ulid(3);
const THROW = ulid(4);

function envelope<T extends string>(seq: number, type: T, payload: unknown) {
  return {
    schema: 'arcade.event/v1',
    eventId: ulid(1000 + seq),
    sessionId: SESSION,
    seq,
    type,
    payload,
    source: { kind: 'autodarts-local', adapterVersion: 'autodarts-local@0.1.0', upstreamVersion: '2.0.2' },
    occurredAt: '2026-11-02T20:14:03.120Z',
    receivedAt: '2026-11-02T20:14:03.161Z',
  };
}

describe('ARCHITECTURE §7.6 example', () => {
  it('parses a detected S5 and its correction to S1', () => {
    const thrown = parseArcadeEvent(
      envelope(41, 'DartThrown', {
        throwId: THROW,
        playerId: PLAYER_A,
        turnIndex: 12,
        dartIndex: 1,
        origin: 'detected',
        segment: makeSegment(5, 1, 'single-outer'),
      }),
    );
    const corrected = parseArcadeEvent({
      ...envelope(44, 'DartCorrected', {
        throwId: THROW,
        reason: 'user',
        previous: makeSegment(5, 1, 'single-outer'),
        segment: makeSegment(1, 1, 'single-outer'),
      }),
      causationId: ulid(9),
      source: { kind: 'manual', adapterVersion: 'ui@0.1.0', actor: 'operator' },
    });

    expect(thrown.type).toBe('DartThrown');
    expect(corrected.type).toBe('DartCorrected');
    if (corrected.type === 'DartCorrected') {
      expect(corrected.payload.segment.label).toBe('S1');
    }
  });
});

describe('envelope rules', () => {
  const valid = envelope(1, 'TakeoutStarted', { visitKey: ulid(5) });

  it('accepts a valid board fact', () => {
    expect(ArcadeEventSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['unknown type', { ...valid, type: 'DartTeleported' }],
    ['wrong schema version', { ...valid, schema: 'arcade.event/v2' }],
    ['seq of zero', { ...valid, seq: 0 }],
    ['non-ULID event id', { ...valid, eventId: 'event-1' }],
    ['non-ISO timestamp', { ...valid, receivedAt: 'yesterday' }],
  ])('rejects %s', (_label, event) => {
    expect(ArcadeEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects a fourth dart index', () => {
    const e = envelope(2, 'DartDetected', {
      throwId: THROW,
      segment: makeSegment(20, 1),
      visitKey: ulid(5),
      indexInVisit: 3,
    });
    expect(ArcadeEventSchema.safeParse(e).success).toBe(false);
  });
});

describe('SessionStarted', () => {
  const players = [
    { playerId: PLAYER_A, displayName: 'Alex', colorIndex: 0, kind: 'profile' },
    { playerId: PLAYER_B, displayName: 'Guest 2', colorIndex: 1, kind: 'guest' },
  ];
  const payload = {
    gameId: 'countdown',
    gameVersion: '0.1.0',
    options: { start: 501 },
    players,
    turnOrder: [PLAYER_B, PLAYER_A],
    rngSeed: 'seed-1',
    houseRules: DEFAULT_HOUSE_RULES,
  };

  it('accepts a turn order that lists every player once', () => {
    expect(ArcadeEventSchema.safeParse(envelope(1, 'SessionStarted', payload)).success).toBe(true);
  });

  it('rejects a turn order that misses a player', () => {
    const bad = envelope(1, 'SessionStarted', { ...payload, turnOrder: [PLAYER_A] });
    expect(ArcadeEventSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate players', () => {
    const bad = envelope(1, 'SessionStarted', { ...payload, players: [players[0], players[0]] });
    expect(ArcadeEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe('layers', () => {
  it('splits every event type into exactly one layer', () => {
    const overlap = [...BOARD_FACT_TYPES].filter((t) => GAME_FACT_TYPES.has(t));
    expect(overlap).toEqual([]);
    expect(BOARD_FACT_TYPES.size + GAME_FACT_TYPES.size).toBe(21);
  });

  it('classifies events', () => {
    const e = parseArcadeEvent(envelope(1, 'TakeoutFinished', { visitKey: ulid(5), inferred: true }));
    expect(isBoardFact(e)).toBe(true);
  });
});

describe('commands', () => {
  it('parses a correction command', () => {
    const r = ArcadeCommandSchema.safeParse({
      schema: 'arcade.command/v1',
      commandId: ulid(9),
      type: 'CorrectDart',
      payload: { throwId: THROW, segment: makeSegment(1, 1, 'single-outer') },
      actor: 'operator',
      issuedAt: '2026-11-02T20:14:20.004Z',
    });
    expect(r.success).toBe(true);
  });
});

describe('JSON Schema', () => {
  it('generates a schema covering every event type', () => {
    const json = JSON.stringify(arcadeEventJsonSchema());
    for (const t of [...BOARD_FACT_TYPES, ...GAME_FACT_TYPES]) {
      expect(json).toContain(`"${t}"`);
    }
  });
});
