// Model provider settings as the settings page sees them. Secrets (API key,
// client secret) only travel renderer -> main when the user types a new one;
// main never sends them back, only `hasSecret`.

export type ProviderKind = 'openai' | 'anthropic' | 'wso2';

export const PROVIDER_KINDS: readonly { kind: ProviderKind; label: string }[] = [
  { kind: 'openai', label: 'OpenAI 兼容' },
  { kind: 'anthropic', label: 'Anthropic' },
  { kind: 'wso2', label: '公司网关（WSO2）' },
];

/**
 * The name of a connection read from .env.local (development builds). With both an OpenAI compatible and an
 * Anthropic one configured, each says which it is, in the words the form uses for the kind.
 */
export function devConnectionName(kind: ProviderKind, both: boolean): string {
  return both ? `开发用模型（.env.local，${kindLabel(kind)}）` : '开发用模型（.env.local）';
}

export function kindLabel(kind: ProviderKind): string {
  return PROVIDER_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** Fields shared by every kind; unused ones stay empty. */
export interface ProviderFields {
  kind: ProviderKind;
  name: string;
  /** API base URL (OpenAI compatible, WSO2; optional for Anthropic). */
  baseUrl: string;
  /** Default model. */
  model: string;
  /** Model for heavy work (optional). */
  strongModel: string;
  /** WSO2: OAuth token endpoint. */
  tokenUrl: string;
  /** WSO2: OAuth client id. */
  clientId: string;
  /** WSO2: OAuth scope (optional). */
  scope: string;
  /** Requests allowed at the same time (empty = no limit). */
  maxConcurrent: number | null;
  /** Requests per minute (empty = no limit). */
  requestsPerMinute: number | null;
  /** How many tokens `model` takes at once (its context window). Required when saving; null in older files. */
  contextWindow: number | null;
  /** The catalog provider or company preset it was set up from (null: 中转站 / 公司网关, or older files). */
  catalogId: string | null;
}

/** Where a model's context window came from. */
export type ContextFrom = 'user' | 'catalog' | 'provider' | 'name-match';

/** One model ticked under a connection, with its own context window. */
export interface ConnectionModel {
  /** As the API takes it. */
  id: string;
  /** Required for use; null only in older settings until it is filled in. */
  contextWindow: number | null;
  contextFrom: ContextFrom;
  /**
   * false: kept in this connection's list but not in use (unticking is not deleting) — not
   * offered anywhere, no 上下文上限 needed. Absent: in use.
   */
  enabled?: boolean;
}

/** In use (checked in the connection's list). */
export function isEnabled(m: Pick<ConnectionModel, 'enabled'>): boolean {
  return m.enabled !== false;
}

/** The models in use, in list order. */
export function enabledModels<T extends Pick<ConnectionModel, 'enabled'>>(models: readonly T[]): T[] {
  return models.filter(isEnabled);
}

/** 「哪一条 + 哪个模型」: the default for new conversations, the one for heavy work. */
export interface ModelRef {
  connectionId: string;
  model: string;
}

/**
 * What the settings page shows for a saved connection: one provider, one key,
 * the models ticked under it. `model` / `strongModel` / `contextWindow` are the
 * first two models, for the form that still edits one model at a time.
 */
export interface ProviderView extends ProviderFields {
  id: string;
  hasSecret: boolean;
  /** Its key as shown: first and last characters with **** between (keyMaskParts); null without one. */
  keyMask: string | null;
  /** The models ticked under this connection. */
  models: ConnectionModel[];
  /** Holds the model new conversations use. */
  isDefault: boolean;
  /** Comes from the developer's .env.local and cannot be edited here. */
  readOnly?: boolean;
}

/**
 * What the settings page sends to save or test. `secret` undefined = keep the
 * saved one. `models` is the whole ticked list; without it, `model` (and
 * `strongModel`) are the list (the one-model form).
 */
export interface ProviderDraft extends ProviderFields {
  id?: string;
  secret?: string;
  models?: ConnectionModel[];
}

/** A connection with its key, for building the real connection (main process only). */
export interface ResolvedProvider extends ProviderFields {
  id: string;
  secret: string;
  models: ConnectionModel[];
}

/**
 * The ticked models a draft stands for: its `models`, or `model` (with the
 * form's 上下文上限) and `strongModel` (keeping what was known of it).
 */
export function modelsOfDraft(d: ProviderDraft, saved: readonly ConnectionModel[] = []): ConnectionModel[] {
  if (d.models) return d.models.filter((m) => m.id.trim()).map((m) => ({ ...m, id: m.id.trim() }));
  const out: ConnectionModel[] = [];
  const main = d.model.trim();
  if (main) out.push({ id: main, contextWindow: d.contextWindow, contextFrom: saved.find((m) => m.id === main && m.contextWindow === d.contextWindow)?.contextFrom ?? 'user' });
  const strong = d.strongModel.trim();
  if (strong && strong !== main) {
    const known = saved.find((m) => m.id === strong);
    out.push(known ?? { id: strong, contextWindow: null, contextFrom: 'user' });
  }
  return out;
}

/** The one-model form's fields for a list of models: the first is 模型, the second 强模型. */
export function legacyModelFields(models: readonly ConnectionModel[]): Pick<ProviderFields, 'model' | 'strongModel' | 'contextWindow'> {
  const on = enabledModels(models);
  return { model: on[0]?.id ?? '', strongModel: on[1]?.id ?? '', contextWindow: on[0]?.contextWindow ?? null };
}

export interface TestResult {
  ok: boolean;
  message: string;
  /** The test only got through with /v1 added: the address to put in the form (and save). */
  suggestedBaseUrl?: string;
}

export function emptyDraft(kind: ProviderKind = 'openai'): ProviderDraft {
  return {
    kind,
    name: '',
    baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com/v1' : '',
    model: '',
    strongModel: '',
    tokenUrl: '',
    clientId: '',
    scope: '',
    maxConcurrent: null,
    requestsPerMinute: null,
    contextWindow: null,
    catalogId: null,
  };
}

/** Kind names as the core's ProviderConfig spells them. */
export function coreKind(kind: ProviderKind): 'openai-compatible' | 'anthropic' | 'wso2' {
  return kind === 'openai' ? 'openai-compatible' : kind;
}

export function secretLabel(kind: ProviderKind): string {
  return kind === 'wso2' ? 'Consumer Secret' : 'API Key';
}

/**
 * WSO2's developer portal calls the OAuth client id the Consumer Key; that is
 * what people are handed. The OAuth names go in the hint ("也叫 Client ID"), so
 * the label stays on one line.
 */
export const WSO2_KEY_LABEL = 'Consumer Key';

export type FieldErrors = Partial<Record<keyof ProviderFields | 'secret', string>>;

function isUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(v.trim());
}

/**
 * Field problems in plain words; empty object = ready to save. `forTest`: only what
 * 测试连接 needs (上下文上限 can be filled in after the connection works).
 */
export function validateDraft(d: ProviderDraft, hasSavedSecret: boolean, opts: { forTest?: boolean; needsKey?: boolean } = {}): FieldErrors {
  const e: FieldErrors = {};
  if (!d.name.trim()) e.name = '请填写名称';
  // A whole ticked list (a connection with several models), or the one-model form.
  const list = d.models?.filter((m) => m.id.trim() && isEnabled(m));
  if (list ? list.length === 0 : !d.model.trim()) e.model = list ? '请至少选择一个模型' : '请填写模型';
  const needsUrl = d.kind !== 'anthropic';
  if (needsUrl && !d.baseUrl.trim()) e.baseUrl = d.kind === 'wso2' ? '请填写网关地址' : '请填写接口地址';
  else if (d.baseUrl.trim() && !isUrl(d.baseUrl)) e.baseUrl = '地址须以 http:// 或 https:// 开头';
  if (d.kind === 'wso2') {
    if (!d.tokenUrl.trim()) e.tokenUrl = '请填写取 token 地址';
    else if (!isUrl(d.tokenUrl)) e.tokenUrl = '地址须以 http:// 或 https:// 开头';
    if (!d.clientId.trim()) e.clientId = '请填写 Consumer Key';
  }
  const secret = d.secret?.trim();
  // Local providers (Ollama, LM Studio) need no key.
  if (!secret && !hasSavedSecret && opts.needsKey !== false) e.secret = `请填写 ${secretLabel(d.kind)}`;
  if (!opts.forTest && list) {
    const missing = list.find((m) => m.contextWindow === null || !Number.isInteger(m.contextWindow) || m.contextWindow < 1);
    if (missing) e.contextWindow = `请填写「${missing.id}」的上下文上限`;
  } else if (!opts.forTest) {
    if (d.contextWindow === null) e.contextWindow = '请填写上下文上限';
    else if (!Number.isInteger(d.contextWindow) || d.contextWindow < 1) e.contextWindow = '上下文上限须为正整数';
  }
  for (const k of ['maxConcurrent', 'requestsPerMinute'] as const) {
    const v = d[k];
    if (v !== null && (!Number.isInteger(v) || v < 1)) e[k] = '须为正整数或留空';
  }
  return e;
}
