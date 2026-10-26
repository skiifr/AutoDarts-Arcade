/**
 * Source adapters (ARCHITECTURE §6): autodarts-local, simulator and manual. Pure
 * TypeScript; every clock, timer, id, random number and network call is injected.
 */
export * from './endpoints';
export * from './ports';
export * from './raw';
export * from './normalize';
export * from './random';
export * from './ring-buffer';
export * from './health';
export * from './manual';

export * from './autodarts-local/snapshot';
export * from './autodarts-local/status';
export * from './autodarts-local/visit-tracker';
export * from './autodarts-local/rebuild';
export * from './autodarts-local/adapter';
