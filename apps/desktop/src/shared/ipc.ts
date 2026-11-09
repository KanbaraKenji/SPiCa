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
  /** renderer -> main: 'in' | 'out' | 'reset' (Ctrl+wheel and zoom keys caught in the page) */
  Zoom: 'spica:zoom',
  ListProviders: 'spica:providers:list',
  SaveProvider: 'spica:providers:save',
  DeleteProvider: 'spica:providers:delete',
  SetDefaultProvider: 'spica:providers:default',
  TestProvider: 'spica:providers:test',
} as const;
