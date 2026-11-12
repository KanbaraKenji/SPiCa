// Spica agent core: public entry point.
export type * from './types.ts';
export { EventBus, isoNow, type EventListener } from './events.ts';
export { Runtime, DEFAULT_SYSTEM_PROMPT, type RuntimeOptions } from './runtime.ts';
export { exportUsageLog, usageLogLines, USAGE_LOG_SCHEMA, USAGE_LOG_VERSION } from './export.ts';
export { redact, redactDeep, SECRET_ENV } from './util.ts';
export { configureNetwork, netFetch, networkStatus, proxyFor, NET_HINTS, netErrorCode, gatewayFaultCode, listenFetchable, FETCH_BLOCKED_PORTS, type NetworkConfig } from './net.ts';
export { Session, type RunResult, type SendHandle } from './session.ts';
export { createAgentApi } from './api.ts';
export { MemoryBook, MEMORY_LIMITS, USER_OWNER, fromOutside, hasMemory, looksSecret, normalize, overlap } from './memory.ts';
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
export { usdText } from './money.ts';
export { Tracer, REQUEST_LOG_MAX, type TraceHandle, type TraceStart } from './trace.ts';
export { summarizeRequests, bucketStart, isRateLimited } from './usage.ts';
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
export { connectBackend, BackendError, type BackendClient, type HostMethods } from './host/client.ts';
export { settingsTools, SettingsError, type SettingsBridge, type HostConnection, type HostConnectionDraft, type HostConnectionModel, type HostModelList, type HostModelPointer, type ContextFrom } from './settings-tools.ts';
export { PluginSampler, SamplingError, type SamplingGrant } from './sampling.ts';
export { BUILTIN_CATALOG } from './catalog/builtin.ts';
export {
  catalogProblems,
  presetProblems,
  effectiveCatalog,
  pricesFromCatalog,
  staleEntries,
  type ModelCatalog,
  type CatalogProvider,
  type CatalogModel,
  type CatalogPrice,
  type CatalogPreset,
  type CatalogKind,
  type ListStyle,
} from './catalog/catalog.ts';
export { listProviderModels, type ListedModel, type ListModelsResult, type ListModelsRequest } from './catalog/list-models.ts';
export { startBackend, applySettings, createProvider, lockDatabase, type SettingsPatch, type Backend, type BackendConfig, type BackendExtension, type BackendHost, type ProviderConfig } from './host/backend.ts';
export { runUtilityEntry } from './host/utility-entry.ts';
export { electronPort, nodePort, type PortLike, type WireMessage, type WireRequest, type WireResponse, type WireEvent, type WireReady } from './host/wire.ts';
export { serveMcp, spicaMcpTools, mcpDispatcher, type McpTool, type McpServeOptions } from './mcp/server.ts';
export { serveMcpHttp, newMcpToken, type McpHttpOptions, type McpHttpServer } from './mcp/http.ts';
export { MailPipeline, triageMailTool, parseToolJson, type MailConfig, type MailSource } from './mail.ts';
