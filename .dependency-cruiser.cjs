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
          // pnpm stores every package under .pnpm/<name>@<version>/node_modules/<name>,
          // so a path anchored at ^node_modules/<name> matches nothing here.
          'node_modules/(drizzle-orm|pg|pg-boss|@nestjs|fastify|undici|pino)/',
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
        'directly lets a controller reach for a database query or a provider client.',
      from: { path: '^apps/(api|worker)/' },
      to: { path: '^packages/(database|provider-whatsapp)/' },
    },
    {
      name: 'only-the-worker-knows-the-queue',
      severity: 'error',
      comment:
        'The worker is the process that consumes jobs, so it names queues and parses job ' +
        'payloads directly. Everything else enqueues through packages/composition, which is ' +
        'what keeps the queue out of a request handler.',
      from: { path: '^apps/api/src/' },
      to: { path: '^packages/queue/' },
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
    // Seen but not traversed. Excluding node_modules outright — which this
    // config used to do — drops the edge as well as the subtree, and the half
    // of `domain-stays-pure` that names infrastructure libraries then matches
    // nothing at all.
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    // Not tsconfig.base.json: the manifests point at built output, so without
    // the source mapping in this file every cross-package import resolves into
    // `dist`, which the exclude below then drops. The cruise reported success
    // while seeing no edge between any two packages.
    tsConfig: { fileName: 'tsconfig.analysis.json' },
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
