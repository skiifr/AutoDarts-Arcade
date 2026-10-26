import { z } from 'zod';
import { ArcadeEventSchema } from './events';

export * from './commands';
export * from './drafts';
export * from './events';
export * from './ids';
export * from './segment';

/** Validates any persisted or received event. Throws a ZodError on invalid input. */
export function parseArcadeEvent(input: unknown) {
  return ArcadeEventSchema.parse(input);
}

/** JSON Schema for non-TypeScript consumers (diagnostics tools, fixtures). */
export function arcadeEventJsonSchema() {
  return z.toJSONSchema(ArcadeEventSchema, { unrepresentable: 'any' });
}
