// Node module hooks that let these dev tools run the workspace's TypeScript sources
// directly with Node 22's --experimental-strip-types, without a build step or new
// dependencies. Relative imports without an extension resolve to `.ts` (or
// `/index.ts`), and every `.ts` file loads as an ES module.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

export async function resolve(specifier, context, next) {
  const fromTs = context.parentURL?.endsWith('.ts');
  if (fromTs && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));
    for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
      if (isFile(candidate)) {
        const url = pathToFileURL(candidate).href;
        return { url, shortCircuit: true, format: candidate.endsWith('.ts') ? 'module-typescript' : undefined };
      }
    }
  }
  const resolved = await next(specifier, context);
  return resolved.url.endsWith('.ts') ? { ...resolved, format: 'module-typescript' } : resolved;
}
