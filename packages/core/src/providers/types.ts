// Provider contract: one streaming call to a model endpoint.
import type { ContentBlock, Message, StopReason, ToolSpec, Usage } from '../types.ts';

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Required: every call carries an output ceiling. */
  maxTokens: number;
  temperature?: number;
  /** Model-hosted tools the provider should enable (only if it supports them). */
  serverTools?: ServerToolRequest[];
  /** Extra top-level body fields, merged last (escape hatch for plugins). */
  extra?: Record<string, unknown>;
}

export interface ServerToolRequest {
  kind: 'web_search';
  maxUses?: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  /** The provider's own stop reason string. */
  rawStopReason?: string;
  usage: Usage;
  model: string;
  providerExtras?: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string }
  | { type: 'response'; response: ModelResponse };

export interface CallInfo {
  /** Attempts made (1 = no retry). */
  attempts: number;
  httpStatus?: number;
}

export interface ProviderCallContext {
  signal: AbortSignal;
  /** Called before each retry wait. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** Filled in by the provider while the call runs. */
  info?: CallInfo;
}

export interface ProviderCapabilities {
  /** Model-hosted web search is available. */
  serverWebSearch: boolean;
}

export interface Provider {
  readonly id: string;
  readonly kind: string;
  /**
   * What traces record as the request target: the provider id by default, or
   * the endpoint host name when the deployment opts in (`traceHost: true`).
   * Never the full URL.
   */
  readonly traceTarget: string;
  readonly capabilities: ProviderCapabilities;
  /** Called once when the runtime adopts the provider (e.g. to trace token requests). */
  attach?(services: { tracer: import('../trace.ts').Tracer }): void;
  /** Values that must never appear in exports or logs: keys, client secrets, endpoint addresses and their host names. */
  secrets?(): string[];
  stream(request: ModelRequest, ctx: ProviderCallContext): AsyncGenerator<ProviderEvent, void>;
}

/** Thrown for failed provider calls. Message is already redacted. */
export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

/** Optional credential source for providers (static key, OAuth token, ...). */
export interface AuthSource {
  /** Headers to add to each request. */
  headers(signal: AbortSignal): Promise<Record<string, string>>;
  /** Called after a 401; return true if new credentials were obtained and a retry makes sense. */
  refresh?(signal: AbortSignal): Promise<boolean>;
}
