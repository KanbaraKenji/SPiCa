// One catalog from the area files of a language (en/*.ts, zh-TW/*.ts). The same key in two areas must say the
// same thing (i18n.test.ts checks); the later one wins here.
import type { Catalog } from './index';

export function merge(parts: readonly Catalog[]): Catalog {
  return Object.assign({}, ...parts) as Catalog;
}
