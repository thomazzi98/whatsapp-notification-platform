import eslint from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import prettier from 'eslint-config-prettier';

/**
 * `IfStatement > .alternate` bans both `else` and `else if`, which the
 * built-in `no-else-return` rule does not. Guard clauses, early returns and
 * strategy objects are the intended replacements.
 */
const noElseRule = {
  selector: 'IfStatement > .alternate',
  message: 'Do not use else. Use a guard clause, an early return, or a strategy object.',
};

const noNestedTernaryRule = {
  selector: 'ConditionalExpression > ConditionalExpression',
  message: 'Do not nest ternaries. Extract a named function instead.',
};

export default typescriptEslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.snapshot.json',
    ],
  },

  eslint.configs.recommended,
  ...typescriptEslint.configs.recommendedTypeChecked,
  ...typescriptEslint.configs.stylisticTypeChecked,
  unicorn.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': ['error', noElseRule, noNestedTernaryRule],

      // Descriptive identifiers are a hard requirement of this codebase.
      'unicorn/name-replacements': [
        'error',
        {
          checkFilenames: true,
          checkProperties: true,
          // The plugin's built-in map pushes the wrong way for this codebase:
          // it wants `configuration` shortened to `config` and `applicationId`
          // to `appId`. Only the list below applies.
          extendDefaultReplacements: false,
          replacements: {
            req: { request: true },
            res: { response: true },
            cfg: { configuration: true },
            conf: { configuration: true },
            usr: { user: true },
            msg: { message: true },
            notif: { notification: true },
            rec: { recipient: true },
            dest: { destination: true },
            addr: { address: true },
            db: { database: true },
            repo: { repository: true },
            ctx: { context: true },
            tx: { transaction: true },
            err: { error: true },
            idx: { index: true },
            val: { value: true },
            tmp: { temporary: true },
            attr: { attribute: true },
            // Standard in their domains, and clearer than the expansion.
            props: false,
            params: false,
            args: false,
            env: false,
            ref: false,
            refs: false,
            fn: false,
            i: false,
            j: false,
          },
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // `null` is a real value in a relational schema; conflating it with
      // undefined would misrepresent the database.
      'unicorn/no-null': 'off',
      // The backend packages are CommonJS, where top-level await is unavailable.
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      // Conflicts with idiomatic single-line JSDoc, and its autofix
      // produces a block comment without leading asterisks.
      'unicorn/single-line-block-comment-style': 'off',
      // Directly contradicts the no-else rule above: it asks for `else if`
      // where adjacent guard clauses are exactly the intended shape.
      'unicorn/prefer-else-if': 'off',
      // Iterator helpers are not typed in the ES2023 lib this project
      // targets, so the suggested form does not type check.
      'unicorn/prefer-iterator-to-array': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      curly: ['error', 'all'],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'unicorn/no-useless-undefined': 'off',
      // Assigning shared fixtures from a lifecycle hook is the standard shape
      // for a suite that owns a container or a connection.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // Test doubles are served over plain HTTP on the loopback interface.
      'unicorn/prefer-https': 'off',
    },
  },

  {
    files: ['**/scripts/**/*.ts', '**/cli/**/*.ts', '**/src/main.ts'],
    rules: {
      // These are command-line entry points; exiting with a status code is the
      // correct way for them to report failure.
      'unicorn/no-process-exit': 'off',
    },
  },

  {
    files: ['**/*.config.{ts,mts,mjs,js}'],
    rules: {
      // Option names in third-party config objects are not ours to rename.
      'unicorn/name-replacements': 'off',
    },
  },

  {
    files: ['**/*.config.{ts,mts,mjs,js}', '**/*.cjs'],
    ...typescriptEslint.configs.disableTypeChecked,
  },

  prettier,
);
