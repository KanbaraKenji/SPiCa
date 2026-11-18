// The MCP services the person adds (设置 › 插件 › MCP 服务), kept in <userData>/mcp-servers.json. The values of
// their environment variables are sealed with the same box as model keys and plugin passwords (safeStorage); the
// file holds only the sealed text and the characters a mask may show. The backend gets the list in the clear,
// in memory, when it starts and after each change; the settings page only ever sees masks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
import type { SecretBox } from '../providers/store';
import { draftArgs, MCP_NAME, mcpDraftErrors, type McpApproval, type McpFieldErrors, type McpServerDraft } from '../../shared/mcp-servers';
import { t } from '../../shared/i18n';

/** A variable as saved: sealed, and what its mask may show. */
interface SavedEnv {
  name: string;
  sealed: string;
  head: string;
  tail: string;
}

export interface SavedMcpServer {
  name: string;
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
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  approval: McpApproval;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function readServer(v: unknown): SavedMcpServer | null {
  if (!isObj(v) || typeof v.name !== 'string' || !MCP_NAME.test(v.name) || typeof v.command !== 'string') return null;
  const env = (Array.isArray(v.env) ? v.env : []).filter(
    (e): e is SavedEnv => isObj(e) && typeof e.name === 'string' && typeof e.sealed === 'string' && typeof e.head === 'string' && typeof e.tail === 'string',
  );
  return {
    name: v.name,
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
    return this.#data.servers.map((s) => ({ ...s, args: [...s.args], env: s.env.map((e) => ({ ...e })) }));
  }

  /** How a saved variable's value is shown. */
  static mask(e: SavedEnv): string {
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
    const env: SavedEnv[] = [];
    for (const row of draft.env) {
      const name = row.name.trim();
      if (!name) continue;
      const value = row.value ?? '';
      const kept = row.saved && !value ? old?.env.find((e) => e.name === name) : undefined;
      if (kept) {
        env.push(kept);
        continue;
      }
      if (!value) {
        errors.env ??= t('环境变量「{name}」没有值', { name });
        continue;
      }
      if (!this.#box.available()) {
        errors[''] = t('此电脑无法加密保存，环境变量未保存');
        continue;
      }
      const parts = keyMaskParts(value);
      env.push({ name, sealed: this.#box.encrypt(value), head: parts.head, tail: parts.tail });
    }
    if (Object.keys(errors).length) return errors;
    const cwd = draft.cwd.trim();
    const next: SavedMcpServer = {
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: draftArgs(draft),
      env,
      ...(cwd ? { cwd } : {}),
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
    return this.#data.servers.map((s) => {
      const env: Record<string, string> = {};
      for (const e of s.env) {
        try {
          env[e.name] = this.#box.decrypt(e.sealed);
        } catch {
          // sealed on another computer or account: not opened
        }
      }
      return { name: s.name, command: s.command, args: [...s.args], env, ...(s.cwd ? { cwd: s.cwd } : {}), enabled: s.enabled, approval: s.approval };
    });
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }
}
