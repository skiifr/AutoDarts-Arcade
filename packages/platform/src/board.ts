import { AutodartsLocalAdapter, BoardHealthSampler, type AutodartsLocalOptions, type Transport } from '@arcade/adapters';
import type { BoardAddress } from './address';
import { systemClock, systemIds, systemRandom, systemScheduler } from './runtime';
import { createBoardTransport } from './transport';

/**
 * Wiring for the app: the board adapter and the health sampler over the real transport,
 * timers, clock and ids. The session host subscribes to `source` and starts the sampler
 * with each game. `onListenerError` covers the listeners of both; the app should log there,
 * since the default reports the error as uncaught, which can be fatal in a release build.
 */
export interface BoardConnection {
  transport: Transport;
  source: AutodartsLocalAdapter;
  health: BoardHealthSampler;
}

export function connectBoard(
  address: BoardAddress,
  options: Partial<Omit<AutodartsLocalOptions, 'transport'>> = {},
): BoardConnection {
  const transport = createBoardTransport({ host: address.host, port: address.port });
  const scheduler = options.scheduler ?? systemScheduler;
  const clock = options.clock ?? systemClock;
  const source = new AutodartsLocalAdapter({
    ...options,
    transport,
    scheduler,
    clock,
    ids: options.ids ?? systemIds,
    random: options.random ?? systemRandom,
  });
  const health = new BoardHealthSampler({
    transport,
    scheduler,
    clock,
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
  });
  return { transport, source, health };
}
