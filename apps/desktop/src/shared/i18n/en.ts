// English. Keys are the Simplified text (shared/i18n/index.ts); terms follow ledger-briefs/i18n/术语表.md.
// Entries are grouped by area (one file each, merged here) so pages can be moved over one at a time.
import type { Catalog } from './index';
import { merge } from './merge';
import { EN_APPEARANCE } from './en/appearance';
import { EN_WINDOW } from './en/window';
import { EN_MAIN } from './en/main';
import { EN_MODELS } from './en/models';
import { EN_SETTINGS } from './en/settings';
import { EN_SHELL } from './en/shell';
import { EN_CHAT } from './en/chat';
import { EN_MEMORY } from './en/memory';
import { EN_FORMS } from './en/forms';
import { EN_MCP } from './en/mcp';

export const EN: Catalog = merge([EN_APPEARANCE, EN_WINDOW, EN_MAIN, EN_MODELS, EN_SETTINGS, EN_SHELL, EN_CHAT, EN_MEMORY, EN_FORMS, EN_MCP]);
