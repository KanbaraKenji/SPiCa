// Tool contract and registry.
import type { CoreEventBody, FileCardMeta, ToolSpec } from '../types.ts';
import type { Tracer } from '../trace.ts';

export interface ToolContext {
  sessionId: string;
  parentChain: string[];
  /** Working folder; relative paths resolve against it. */
  cwd: string;
  signal: AbortSignal;
  tracer: Tracer;
  /** Content extractors for non-text files (PDF, Word, ...), registered by plugins. */
  extractors: FileExtractor[];
  /** Runtime services for tools that act on sessions (spawn, message, ...). */
  services: Record<string, unknown>;
  /** Id of the current tool call. */
  callId: string;
  /** Publish an event on behalf of this session (e.g. a card for the UI). */
  emit(body: CoreEventBody): void;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /** Irreversible actions (sending mail, writing external systems) need confirmation by default. */
  irreversible?: boolean;
  /**
   * `ask`: the call pauses the run until the user answers (ask_user).
   * The tool's execute() is not called; the answer becomes the result.
   */
  interaction?: 'ask';
  /** The result is outside content (web page, file text, plugin data): it reaches the model fenced as data. */
  untrusted?: import('../types.ts').UntrustedKind;
  /** The link the call opens (web_fetch), for the outside-link check. */
  targetUrl?(input: Record<string, unknown>): string | undefined;
  /** The file the call reads (read_file), for the credential-file check. */
  targetPath?(input: Record<string, unknown>): string | undefined;
  /** Hide the tool when this returns false (e.g. no search backend configured). */
  available?(env: ToolEnv): boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolEnv {
  providerId: string;
  /** Role of the session (tools for the top-level agent only, ...). */
  role?: import('../types.ts').AgentRole;
  /** Set when the session works for a project. */
  projectId?: string;
  /** Role template of the session (e.g. 'mail-triage'). */
  templateId?: string;
  /** The provider offers model-hosted web search and the session enabled it. */
  serverWebSearch: boolean;
}

/** Which part of a file read_file asked for. */
export interface ExtractRequest {
  /** "3" or "2-5" (slides for pptx). */
  pages?: string;
  /** Sheet name or 1-based index. */
  sheet?: string;
  /** 1-based first line / row; for tables offset and limit count rows. */
  offset?: number;
  limit?: number;
  /** Upper bound for the returned text (the core's single-read limit). */
  maxChars: number;
}

/** A formatted extraction: the core adds only the fetch-time line and a header. */
export interface ExtractResult {
  text: string;
  meta: FileCardMeta;
  truncated?: boolean;
}

export interface FileExtractor {
  /** Lower-case extensions including the dot, e.g. ['.pdf']. */
  extensions: string[];
  /**
   * Return plain text (the core then pages it by line like a text file), or an
   * ExtractResult that is already laid out and is passed through as is.
   */
  extract(path: string, req: ExtractRequest, signal: AbortSignal): Promise<string | ExtractResult>;
}

interface ToolEntry {
  tool: Tool;
  source: string;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolEntry>();
  /** Tools that were registered and have been taken away (plugin turned off, MCP server gone), by source. */
  readonly #removed = new Map<string, string>();

  register(tool: Tool, source = 'core'): () => void {
    if (this.#tools.has(tool.spec.name)) throw new Error(`tool already registered: ${tool.spec.name}`);
    const entry = { tool, source };
    this.#tools.set(tool.spec.name, entry);
    this.#removed.delete(tool.spec.name);
    return () => {
      if (this.#tools.get(tool.spec.name) === entry) {
        this.#tools.delete(tool.spec.name);
        this.#removed.set(tool.spec.name, source);
      }
    };
  }

  unregisterSource(source: string): number {
    let n = 0;
    for (const [name, e] of this.#tools) {
      if (e.source === source) {
        this.#tools.delete(name);
        this.#removed.set(name, source);
        n++;
      }
    }
    return n;
  }

  /** Source of a tool that existed and was removed; undefined if it never existed or is back. */
  removedFrom(name: string): string | undefined {
    return this.#removed.get(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)?.tool;
  }

  /** Every registered tool with the source that registered it. */
  entries(): { tool: Tool; source: string }[] {
    return [...this.#tools.values()].map((e) => ({ tool: e.tool, source: e.source }));
  }

  /** Tools visible to a session: allow-list (if any) and availability check. */
  list(env: ToolEnv, allow?: readonly string[]): Tool[] {
    return [...this.#tools.values()]
      .map((e) => e.tool)
      .filter((t) => !allow || allow.includes(t.spec.name))
      .filter((t) => !t.available || t.available(env));
  }
}

/** Minimal input validation against the tool's JSON schema (required + primitive types). */
export function validateInput(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be a JSON object';
  const obj = input as Record<string, unknown>;
  if ('__invalid_json__' in obj) return 'arguments were not valid JSON';
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) if (obj[key] === undefined) return `missing required field "${key}"`;
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  for (const [key, value] of Object.entries(obj)) {
    const t = props[key]?.type;
    if (!t || value === undefined || value === null) continue;
    const types = Array.isArray(t) ? t : [t];
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some(
      (x) => x === actual || (x === 'integer' && Number.isInteger(value)) || (x === 'number' && actual === 'number'),
    );
    if (!ok) return `field "${key}" should be ${types.join(' or ')}, got ${actual}`;
  }
  return undefined;
}
