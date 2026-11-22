// The MCP services the person adds (设置 › 插件 › MCP 服务), kept in <userData>/mcp-servers.json. The values of
// their environment variables, a web address's key and its other headers are sealed with the same box as model keys and plugin passwords (safeStorage); the
// file holds only the sealed text and the characters a mask may show. The backend gets the list in the clear,
// in memory, when it starts and after each change; the settings page only ever sees masks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
import type { SecretBox } from '../providers/store';
import { draftArgs, keyOf, MCP_NAME, mcpDraftErrors, type McpApproval, type McpEnvDraft, type McpFieldErrors, type McpServerDraft } from '../../shared/mcp-servers';
import { t } from '../../shared/i18n';

/** A variable as saved: sealed, and what its mask may show. */
interface SavedEnv {
  name: string;
  sealed: string;
  head: string;
  tail: string;
}

/** A sealed value and what its mask may show. */
type Sealed = Omit<SavedEnv, 'name'>;

export interface SavedMcpServer {
  name: string;
  /** A server at a web address (command and args empty then). */
  url?: string;
  /** With url: the key, sent as Authorization: Bearer. */
  key?: Sealed;
  /** With url: other request headers. */
  headers?: SavedEnv[];
  command: string;
  args: string[];
  env: SavedEnv[];
  cwd?: string;
  enabled: boolean;
  approval: McpApproval;
}

interface FileShape {
  version: 1;
  servers: SavedMcpServer[];
}

/** One service for the backend (UserMcpConfig of @spica/plugins), values in the clear. */
export interface McpServerConfig {
  name: string;
  /** A server at a web address, with its headers (the key as Authorization: Bearer). */
  url?: string;
  headers?: Record<string, string>;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  approval: McpApproval;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const isSealed = (e: unknown): e is Sealed => isObj(e) && typeof e.sealed === 'string' && typeof e.head === 'string' && typeof e.tail === 'string';
const savedRows = (v: unknown): SavedEnv[] => (Array.isArray(v) ? v : []).filter((e): e is SavedEnv => isSealed(e) && typeof (e as { name?: unknown }).name === 'string');

function readServer(v: unknown): SavedMcpServer | null {
  if (!isObj(v) || typeof v.name !== 'string' || !MCP_NAME.test(v.name) || typeof v.command !== 'string') return null;
  const env = savedRows(v.env);
  const url = typeof v.url === 'string' && v.url ? v.url : undefined;
  return {
    name: v.name,
    ...(url ? { url, headers: savedRows(v.headers), ...(isSealed(v.key) ? { key: { sealed: v.key.sealed, head: v.key.head, tail: v.key.tail } } : {}) } : {}),
    command: v.command,
    args: strings(v.args),
    env,
    ...(typeof v.cwd === 'string' && v.cwd ? { cwd: v.cwd } : {}),
    enabled: v.enabled !== false,
    approval: v.approval === 'auto' ? 'auto' : 'ask',
  };
}

export class McpServerStore {
  readonly #file: string;
  readonly #box: SecretBox;
  #data: FileShape = { version: 1, servers: [] };

  constructor(dir: string, box: SecretBox) {
    this.#file = join(dir, 'mcp-servers.json');
    this.#box = box;
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      if (isObj(raw) && Array.isArray(raw.servers)) this.#data = { version: 1, servers: raw.servers.map(readServer).filter((s): s is SavedMcpServer => s !== null) };
    } catch {
      // none yet, or unreadable: an empty list
    }
  }

  /** The services as saved, in their order. */
  list(): SavedMcpServer[] {
    return this.#data.servers.map((s) => ({ ...s, args: [...s.args], env: s.env.map((e) => ({ ...e })), ...(s.headers ? { headers: s.headers.map((h) => ({ ...h })) } : {}) }));
  }

  /** How a saved variable's value is shown. */
  static mask(e: Sealed): string {
    return keyMaskText({ head: e.head, tail: e.tail });
  }

  /**
   * Saves a new service (`was` null) or the one called `was`. A variable left empty keeps its saved value (if it
   * kept its name). What is wrong is returned by field (nothing saved then); {} when saved.
   */
  save(was: string | null, draft: McpServerDraft, taken: readonly string[]): McpFieldErrors & { ''?: string } {
    const others = [...taken, ...this.#data.servers.filter((s) => s.name !== was).map((s) => s.name)];
    const errors: McpFieldErrors & { ''?: string } = mcpDraftErrors(draft, others);
    const old = was === null ? undefined : this.#data.servers.find((s) => s.name === was);
    if (was !== null && !old) errors[''] = t('该服务已不存在');
    const web = draft.kind === 'url';
    // a value left empty keeps the saved one (if the row kept its name); a new one is sealed
    const seal = (value: string): Sealed | undefined => {
      if (!this.#box.available()) {
        errors[''] = web ? t('此电脑无法加密保存，密钥未保存') : t('此电脑无法加密保存，环境变量未保存');
        return undefined;
      }
      const parts = keyMaskParts(value);
      return { sealed: this.#box.encrypt(value), head: parts.head, tail: parts.tail };
    };
    const rows = (drafts: McpEnvDraft[], saved: SavedEnv[] | undefined, field: 'env' | 'headers', missing: (name: string) => string): SavedEnv[] => {
      const out: SavedEnv[] = [];
      for (const row of drafts) {
        const name = row.name.trim();
        if (!name) continue;
        const value = row.value ?? '';
        const kept = row.saved && !value ? saved?.find((e) => e.name === name) : undefined;
        if (kept) {
          out.push(kept);
          continue;
        }
        if (!value) {
          errors[field] ??= missing(name);
          continue;
        }
        const sealed = seal(value);
        if (sealed) out.push({ name, ...sealed });
      }
      return out;
    };
    const env = web ? [] : rows(draft.env, old?.env, 'env', (name) => t('环境变量「{name}」没有值', { name }));
    const headers = web ? rows(draft.headers, old?.headers, 'headers', (name) => t('请求头「{name}」没有值', { name })) : [];
    const typedKey = keyOf(draft.key);
    const key = !web ? undefined : typedKey ? seal(typedKey) : draft.keySaved ? old?.key : undefined;
    if (Object.keys(errors).length) return errors;
    const cwd = draft.cwd.trim();
    const next: SavedMcpServer = {
      name: draft.name.trim(),
      ...(web ? { url: draft.url.trim(), headers, ...(key ? { key } : {}) } : {}),
      command: web ? '' : draft.command.trim(),
      args: web ? [] : draftArgs(draft),
      env,
      ...(cwd && !web ? { cwd } : {}),
      enabled: old?.enabled ?? true,
      approval: draft.approval,
    };
    this.#data.servers = old ? this.#data.servers.map((s) => (s === old ? next : s)) : [...this.#data.servers, next];
    this.#write();
    return {};
  }

  remove(name: string): void {
    this.#data.servers = this.#data.servers.filter((s) => s.name !== name);
    this.#write();
  }

  update(name: string, patch: Partial<Pick<SavedMcpServer, 'enabled' | 'approval'>>): void {
    this.#data.servers = this.#data.servers.map((s) => (s.name === name ? { ...s, ...patch } : s));
    this.#write();
  }

  /** The list for the backend, values opened (a value sealed elsewhere, e.g. another user, is left out). */
  configs(): McpServerConfig[] {
    const open = (rows: readonly SavedEnv[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const e of rows) {
        try {
          out[e.name] = this.#box.decrypt(e.sealed);
        } catch {
          // sealed on another computer or account: not opened
        }
      }
      return out;
    };
    return this.#data.servers.map((s) => {
      const env = open(s.env);
      let headers: Record<string, string> | undefined;
      if (s.url) {
        headers = open(s.headers ?? []);
        if (s.key) {
          try {
            headers.Authorization = `Bearer ${this.#box.decrypt(s.key.sealed)}`;
          } catch {
            // sealed elsewhere: not opened (the server will say a key is needed)
          }
        }
      }
      return {
        name: s.name,
        ...(s.url ? { url: s.url, headers: headers ?? {} } : {}),
        command: s.command,
        args: [...s.args],
        env,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        enabled: s.enabled,
        approval: s.approval,
      };
    });
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }
}
