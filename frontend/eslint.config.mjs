import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Clean Architecture dependency rule: domain code is framework-free and layer-pure.
    files: ['src/**/domain/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*', 'next', 'next/*'], message: 'Domain code must not depend on React/Next.' },
            { group: ['**/data/**', '**/data', '**/presentation/**', '**/presentation', '**/di/**'], message: 'Domain code must not import data/presentation layers.' },
          ],
        },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**', 'public/sw.js']),
]);
