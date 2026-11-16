// Traditional Chinese (Taiwan usage). Keys are the Simplified text (shared/i18n/index.ts); terms follow
// ledger-briefs/i18n/术语表.md. Entries are grouped by area (one file each, merged here).
import type { Catalog } from './index';
import { merge } from './merge';
import { ZH_TW_APPEARANCE } from './zh-TW/appearance';
import { ZH_TW_WINDOW } from './zh-TW/window';
import { ZH_TW_MAIN } from './zh-TW/main';
import { ZH_TW_MODELS } from './zh-TW/models';
import { ZH_TW_SETTINGS } from './zh-TW/settings';
import { ZH_TW_SHELL } from './zh-TW/shell';
import { ZH_TW_CHAT } from './zh-TW/chat';
import { ZH_TW_MEMORY } from './zh-TW/memory';

export const ZH_TW: Catalog = merge([ZH_TW_APPEARANCE, ZH_TW_WINDOW, ZH_TW_MAIN, ZH_TW_MODELS, ZH_TW_SETTINGS, ZH_TW_SHELL, ZH_TW_CHAT, ZH_TW_MEMORY]);
