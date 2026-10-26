import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { SCENARIOS } from '@arcade/adapters';
import { startFakeBoard, type FakeBoard } from './server';

const HELP = `fake-board: a simulated Autodarts board for Arcade development

  yarn fake-board [--port 3180] [--host 0.0.0.0] [--scenario random-play] [--seed s] [--version 2.0.2]
  yarn fake-board --list

Keys:  t throw   b bounce-out   p phantom   w withdraw last   c change a dart
       o takeout   h hand in front   s stuck takeout   r manual reset
       d drop connections   x board off/on the network   ?  help   q quit`;

function describe(fb: FakeBoard): string {
  const b = fb.board;
  const listed = b
    .listedDetectionIds()
    .map((id) => b.detections[id - 1]?.segment.label)
    .join(' ');
  return `[${b.currentStatus}${b.isStuck ? ', stuck' : ''}] darts: ${listed || '-'}  visit ${b.currentVisit.index}  clients ${fb.clients}${fb.online ? '' : '  OFFLINE'}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '3180' },
      host: { type: 'string', default: '0.0.0.0' },
      scenario: { type: 'string', default: 'random-play' },
      seed: { type: 'string', default: 'fake-board' },
      version: { type: 'string', default: '2.0.2' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.list) {
    for (const s of Object.values(SCENARIOS)) console.log(`${s.name.padEnd(18)} ${s.description}`);
    return;
  }
  const time = (): string => new Date().toISOString().slice(11, 23);
  const fb = await startFakeBoard({
    port: Number(values.port),
    host: values.host,
    scenario: values.scenario,
    seed: values.seed,
    version: values.version,
    log: (line) => console.log(`${time()}  ${line}`),
  });
  console.log(`fake board ${values.version} on http://${values.host}:${fb.port}  scenario "${fb.scenario.name}": ${fb.scenario.description}`);
  console.log('press ? for keys');
  fb.board.onFrame((text) => {
    if (text.startsWith('{"type":"state"')) console.log(`${time()}  ${describe(fb)}`);
  });

  const quit = async (): Promise<void> => {
    await fb.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void quit());
  if (!process.stdin.isTTY) return;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_s: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    const b = fb.board;
    if (key.ctrl && key.name === 'c') return void quit();
    switch (key.name ?? key.sequence) {
      case 't':
        b.throwDart();
        break;
      case 'b':
        b.bounceOut();
        console.log(`${time()}  a dart bounced out (not detected)`);
        break;
      case 'p':
        b.phantom();
        break;
      case 'w':
        b.withdraw();
        break;
      case 'c':
        b.changeDetection();
        break;
      case 'o':
        b.startTakeout();
        setTimeout(() => b.finishTakeout(), 1000);
        break;
      case 'h':
        b.handInFront();
        break;
      case 's':
        b.stickTakeout();
        break;
      case 'r':
        b.manualReset();
        break;
      case 'd':
        console.log(`${time()}  dropped ${fb.dropConnections()} connection(s)`);
        break;
      case 'x':
        fb.setOnline(!fb.online);
        console.log(`${time()}  board is ${fb.online ? 'back on' : 'off'} the network`);
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
