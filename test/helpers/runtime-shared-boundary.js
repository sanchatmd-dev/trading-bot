// Deliberate shared-application boundary of the runtime engine manifest. No directory-wide exemptions.
// Runtime modules may import these files without hashing them; every other import must be listed.
export const SHARED_APPLICATION_FILES=Object.freeze([
  'src/config.js',
  'src/http-safety.js',
  'src/money.js',
  'src/pine-bridge/ai-source.js',
  'src/pine-bridge/contract.js',
  'src/pine-bridge/input-review.js',
  'src/pine-bridge/provider.js',
  'src/pine-bridge/source.js',
  'src/pine-bridge/template.js',
  'src/postgres/ai-quota.js',
  'src/postgres/auth-store.js',
  'src/postgres/db.js',
  'src/postgres/http.js',
  'src/postgres/ledger.js',
  'src/postgres/pine-bridge-deployments.js',
  'src/postgres/pine-bridge-market.js',
  'src/postgres/pine-bridge-readiness.js',
  'src/postgres/pine-bridge-registry.js',
  'src/postgres/pine-bridge.js',
  'src/postgres/pine-capture.js',
  'src/postgres/store.js',
  'src/security.js'
]);
