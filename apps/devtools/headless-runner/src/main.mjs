// Entry point: lets Node resolve the workspace's extensionless TypeScript imports
// (see resolve-ts.mjs), then runs the CLI. Node 22 strips the types itself.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
const { main } = await import('./cli.ts');
process.exitCode = main(process.argv.slice(2));
