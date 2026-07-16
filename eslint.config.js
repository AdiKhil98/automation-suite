import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `deploy/` holds container-runtime scripts (Node .mjs / shell), not part of the
  // TypeScript app build; they run inside the hardened image, verified there.
  { ignores: ['dist', 'node_modules', 'migrations', 'coverage', '.postgres-data', 'deploy'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
