// What the plugin system needs from the agent core. Kept as a small port so
// the plugin package does not reach into core internals, and tests can use a
// fake. `runtimeHost()` adapts a @spica/core Runtime to it.
import type { Hooks, Tool } from '@spica/core';
import { appNameOf, type MessageOptions } from './manifest.ts';

/** How to start one MCP server (stdio). Mirrors @spica/core's McpServerConfig. */
export interface McpLaunch {
  /** Tools appear to the model as `<name>__<tool>`. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Host variables the server may inherit (whitelist). Secret-looking names never pass. */
  inheritEnv?: string[];
  cwd: string;
  timeoutMs?: number;
  /** Server stderr, for the plugin log  */
  stderrLog?: (chunk: string) => void;
  /** The process ended; `expected` is true after disconnect(). */
  onExit?: (info: McpExit) => void;
}

export interface McpExit {
  code: number | null;
  stderrTail: string;
  expected: boolean;
}

export interface McpHandle {
  /** Tool names as the model sees them. */
  tools: string[];
  /** Resolves when the server process has exited. */
  disconnect(): Promise<void>;
}

export interface PluginHost {
  /** Register hooks under a source; returns an unregister function. */
  registerHooks(source: string, hooks: Hooks, opts?: { priority?: number }): () => void;
  /** Register an in-process tool under a source; returns an unregister function. */
  registerTool(tool: Tool, source: string): () => void;
  /** Start an MCP server and add its tools under `source`. */
  connectMcp(config: McpLaunch, source: string): Promise<McpHandle>;
  /** Backstop: withdraw every hook and tool still registered under `source`; resolves when its servers have exited. */
  unregisterSource(source: string): Promise<void>;
  /** Tool names currently registered (for checks and describe()). */
  toolNames(): string[];
  /** Add a mail source to the core's mail pipeline; returns a remover. Absent when the core has no mail pipeline. */
  addMailSource?(src: MailSourceSpec): () => void;
  /** Run a registered tool directly, outside any conversation, without hooks (fallback for older cores). */
  invokeTool?(name: string, input: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  /**
   * A plugin page calls one of its plugin's tools: hooks apply, the call is
   * traced, confirmed: true means the page already asked the user. Absent on older cores.
   */
  callPluginTool?(plugin: string, tool: string, args: Record<string, unknown>, opts: { confirmed?: boolean }): Promise<PluginToolCallResult>;
}

/** Mirrors @spica/core's PluginToolResult. */
export interface PluginToolCallResult {
  content: string;
  isError: boolean;
  declined?: boolean;
  /** With confirmed: false, a confirmation was needed: nothing ran, content says why. */
  needsConfirmation?: boolean;
}

/** Mirrors @spica/core's MailSource. */
export interface MailSourceSpec {
  id: string;
  listTool: string;
  readTool: string;
  listArgs?: Record<string, unknown>;
  fields?: Record<string, string>;
}

/** The parts of @spica/core's Runtime the adapter uses (structural, so older cores still type-check). */
export interface RuntimeLike {
  hooks: { register(source: string, hooks: Hooks, opts?: { priority?: number }): () => void };
  tools: {
    register(tool: Tool, source?: string): () => void;
    list(env: { providerId: string; serverWebSearch: boolean }): Tool[];
  };
  unregisterSource(source: string): unknown;
  connectMcp?(config: McpLaunch, opts?: { source?: string }): Promise<{ tools: string[]; disconnect: () => void | Promise<void> }>;
  mail?: { addSource(src: MailSourceSpec): () => void };
  invokeTool?(name: string, input: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  callPluginTool?(plugin: string, tool: string, args: Record<string, unknown>, opts?: { confirmed?: boolean }): Promise<PluginToolCallResult>;
}

export function runtimeHost(rt: RuntimeLike, opts: MessageOptions = {}): PluginHost {
  const app = appNameOf(opts);
  return {
    registerHooks: (source, hooks, opts) => rt.hooks.register(source, hooks, opts),
    registerTool: (tool, source) => rt.tools.register(tool, source),
    async connectMcp(config, source) {
      if (!rt.connectMcp) throw new Error(`这个版本的 ${app} 内核还不能启动 MCP server。`);
      const h = await rt.connectMcp(config, { source });
      return { tools: h.tools, disconnect: async () => void (await h.disconnect()) };
    },
    async unregisterSource(source) {
      const r = rt.unregisterSource(source) as { stopped?: Promise<void> } | undefined;
      await r?.stopped;
    },
    toolNames: () => rt.tools.list({ providerId: '', serverWebSearch: true }).map((t) => t.spec.name),
    ...(rt.mail ? { addMailSource: (src: MailSourceSpec) => rt.mail!.addSource(src) } : {}),
    ...(rt.invokeTool ? { invokeTool: (name: string, input: Record<string, unknown>) => rt.invokeTool!(name, input) } : {}),
    ...(rt.callPluginTool
      ? { callPluginTool: (plugin: string, tool: string, args: Record<string, unknown>, opts: { confirmed?: boolean }) => rt.callPluginTool!(plugin, tool, args, opts) }
      : {}),
  };
}
