// The model catalog as the settings form reads it. The core owns the data
// (@spica/core ModelCatalog / ListModelsResult); these are the same shapes,
// kept here so the window's code does not pull the core's Node modules in.

export interface CatalogPriceView {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Official list price in this currency (CNY or USD); shown as is. */
  currency: 'USD' | 'CNY';
}

export interface CatalogModelView {
  id: string;
  label?: string;
  contextWindow: number;
  maxOutput?: number;
  role?: 'default' | 'strong' | 'cheap';
  /** Official price only; absent when none was found (never show the budget's fallback). */
  price?: CatalogPriceView;
}

export interface CatalogProviderView {
  id: string;
  name: string;
  /** company = the packaging's preset. */
  group: 'company' | 'cn' | 'intl' | 'local';
  kind: 'openai-compatible' | 'anthropic' | 'wso2';
  baseUrl: string;
  tokenUrl?: string;
  scope?: string;
  docsUrl?: string;
  listModels: 'openai' | 'openai-chat' | 'anthropic' | 'ollama' | 'lmstudio' | 'none';
  needsKey: boolean;
  models: CatalogModelView[];
  default?: boolean;
  maxConcurrent?: number;
  requestsPerMinute?: number;
}

export interface ModelCatalogView {
  version: string;
  providers: CatalogProviderView[];
}

/** A model name matched to the catalog: its context window, the catalog's name for it, exact or by name. */
export interface WindowMatch {
  contextWindow: number;
  matched: string;
  how: 'exact' | 'name';
}

export type ListModelsView =
  | { ok: true; models: { id: string; label?: string; contextWindow?: number; maxOutput?: number; inCatalog: boolean; chat: boolean }[] }
  | { ok: false; code: string; hint?: string; httpStatus?: number; message: string };
