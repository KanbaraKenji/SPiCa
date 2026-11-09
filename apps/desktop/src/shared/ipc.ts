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
} as const;
