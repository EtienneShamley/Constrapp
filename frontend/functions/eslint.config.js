import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

// The trusted backend (ADR-72) is plain Node 22 ES modules. No React, no
// browser globals. Tests under test/ use Vitest globals.
export default defineConfig([
  globalIgnores(['node_modules']),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    // Operator scripts print to the terminal on purpose.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
])
