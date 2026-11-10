// Before a release: which entries of the built-in model catalog were checked
// against the provider's official page longer ago than a limit.
//   npm run catalog:age -w @spica/core            (older than 60 days)
//   npm run catalog:age -w @spica/core -- --days 30
// Exits 1 when there are such entries (so a release script can stop on it).
// To re-check one: open its source page, compare the model id, context window
// and price, fix catalog/builtin.ts and set its `checked` to today.
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { catalogProblems, staleEntries } from '../src/catalog/catalog.ts';

const i = process.argv.indexOf('--days');
const days = i >= 0 ? Number(process.argv[i + 1]) : 60;
if (!Number.isFinite(days) || days < 0) {
  console.error('--days needs a number');
  process.exit(2);
}
const problems = catalogProblems(BUILTIN_CATALOG);
if (problems.length) {
  console.error(`the built-in catalog is not valid:\n  ${problems.join('\n  ')}`);
  process.exit(2);
}
const stale = staleEntries(BUILTIN_CATALOG, days);
if (stale.length === 0) {
  console.log(`catalog ${BUILTIN_CATALOG.version}: every entry checked within ${days} days`);
} else {
  console.log(`catalog ${BUILTIN_CATALOG.version}: ${stale.length} entries checked more than ${days} days ago`);
  for (const e of stale) console.log(`  ${e.provider}${e.model ? ` / ${e.model}` : ''}  checked ${e.checked || 'never'}  ${e.source}`);
  process.exit(1);
}
