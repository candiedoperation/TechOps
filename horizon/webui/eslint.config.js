import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    /* src/components/ui is vendored: these files are shadcn/ui primitives
       copied verbatim from peopleportal/webui so components stay portable
       between the two apps, and their published API includes the non-component
       exports shadcn ships (buttonVariants, badgeVariants, useSidebar).
       Splitting those out would fork the API from People Portal's, which is
       the one thing this directory exists to avoid.

       react-refresh/only-export-components is a hot-reload ergonomics rule,
       not a correctness one, and it is scoped off for these files only. Every
       rule stays in force for Horizon's own code, where the same warnings were
       fixed by actually moving the shared helpers out. */
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
