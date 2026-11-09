// What the plugin system needs from the agent core. Kept as a small port so
// the plugin package does not reach into core internals, and tests can use a
// fake. `runtimeHost()` adapts a @spica/core Runtime to it.
import type { Hooks, Tool } from '@spica/core';

/** How to start one MCP server (stdio). Mirrors @spica/core's McpServerConfig. */
export interface McpLaunch {
  /** Tools appear to the model as `<name>__<tool>`. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
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
}

export function runtimeHost(rt: RuntimeLike): PluginHost {
  return {
    registerHooks: (source, hooks, opts) => rt.hooks.register(source, hooks, opts),
    registerTool: (tool, source) => rt.tools.register(tool, source),
    async connectMcp(config, source) {
      if (!rt.connectMcp) throw new Error('这个版本的 Spica 内核还不能启动 MCP server。');
      const h = await rt.connectMcp(config, { source });
      return { tools: h.tools, disconnect: async () => void (await h.disconnect()) };
    },
    async unregisterSource(source) {
      const r = rt.unregisterSource(source) as { stopped?: Promise<void> } | undefined;
      await r?.stopped;
    },
    toolNames: () => rt.tools.list({ providerId: '', serverWebSearch: true }).map((t) => t.spec.name),
  };
}
