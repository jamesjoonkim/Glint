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
      // Privacy + isolation guard: core/ must be framework-free and offline.
      files: ['src/core/**/*.ts'],
      rules: {
        'no-restricted-globals': [
          'error',
          { name: 'fetch', message: 'Network calls forbidden in core/. Surface through main/ services.' },
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
  ],
  ignorePatterns: ['out/', 'dist/', '.vite/', 'node_modules/', 'coverage/'],
};
