import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Packages that must stay pure TypeScript (ARCHITECTURE §5.3 dependency rule). */
const PURE_PACKAGES = [
  'packages/event-schema/**',
  'packages/engine/**',
  'packages/games/**',
  'packages/adapters/**',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      'apps/arcade/ios/**',
      'apps/arcade/android/**',
      'apps/arcade/expo-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.{ts,mts}', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: PURE_PACKAGES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react-native', 'react-native-*', 'expo', 'expo-*', '@arcade/ui-kit', '@arcade/platform'],
              message: 'Pure packages must not import React, React Native, Expo or platform code (ARCHITECTURE §5.3).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Pure packages take time as input; do not read the clock.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Pure packages take randomness from the seeded Rng.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
);
