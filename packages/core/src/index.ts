// Spica agent core: public entry point.
export type * from './types.ts';
export { EventBus, isoNow, type EventListener } from './events.ts';
export { Runtime, DEFAULT_SYSTEM_PROMPT, type RuntimeOptions } from './runtime.ts';
export { Session, type RunResult, type SendHandle } from './session.ts';
export { createAgentApi } from './api.ts';
export {
  buildSegments,
  flattenSegments,
  splitMessages,
  INJECTION_POSITIONS,
  type ContextSegments,
  type Injection,
  type InjectionPosition,
} from './context.ts';
export {
  HookRegistry,
  type HookContext,
  type Hooks,
  type RequestDraft,
  type ToolCallDraft,
  type ToolDecision,
  type ToolResultDraft,
} from './hooks.ts';
export { RateLimiter, type LimiterConfig, type Lease } from './limiter.ts';
export {
  CostLedger,
  DEFAULT_PRICES,
  FALLBACK_PRICE,
  type BudgetConfig,
  type BudgetCheck,
  type Limits,
  type ModelPrice,
  type PriceTable,
} from './cost.ts';
export { Tracer, type TraceHandle, type TraceStart } from './trace.ts';
export { MemoryStore } from './store/memory.ts';
export type { PendingRecord, RelayRecord, SessionConfig, SessionRecord, Store, ToolCallRecord } from './store/types.ts';
export { ToolRegistry, validateInput, type FileExtractor, type Tool, type ToolContext, type ToolEnv, type ToolOutput } from './tools/types.ts';
export {
  agentTools,
  askUserTool,
  suggestActionsTool,
  spawnAgentTool,
  messageAgentTool,
  waitAgentsTool,
  recordDecisionTool,
} from './tools/agent-tools.ts';
export { createRunCommandTool, runCommandTool, type CommandToolOptions } from './tools/command-tool.ts';
export {
  createWebFetchTool,
  createWebSearchTool,
  jsonSearchBackend,
  htmlToText,
  webFetchTool,
  type SearchBackend,
  type SearchResult,
  type JsonSearchBackendOptions,
} from './tools/web-tools.ts';
export { McpStdioClient, connectMcp, mcpTools, mcpToolName, type McpServerConfig, type McpToolInfo } from './mcp/client.ts';
export { fileTools, readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool } from './tools/fs-tools.ts';
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './providers/openai.ts';
export { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.ts';
export { Wso2Provider, OAuthClientCredentials, type Wso2Options, type OAuthClientCredentialsOptions } from './providers/wso2.ts';
export { SqliteStore } from './store/sqlite.ts';
export {
  ProviderError,
  type AuthSource,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type ProviderEvent,
} from './providers/types.ts';
export { DEFAULT_RETRY, type RetryPolicy } from './providers/http.ts';
export { probeProvider, type ProbeOptions } from './providers/probe.ts';
export { BackendServer, type BackendServerOptions } from './host/server.ts';
export { connectBackend, BackendError, type BackendClient } from './host/client.ts';
export { startBackend, createProvider, lockDatabase, type Backend, type BackendConfig, type ProviderConfig } from './host/backend.ts';
export { electronPort, nodePort, type PortLike, type WireMessage, type WireRequest, type WireResponse, type WireEvent, type WireReady } from './host/wire.ts';
