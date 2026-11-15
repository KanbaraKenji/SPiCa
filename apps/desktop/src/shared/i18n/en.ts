// English. Keys are the Simplified text (shared/i18n/index.ts); terms follow ledger-briefs/i18n/术语表.md.
// Entries are grouped by area (one file each, merged here) so pages can be moved over one at a time.
import type { Catalog } from './index';
import { merge } from './merge';
import { EN_APPEARANCE } from './en/appearance';
import { EN_WINDOW } from './en/window';
import { EN_MAIN } from './en/main';

export const EN: Catalog = merge([EN_APPEARANCE, EN_WINDOW, EN_MAIN]);
