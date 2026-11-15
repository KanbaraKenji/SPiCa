// What people fill into plugins' settings forms (user_config), kept by the main
// process in <userData>/plugin-config.json: by plugin, by key. Passwords are
// sealed with the OS user's key (safeStorage, like model keys) and never written
// in the clear; if sealing is not available a password is not saved at all.
// The plugin host (in the core's process) gets the values in the clear, in
// memory only (PluginConfigInput), with what the packaging's deploy.json
// presets and locks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkConfigValue, type UserConfigField, type UserConfigValue } from '@spica/plugins/user-config';
import type { SecretBox } from '../providers/store';

/** What deploy.json sets for a plugin: by key, a value and whether people may change it. Never a password (refused when read). */
export type DeployPluginConfig = Record<string, Record<string, { value: UserConfigValue; locked?: boolean }>>;

/** One plugin's settings as the host passes them on (mirrors @spica/plugins' PluginConfigInput). */
export interface PluginConfigInput {
  values: Record<string, UserConfigValue>;
  deploy?: string[];
  locked?: string[];
  source?: string;
}

type SavedValue = { v: UserConfigValue } | { sealed: string };

interface SavedPlugin {
  /** The plugin's source when last saved (sourceKey): another source does not get these passwords. */
  source: string;
  values: Record<string, SavedValue>;
}

interface FileShape {
  version: 1;
  plugins: Record<string, SavedPlugin>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isValue = (v: unknown): v is UserConfigValue => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Thrown when a value does not fit its field: by key, what to do, in the words the form shows. */
export class PluginConfigError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? '设置有误');
    this.name = 'PluginConfigError';
    this.fields = fields;
  }
}

export class PluginConfigStore {
  readonly #file: string;
  readonly #box: SecretBox;
  #data: FileShape = { version: 1, plugins: {} };

  constructor(dir: string, box: SecretBox) {
    this.#file = join(dir, 'plugin-config.json');
    this.#box = box;
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      if (!isObj(raw) || !isObj(raw.plugins)) return;
      for (const [name, p] of Object.entries(raw.plugins)) {
        if (!isObj(p) || !isObj(p.values)) continue;
        const values: Record<string, SavedValue> = {};
        for (const [k, v] of Object.entries(p.values)) {
          if (isObj(v) && typeof v.sealed === 'string' && v.sealed) values[k] = { sealed: v.sealed };
          else if (isObj(v) && isValue(v.v)) values[k] = { v: v.v };
        }
        this.#data.plugins[name] = { source: typeof p.source === 'string' ? p.source : '', values };
      }
    } catch {
      // no file yet, or unreadable: start empty
    }
  }

  /**
   * Save what the form sent for one plugin. `typed` holds only the keys the form sends: a password left empty
   * keeps the saved one, any other field left empty is cleared. Locked keys are not the person's to change.
   * Throws PluginConfigError (by key) when a value does not fit; nothing is saved then.
   */
  save(name: string, source: string, fields: readonly UserConfigField[], typed: Readonly<Record<string, unknown>>, locked: readonly string[] = []): void {
    const old = this.#data.plugins[name];
    // another source (a package of the same name from elsewhere): its passwords are not carried over
    const values: Record<string, SavedValue> = Object.fromEntries(Object.entries(old?.values ?? {}).filter(([, v]) => !(old?.source !== source && 'sealed' in v)));
    const errors: Record<string, string> = {};
    for (const f of fields) {
      if (locked.includes(f.key) || !Object.hasOwn(typed, f.key)) continue;
      const raw = typed[f.key];
      if (f.type === 'password') {
        if (raw === undefined || raw === null || raw === '') continue;
        if (typeof raw !== 'string') {
          errors[f.key] = '请输入文字';
          continue;
        }
        if (!this.#box.available()) {
          errors[f.key] = '无法加密保存密码，未保存。';
          continue;
        }
        values[f.key] = { sealed: this.#box.encrypt(raw) };
        continue;
      }
      const c = checkConfigValue(f, raw);
      if (!c.ok) errors[f.key] = c.message;
      else if (c.value === null) delete values[f.key];
      else values[f.key] = { v: c.value };
    }
    if (Object.keys(errors).length) throw new PluginConfigError(errors);
    this.#data.plugins[name] = { source, values };
    this.#write();
  }

  /** Forget one plugin's settings (cleared, or the plugin uninstalled). */
  remove(name: string): void {
    if (!this.#data.plugins[name]) return;
    delete this.#data.plugins[name];
    this.#write();
  }

  /** One plugin's settings for the host: passwords opened, the packaging's presets and locks laid over. */
  input(name: string, deploy: DeployPluginConfig = {}): PluginConfigInput | null {
    const saved = this.#data.plugins[name];
    const preset = deploy[name] ?? {};
    if (!saved && !Object.keys(preset).length) return null;
    const values: Record<string, UserConfigValue> = {};
    for (const [k, v] of Object.entries(saved?.values ?? {})) {
      if ('v' in v) values[k] = v.v;
      else {
        try {
          values[k] = this.#box.decrypt(v.sealed);
        } catch {
          // sealed on another computer or in another settings folder: as not filled in
        }
      }
    }
    const deployKeys: string[] = [];
    const locked: string[] = [];
    for (const [k, p] of Object.entries(preset)) {
      if (p.locked) {
        values[k] = p.value;
        locked.push(k);
        deployKeys.push(k);
      } else if (!Object.hasOwn(values, k)) {
        values[k] = p.value;
        deployKeys.push(k);
      }
    }
    return { values, ...(deployKeys.length ? { deploy: deployKeys } : {}), ...(locked.length ? { locked } : {}), ...(saved ? { source: saved.source } : {}) };
  }

  /** Every plugin's settings for the host at start. */
  inputs(deploy: DeployPluginConfig = {}): Record<string, PluginConfigInput> {
    const out: Record<string, PluginConfigInput> = {};
    for (const name of new Set([...Object.keys(this.#data.plugins), ...Object.keys(deploy)])) {
      const i = this.input(name, deploy);
      if (i) out[name] = i;
    }
    return out;
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }
}

/**
 * deploy.json's pluginConfig as the app reads it at start (scripts/deploy.mjs checked its shape when packaging):
 * { "<plugin>": { "<key>": { "value": …, "locked": true } } }. Anything not shaped like that is left out.
 */
export function deployPluginConfig(raw: unknown): DeployPluginConfig {
  const out: DeployPluginConfig = {};
  if (!isObj(raw)) return out;
  for (const [plugin, keys] of Object.entries(raw)) {
    if (!isObj(keys)) continue;
    for (const [k, p] of Object.entries(keys)) {
      if (!isObj(p) || !isValue(p.value)) continue;
      (out[plugin] ??= {})[k] = { value: p.value, ...(p.locked === true ? { locked: true } : {}) };
    }
  }
  return out;
}
