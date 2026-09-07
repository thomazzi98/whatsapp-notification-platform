/**
 * Architectural layering, enforced mechanically.
 *
 * The primary enforcement is each package's own `dependencies` field: the
 * domain package declares only `zod`, so infrastructure libraries are not even
 * resolvable from inside it. These rules catch the cases a manifest cannot,
 * such as an application reaching past the composition root into an adapter.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-stays-pure',
      severity: 'error',
      comment:
        'The notification domain must not depend on infrastructure. Depend on a port ' +
        'declared in the domain and bind the adapter in packages/composition.',
      from: { path: '^packages/domain/' },
      to: {
        path:
          '^(packages/(database|queue|provider-whatsapp|composition|observability)|apps/)|' +
          '^node_modules/(drizzle-orm|pg|pg-boss|@nestjs|fastify|undici|pino)',
      },
    },
    {
      name: 'contracts-stay-transport-agnostic',
      severity: 'error',
      comment: 'Request and response schemas must not reach into persistence or the queue.',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/(database|queue|provider-whatsapp|composition)|^apps/' },
    },
    {
      name: 'applications-go-through-composition',
      severity: 'error',
      comment:
        'Applications receive use-cases from packages/composition. Importing an adapter ' +
        'directly lets a controller reach for a database query.',
      from: { path: '^apps/(api|worker)/' },
      to: { path: '^packages/(database|queue|provider-whatsapp)/' },
    },
    {
      name: 'no-cross-application-imports',
      severity: 'error',
      comment: 'Applications share code through packages, never through each other.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/(?!$1)([^/]+)/' },
    },
    {
      name: 'adapters-do-not-depend-on-composition',
      severity: 'error',
      comment: 'Composition wires adapters together; an adapter must not reach back into it.',
      from: { path: '^packages/(database|queue|provider-whatsapp|observability)/' },
      to: { path: '^packages/composition/' },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'A dependency cycle makes initialisation order undefined.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-production-code-importing-tests',
      severity: 'error',
      from: { pathNot: '\.(test|spec)\.ts$' },
      to: { path: '\.(test|spec)\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'node', 'types'],
      extensions: ['.ts', '.mts', '.js', '.mjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
