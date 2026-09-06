import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Firestore Security Rules tests run in Node against the emulator, not in the
  // browser, and use Vitest's globals. React rules do not apply to them.
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // ── Context providers: the four files that export a Provider COMPONENT
  //    alongside its consumer hook (ADR-41) ──────────────────────────────────
  //
  // `react-refresh/only-export-components` is a DEV-SERVER HMR ergonomics rule.
  // It has no runtime, production-build, correctness or security meaning — the
  // `vite build` output is byte-identical either way. All it decides is whether
  // editing a file hot-updates or forces a full page reload, and these four are
  // app-root providers where any edit remounts the whole tree regardless.
  //
  // THE RULE IS NOT DISABLED. It stays at `error` here, narrowed three ways:
  // these four exact files, these six exact export names, and nothing else. A
  // NEW non-component export added to any of them still fails lint, and every
  // other file in the repo remains fully checked.
  //
  // `allowConstantExport` is re-stated because flat-config rule options REPLACE
  // rather than merge — without it, the value inherited from
  // `reactRefresh.configs.vite` above would be silently lost.
  //
  // The alternative — splitting each provider into a context module, a provider
  // component and the hook — is recorded in ADR-41 as the available upgrade if
  // provider HMR ever becomes a real irritant. It is not worth the indirection
  // today.
  {
    files: [
      'src/hooks/useAuth.jsx',
      'src/hooks/useProfile.jsx',
      'src/hooks/useCompany.jsx',
      'src/hooks/useProjects.jsx',
    ],
    rules: {
      'react-refresh/only-export-components': ['error', {
        allowConstantExport: true,
        allowExportNames: [
          'useAuth', 'useProfile', 'useCompany', 'useProjects',
          'getInitials', 'getDisplayName',
        ],
      }],
    },
  },
])
