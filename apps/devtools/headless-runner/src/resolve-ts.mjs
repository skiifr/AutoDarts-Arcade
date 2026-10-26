/**
 * Node resolve hook. The workspace packages are TypeScript sources imported without file
 * extensions (bundler style), which Node's ESM resolver does not accept. When a specifier
 * fails to resolve, try it again as `<specifier>.ts` and `<specifier>/index.ts`.
 */
const RETRY = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!RETRY.has(error?.code) || specifier.startsWith('node:') || /\.[cm]?[jt]s$/.test(specifier)) throw error;
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // try the next suffix
      }
    }
    throw error;
  }
}
