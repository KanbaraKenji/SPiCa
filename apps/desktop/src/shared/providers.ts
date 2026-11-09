// Model provider settings as the settings page sees them. Secrets (API key,
// client secret) only travel renderer -> main when the user types a new one;
// main never sends them back, only `hasSecret`.

export type ProviderKind = 'openai' | 'anthropic' | 'wso2';

export const PROVIDER_KINDS: readonly { kind: ProviderKind; label: string }[] = [
  { kind: 'openai', label: 'OpenAI 兼容' },
  { kind: 'anthropic', label: 'Anthropic' },
  { kind: 'wso2', label: 'WSO2 网关' },
];

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
}

/** What the settings page shows for a saved provider. */
export interface ProviderView extends ProviderFields {
  id: string;
  hasSecret: boolean;
  isDefault: boolean;
  /** Comes from the developer's .env.local and cannot be edited here. */
  readOnly?: boolean;
}

/** What the settings page sends to save or test. `secret` undefined = keep the saved one. */
export interface ProviderDraft extends ProviderFields {
  id?: string;
  secret?: string;
}

/** A provider with its secret, for building the real connection (main process only). */
export interface ResolvedProvider extends ProviderFields {
  id: string;
  secret: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
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
  };
}

export function secretLabel(kind: ProviderKind): string {
  return kind === 'wso2' ? 'Client Secret' : 'API Key';
}

export type FieldErrors = Partial<Record<keyof ProviderFields | 'secret', string>>;

function isUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(v.trim());
}

/** Field problems in plain words; empty object = ready to save. */
export function validateDraft(d: ProviderDraft, hasSavedSecret: boolean): FieldErrors {
  const e: FieldErrors = {};
  if (!d.name.trim()) e.name = '起个名字，方便在列表里认出来';
  if (!d.model.trim()) e.model = '填要用的模型名';
  const needsUrl = d.kind !== 'anthropic';
  if (needsUrl && !d.baseUrl.trim()) e.baseUrl = '填接口地址';
  else if (d.baseUrl.trim() && !isUrl(d.baseUrl)) e.baseUrl = '地址要以 http:// 或 https:// 开头';
  if (d.kind === 'wso2') {
    if (!d.tokenUrl.trim()) e.tokenUrl = '填取 token 的地址';
    else if (!isUrl(d.tokenUrl)) e.tokenUrl = '地址要以 http:// 或 https:// 开头';
    if (!d.clientId.trim()) e.clientId = '填 Client ID';
  }
  const secret = d.secret?.trim();
  if (!secret && !hasSavedSecret) e.secret = `填 ${secretLabel(d.kind)}`;
  for (const k of ['maxConcurrent', 'requestsPerMinute'] as const) {
    const v = d[k];
    if (v !== null && (!Number.isInteger(v) || v < 1)) e[k] = '填正整数，或者留空表示不限';
  }
  return e;
}
