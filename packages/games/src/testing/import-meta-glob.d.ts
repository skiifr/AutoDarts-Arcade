/**
 * Vite's `import.meta.glob`, which Vitest provides. Only the tests use it, to find each
 * game's folder and fixtures without Node's fs (the package is typed without Node).
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | readonly string[],
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, T>;
}
