import { describe, expect, it } from 'vitest';
import {
  ArcadeCommandSchema,
  ArcadeEventSchema,
  DEFAULT_HOUSE_RULES,
  GAME_FACT_TYPES,
  PAUSE_REASONS,
  isBoardFact,
  makeSegment,
  parseArcadeEvent,
} from './index';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(n: number): string {
  let out = '';
  let v = n;
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

const PLAYER = ulid(2);

function envelope(seq: number, type: string, payload: unknown) {
  return {
    schema: 'arcade.event/v1',
    eventId: ulid(1000 + seq),
    sessionId: ulid(1),
    seq,
    type,
    payload,
    source: { kind: 'manual', adapterVersion: 'ui@0.1.0', actor: 'operator' },
    occurredAt: '2026-11-02T20:14:03.120Z',
    receivedAt: '2026-11-02T20:14:03.161Z',
    causationId: ulid(9),
  };
}

function command(type: string, payload: unknown) {
  return {
    schema: 'arcade.command/v1',
    commandId: ulid(9),
    type,
    payload,
    actor: 'operator',
    issuedAt: '2026-11-02T20:14:20.004Z',
  };
}

describe('owner decision R: review schema', () => {
  it("adds 'review' to the pause reasons of GamePaused and GameResumed", () => {
    expect(PAUSE_REASONS).toContain('review');
    for (const type of ['GamePaused', 'GameResumed']) {
      expect(ArcadeEventSchema.safeParse(envelope(5, type, { reason: 'review' })).success).toBe(true);
    }
    expect(ArcadeEventSchema.safeParse(envelope(5, 'GamePaused', { reason: 'nap' })).success).toBe(false);
  });

  it('parses TurnReviewed as a layer-2 game fact', () => {
    const e = parseArcadeEvent(envelope(7, 'TurnReviewed', { playerId: PLAYER, turnIndex: 11 }));
    expect(e.type).toBe('TurnReviewed');
    expect(GAME_FACT_TYPES.has('TurnReviewed')).toBe(true);
    expect(isBoardFact(e)).toBe(false);
  });

  it.each([
    ['negative turn index', { playerId: PLAYER, turnIndex: -1 }],
    ['missing player', { turnIndex: 3 }],
    ['non-ULID player', { playerId: 'alex', turnIndex: 3 }],
  ])('rejects a TurnReviewed with %s', (_label, payload) => {
    expect(ArcadeEventSchema.safeParse(envelope(7, 'TurnReviewed', payload)).success).toBe(false);
  });

  it('parses ConfirmTurn and rejects a bad turn index', () => {
    expect(ArcadeCommandSchema.safeParse(command('ConfirmTurn', { turnIndex: 11 })).success).toBe(true);
    expect(ArcadeCommandSchema.safeParse(command('ConfirmTurn', { turnIndex: 1.5 })).success).toBe(false);
    expect(ArcadeCommandSchema.safeParse(command('ConfirmTurn', {})).success).toBe(false);
  });

  it('keeps the correction commands a review turn needs', () => {
    const seg = makeSegment(20, 3);
    const ok = [
      command('CorrectDart', { throwId: ulid(4), segment: seg }),
      command('VoidDart', { throwId: ulid(4), reason: 'false-detection' }),
      command('AddDart', { playerId: PLAYER, turnIndex: 11, dartIndex: 2, segment: seg, reason: 'undetected' }),
      command('AddDart', { playerId: PLAYER, turnIndex: 11, dartIndex: 0, segment: seg, reason: 'bounce-out' }),
    ];
    for (const c of ok) expect(ArcadeCommandSchema.safeParse(c).success).toBe(true);
  });
});

describe('session and pause commands', () => {
  const players = [{ playerId: PLAYER, displayName: 'Alex', colorIndex: 0, kind: 'profile' }];

  it('accepts StartSession with and without house rules', () => {
    const base = { gameId: 'countdown', options: {}, players };
    expect(ArcadeCommandSchema.safeParse(command('StartSession', base)).success).toBe(true);
    const withRules = { ...base, houseRules: { ...DEFAULT_HOUSE_RULES, emptyTakeoutSkipsTurn: true } };
    expect(ArcadeCommandSchema.safeParse(command('StartSession', withRules)).success).toBe(true);
    const badRules = { ...base, houseRules: { missingDartsAreMisses: 'yes' } };
    expect(ArcadeCommandSchema.safeParse(command('StartSession', badRules)).success).toBe(false);
  });

  it('lets the app pause and resume for app-background, but not for review or board-offline', () => {
    expect(ArcadeCommandSchema.safeParse(command('Pause', { reason: 'app-background' })).success).toBe(true);
    expect(ArcadeCommandSchema.safeParse(command('Pause', { reason: 'review' })).success).toBe(false);
    expect(ArcadeCommandSchema.safeParse(command('Pause', { reason: 'board-offline' })).success).toBe(false);
    expect(ArcadeCommandSchema.safeParse(command('Resume', {})).success).toBe(true);
    expect(ArcadeCommandSchema.safeParse(command('Resume', { reason: 'menu' })).success).toBe(true);
    expect(ArcadeCommandSchema.safeParse(command('Resume', { reason: 'review' })).success).toBe(false);
  });
});
