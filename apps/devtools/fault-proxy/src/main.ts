import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { startFaultProxy } from './proxy';

const HELP = `fault-proxy: forwards Arcade's allowlisted board reads and injects faults into the event stream

  yarn fault-proxy --target 127.0.0.1:3180 --listen 3181 [--drop 0.1] [--dup 0.05] [--delay 200]
                   [--jitter 50] [--reorder 0.02] [--cut-every 30] [--seed s]

Point the app at this machine's address and the --listen port.
Keys:  c cut sockets now   o outage on/off (board vanishes)   s stats   ?  help   q quit`;

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: '127.0.0.1:3180' },
      listen: { type: 'string', default: '3181' },
      host: { type: 'string', default: '0.0.0.0' },
      drop: { type: 'string' },
      dup: { type: 'string' },
      delay: { type: 'string' },
      jitter: { type: 'string' },
      reorder: { type: 'string' },
      'cut-every': { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const [tHost, tPort] = (values.target ?? '').split(':');
  if (!tHost) throw new Error('--target must look like 192.168.1.40:3180');
  const time = (): string => new Date().toISOString().slice(11, 23);
  const proxy = await startFaultProxy({
    target: { host: tHost, port: Number(tPort ?? 3180) },
    listenPort: Number(values.listen),
    listenHost: values.host,
    drop: num(values.drop, 'drop'),
    dup: num(values.dup, 'dup'),
    delayMs: num(values.delay, 'delay'),
    jitterMs: num(values.jitter, 'jitter'),
    reorder: num(values.reorder, 'reorder'),
    cutEvery: num(values['cut-every'], 'cut-every'),
    seed: values.seed,
    log: (line) => console.log(`${time()}  ${line}`),
  });
  console.log(`fault-proxy on :${proxy.port} → ${values.target}  (press ? for keys)`);
  const quit = async (): Promise<void> => {
    await proxy.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void quit());
  if (!process.stdin.isTTY) return;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_s: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    if (key.ctrl && key.name === 'c') return void quit();
    switch (key.name ?? key.sequence) {
      case 'c':
        console.log(`${time()}  cut ${proxy.cutAll()} socket(s)`);
        break;
      case 'o':
        proxy.setOutage(!proxy.outage);
        console.log(`${time()}  outage ${proxy.outage ? 'ON: board unreachable' : 'off'}`);
        break;
      case 's':
        console.log(`${time()}  ${JSON.stringify(proxy.stats)}`);
        break;
      case 'q':
        return void quit();
      default:
        if (key.sequence === '?') console.log(HELP);
    }
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
