import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/api/data-source.ts', 'src/mocks/horizon/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/mocks/horizon', '**/mocks/horizon/**'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/mocks.horizon/]',
          message: 'Load Horizon fixtures through the data-source boundary.',
        },
      ],
    },
  },
)
