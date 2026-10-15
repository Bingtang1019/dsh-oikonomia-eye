import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'dsh/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Deployment YAML crosses a file boundary as `unknown` and is narrowed at
      // the parse site; an unexplained `any` is a defect.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // The shape vocabulary's path patterns escape  inside a character class,
      // where the escape is redundant but harmless. That line is carried verbatim from
      // the package's source of record; this rule flags it without changing behaviour.
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['eval/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
)
