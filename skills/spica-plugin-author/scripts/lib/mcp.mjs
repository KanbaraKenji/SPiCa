// Tiny MCP clients (no dependencies): stdio (newline-delimited JSON-RPC over a
// child process, no console window, no shell) and Spica's HTTP transport
// (POST one JSON-RPC message, bearer token).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL = '2025-06-18';

/**
 * The host variables Spica lets plugin servers inherit (same list as
 * PLUGIN_INHERIT_ENV in @spica/plugins). Starting servers with only these
 * makes a plugin that needs anything else fail here, not after install.
 */
export const PLUGIN_INHERIT_ENV = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'COMPUTERNAME', 'USERNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

/** process.env reduced to the whitelist, plus `extra`. */
export function pluginEnv(extra = {}) {
  const env = {};
  for (const k of PLUGIN_INHERIT_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}
const CLIENT = { name: 'spica-plugin-author', version: '0.1.0' };
/** The longest one tool call may run even while reporting progress (Spica's default for max_call_seconds). */
const MAX_CALL_MS = 60 * 60_000;
/** Node fires a longer setTimeout after 1 ms, so a huge limit is held to this (about 24 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Text of a tools/call result; JSON is parsed when it looks like JSON. */
export function resultValue(result) {
  const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (result?.isError) {
    const err = new Error(text || 'tool failed');
    err.toolError = true;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class Base {
  #id = 0;
  nextId() {
    return ++this.#id;
  }
  async initialize() {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    await this.notify('notifications/initialized');
    return r;
  }
  async listTools() {
    return (await this.request('tools/list', {})).tools ?? [];
  }
  /** Raw tools/call result ({ content, isError }). */
  callToolRaw(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }
  /** Parsed value; throws on isError. */
  async call(name, args = {}, timeoutMs) {
    return resultValue(await this.callToolRaw(name, args, timeoutMs));
  }
}

export class StdioClient extends Base {
  #child;
  #pending = new Map();
  #stderr = [];
  #exited = null;

  /** @param {{ command: string, args?: string[], env?: Record<string,string>, cwd?: string, timeoutMs?: number, maxCallMs?: number }} o */
  constructor(o) {
    super();
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.maxCallMs = o.maxCallMs ?? MAX_CALL_MS;
    this.#child = spawn(o.command, o.args ?? [], {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.#child.on('error', (err) => this.#fail(err));
    this.#child.on('exit', (code) => {
      this.#exited = code ?? -1;
      this.#fail(new Error(`进程退出了（代码 ${code}）${this.stderrTail() ? `：\n${this.stderrTail()}` : ''}`));
    });
    createInterface({ input: this.#child.stderr }).on('line', (l) => {
      this.#stderr.push(l);
      if (this.#stderr.length > 40) this.#stderr.shift();
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#stderr.push(`[stdout 不是协议消息] ${line.slice(0, 200)}`);
        return;
      }
      // progress for a running tool call restarts its wait (as in Spica)
      if (msg.method === 'notifications/progress') return this.#pending.get(msg.params?.progressToken)?.touch?.();
      const p = msg.id !== undefined && !msg.method ? this.#pending.get(msg.id) : undefined;
      if (!p) return; // unknown, or late: the request already timed out
      this.#pending.delete(msg.id);
      p.clear();
      if (msg.error) p.reject(new Error(`${msg.error.message ?? 'error'}${msg.error.code ? ` (${msg.error.code})` : ''}`));
      else p.resolve(msg.result);
    });
  }

  stderrTail() {
    return this.#stderr.slice(-10).join('\n');
  }

  #fail(err) {
    for (const p of this.#pending.values()) {
      p.clear();
      p.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * Like Spica: a tool call carries a progress token, each progress report
   * restarts the wait (up to maxCallMs in all), and a request that times
   * out is cancelled at the server (never initialize).
   */
  request(method, params, wait = this.timeoutMs) {
    const timeoutMs = Math.min(wait, MAX_TIMER_MS);
    if (this.#exited !== null) return Promise.reject(new Error(`进程已经退出（代码 ${this.#exited}）：\n${this.stderrTail()}`));
    const id = this.nextId();
    const progress = method === 'tools/call';
    const sent = progress ? { ...params, _meta: { ...(params?._meta ?? {}), progressToken: id } } : params;
    const overallMs = Math.min(Math.max(this.maxCallMs, timeoutMs), MAX_TIMER_MS);
    return new Promise((resolve, reject) => {
      const giveUp = (message) => {
        const p = this.#pending.get(id);
        if (!p) return;
        p.clear();
        this.#pending.delete(id);
        if (method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: 'timed out' });
        reject(new Error(message));
      };
      const idle = () => setTimeout(() => giveUp(`${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应${progress ? '，也没有报进度' : ''}`), timeoutMs);
      const p = {
        resolve,
        reject,
        timer: idle(),
        overall: setTimeout(() => giveUp(`${method} 超过 ${Math.round(overallMs / 1000)} 秒还没做完（一次调用的上限）`), overallMs),
        clear() {
          clearTimeout(p.timer);
          clearTimeout(p.overall);
        },
        ...(progress
          ? {
              touch() {
                clearTimeout(p.timer);
                p.timer = idle();
              },
            }
          : {}),
      };
      this.#pending.set(id, p);
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: sent })}\n`);
    });
  }

  async notify(method, params) {
    if (this.#exited === null) this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  /** Close stdin, then wait for the process to end (kill after 5 s). */
  async close() {
    if (this.#exited !== null) return;
    const done = new Promise((r) => this.#child.once('exit', r));
    this.#child.stdin.end();
    const t = setTimeout(() => this.#child.kill(), 5000);
    await done;
    clearTimeout(t);
  }
}

export class HttpClient extends Base {
  /** @param {{ url: string, token: string, timeoutMs?: number }} o */
  constructor(o) {
    super();
    this.url = o.url;
    this.token = o.token;
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  async #post(body, timeoutMs) {
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`连不上 ${this.url}：${err?.cause?.code ?? err?.name ?? err}。Spica 开着吗？地址和端口对吗？`, { cause: err });
    }
    if (res.status === 401) throw new Error('令牌不对（401）。请重新拿一次令牌文件。');
    if (res.status === 403) throw new Error('Spica 拒绝了这个请求（403）：只听本机时，只能从本机连。');
    if (res.status === 202) return undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    const msg = await this.#post({ jsonrpc: '2.0', id: this.nextId(), method, params }, timeoutMs);
    if (msg?.error) throw new Error(`${msg.error.message ?? 'error'}${msg.error.code ? ` (${msg.error.code})` : ''}`);
    return msg?.result;
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, this.timeoutMs);
  }

  async close() {}
}
