import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Backend packages; apps/web keeps its own eslint.config.js with the same base.
export default defineConfig([
  globalIgnores(['apps/web', '**/dist', '**/node_modules', 'runtime-output']),
  {
    files: ['**/*.{ts,mts,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Path, header and name validators intentionally match control characters to reject them.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
])
