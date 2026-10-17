/**
 * NetWatch — پیکربندی ESLint (فرمت تخت)
 * ----------------------------------------------------------------
 * کد سمت سرور (JavaScript/ESM) با قواعد توصیه‌شدهٔ ESLint بررسی می‌شود.
 * کد سمت وب TypeScript است و با `npm run typecheck` (tsc) بررسی می‌شود.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'web/dist/**', 'data/**', 'coverage/**'],
  },
  {
    files: ['server/**/*.js', 'server/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // بلوک‌های catch خالی برای «بی‌اثر گذاشتن خطای غیربحرانی» عمدی هستند
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
