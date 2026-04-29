/* Flat config not yet ubiquitous; using legacy rc for IDE compat. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    {
      // Privacy + isolation guard: core/ must be framework-free and (mostly) offline.
      // The only exception is core/models/, which talks to the bundled MLX server on
      // 127.0.0.1 — that boundary is the explicit local-LLM IO. Everything else in
      // core/ stays network-free so the privacy promise holds at lint time.
      files: ['src/core/**/*.ts'],
      excludedFiles: ['src/core/models/**/*.ts'],
      rules: {
        'no-restricted-globals': [
          'error',
          { name: 'fetch', message: 'Network calls forbidden in core/. Surface through main/ services or core/models/.' },
          { name: 'XMLHttpRequest', message: 'No HTTP in core/.' },
        ],
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['axios', 'node-fetch', 'undici', 'got'], message: 'No HTTP libs in core/.' },
              { group: ['electron', 'electron/*'], message: 'No Electron imports in core/. Pure TS only.' },
            ],
          },
        ],
      },
    },
    {
      // core/models/* talks to localhost MLX server only. Still no Electron, still no
      // third-party HTTP libs — built-in fetch only, hardcoded 127.0.0.1.
      files: ['src/core/models/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['axios', 'node-fetch', 'undici', 'got'], message: 'Use built-in fetch only.' },
              { group: ['electron', 'electron/*'], message: 'No Electron imports in core/.' },
            ],
          },
        ],
      },
    },
  ],
  ignorePatterns: ['out/', 'dist/', '.vite/', 'node_modules/', 'coverage/'],
};
