// IPC channel names between main and preload (desktop-only; core commands are routed by name).
export const DesktopChannel = {
  /** invoke: (method: keyof AgentApi, ...args) -> result */
  Agent: 'spica:agent',
  /** main -> renderer: CoreEvent */
  AgentEvent: 'spica:agent-event',
  GetSettings: 'spica:settings:get',
  UpdateSettings: 'spica:settings:update',
  /** main -> renderer: ShellSettings after any change (including zoom keys) */
  SettingsChanged: 'spica:settings:changed',
  GetShellState: 'spica:shell:get',
  OpenFile: 'spica:file:open',
  /** invoke: () -> BackendStatus; main -> renderer: BackendStatus */
  BackendStatus: 'spica:backend:status',
  /** main -> renderer: the core restarted after a crash (reload sessions) */
  BackendRestarted: 'spica:backend:restarted',
  /** renderer -> main: try starting the core again after it gave up */
  BackendRetry: 'spica:backend:retry',
  /** invoke: 'state' | 'check' | 'install' -> UpdateState */
  Update: 'spica:update',
  /** main -> renderer: UpdateState */
  UpdateChanged: 'spica:update:changed',
  /** invoke: () -> chosen folder path or null */
  PickFolder: 'spica:folder:pick',
  /** invoke: PluginsCommand -> PluginsResult */
  Plugins: 'spica:plugins',
  /** main -> renderer: plugins changed on their own (server crashed, ...) */
  PluginsChanged: 'spica:plugins:changed',
  /** main -> renderer: how far an install the plugin page started is */
  PluginsProgress: 'spica:plugins:progress',
  ProvidersChanged: 'spica:providers:changed',
  ActiveSession: 'spica:ui:active-session',
  /** renderer -> main: what covers the window ('splash' | 'scrim' | null); the caption symbols follow it. */
  Cover: 'spica:ui:cover',
  /** renderer -> main: the page listens for the close question (main/tray.ts closeAsker) */
  CloseAskReady: 'spica:close:ready',
  /** main -> renderer: the window's × with 关闭窗口时 = 每次询问: show the question */
  CloseAsk: 'spica:close:ask',
  /** renderer -> main: { choice: 'tray' | 'quit' | null, remember } */
  CloseAnswer: 'spica:close:answer',
  /** renderer -> main: 'in' | 'out' | 'reset' (Ctrl+wheel and zoom keys caught in the page) */
  Zoom: 'spica:zoom',
  ListProviders: 'spica:providers:list',
  SaveProvider: 'spica:providers:save',
  DeleteProvider: 'spica:providers:delete',
  SetDefaultProvider: 'spica:providers:default',
  SetModelPointer: 'spica:providers:pointer',
  TestProvider: 'spica:providers:test',
  KnownContextWindow: 'spica:providers:known-window',
  ModelCatalog: 'spica:providers:catalog',
  ListProviderModels: 'spica:providers:list-models',
  MatchContextWindow: 'spica:providers:match-window',
  /** invoke -> Record<connection id, USD>: 已花 since the last 清零 */
  ProviderSpend: 'spica:providers:spend',
  /** invoke(id): 清零 */
  ResetProviderSpend: 'spica:providers:reset-spend',
  /** invoke: UsageQuery -> UsageSummary | null (设置 › 用量; null while the core is not up) */
  UsageSummary: 'spica:usage:summary',
  /** invoke: after (seq) -> MonitorEntry[] (监控台: the lines kept, newer than `after`) */
  MonitorList: 'spica:monitor:list',
  /** renderer -> main: true / false (the monitor is open: send new lines) */
  MonitorWatch: 'spica:monitor:watch',
  /** main -> renderer: MonitorEntry[] (new lines, in batches) */
  MonitorEntries: 'spica:monitor:entries',
  /** invoke: seq -> string | null (a line's whole text: a tool's full input or result) */
  MonitorFull: 'spica:monitor:full',
  /** invoke: text -> SaveCsvResult (asks where to save a .log first) */
  MonitorExport: 'spica:monitor:export',
  Images: 'spica:images',
  ProjectRead: 'spica:projects:read',
  ContextBreakdown: 'spica:context:breakdown',
  /** invoke: 'state' | 'open' -> WorkflowsState */
  Workflows: 'spica:workflows',
  /** invoke: title -> string[] (Windows' file picker, several files; empty when cancelled) */
  PickFiles: 'spica:pickFiles',
  /** invoke: (sessionId, path) -> PreviewInfo */
  Preview: 'spica:preview',
  /** invoke: (sessionId, path, maxBytes, peek) -> PreviewFile (a plugin preview page's file: its bytes, never its path) */
  PreviewFile: 'spica:previewFile',
  /** invoke: -> NetworkState (what the core uses now, and problems with the settings) */
  Network: 'spica:network',
  /** invoke: -> LocalConnectInfo | null */
  LocalConnect: 'spica:localConnect',
  /** invoke: -> PluginView[] (pages of enabled plugins) */
  PluginViews: 'spica:pluginViews',
  /** invoke: (plugin, view, tool, args, confirmed) -> PluginViewResult */
  PluginViewCall: 'spica:pluginViewCall',
  PluginViewCancel: 'spica:pluginViewCancel',
  /** invoke: (plugin, path) -> absolute path inside the plugin, or null */
  PluginViewFile: 'spica:pluginViewFile',
  /** invoke: PluginPickRequest -> the full path picked, or null (a plugin page's pickFolder / pickFile) */
  PluginPick: 'spica:pluginPick',
  /** invoke: UsageLogRequest -> UsageLogResult (asks where to save first) */
  UsageLog: 'spica:usageLog',
  /** invoke: absolute path -> null, or what to show (a file or folder selected in Explorer) */
  ShowInFolder: 'spica:showInFolder',
  /** invoke: absolute folder path -> null, or what to show (the folder opened in Explorer) */
  OpenFolder: 'spica:openFolder',
  /** invoke: (suggested name, CSV text) -> SaveCsvResult (asks where to save first) */
  SaveCsv: 'spica:saveCsv',
} as const;
