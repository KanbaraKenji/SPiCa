// Saved model connections (userData/providers.json). A connection is one
// provider with one key and the models ticked under it; two pointers say which
// model new conversations use and which one does heavy work. Keys are encrypted
// with the OS user's key (Electron safeStorage = Windows DPAPI) and never leave
// the main process in clear text.
//
// File versions: 1 (until 2026-11-10) held one model per entry (model,
// strongModel, contextWindow, secret, defaultId); it is read and rewritten as 2.
import { runLimit } from '../../shared/settings';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  enabledModels,
  legacyModelFields,
  modelsOfDraft,
  validateDraft,
  DEV_CONNECTION_NAMES,
  type ConnectionModel,
  type ContextFrom,
  type ModelRef,
  type ProviderDraft,
  type ProviderKind,
  type ProviderView,
  type ResolvedProvider,
} from '../../shared/providers';

export type { ResolvedProvider } from '../../shared/providers';

export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/** A key as saved: sealed, and only the characters that may be shown (keyMaskParts). A list, so one connection may hold several later. */
interface SavedKey {
  sealed: string;
  tail: string;
  head?: string;
}

interface SavedConnection {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  maxConcurrent: number | null;
  requestsPerMinute: number | null;
  catalogId: string | null;
  models: ConnectionModel[];
  keys: SavedKey[];
}

interface FileShape {
  version: 2;
  items: SavedConnection[];
  default: ModelRef | null;
  strong: ModelRef | null;
}

/** A connection that lives outside this file (the developer's .env.local): its id and models, for the pointers. */
export interface ExternalConnection {
  id: string;
  models: string[];
}

const KINDS: ProviderKind[] = ['openai', 'anthropic', 'wso2'];
const FROM: ContextFrom[] = ['user', 'catalog', 'provider', 'name-match'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function sanitizeModels(v: unknown): ConnectionModel[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ConnectionModel[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const id = str(r.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const maxOutput = num(r.maxOutput);
    const limit = runLimit(r.runLimitUsd);
    out.push({ id, contextWindow: num(r.contextWindow), contextFrom: FROM.includes(r.contextFrom as ContextFrom) ? (r.contextFrom as ContextFrom) : 'user', ...(maxOutput ? { maxOutput } : {}), ...(r.enabled === false ? { enabled: false } : {}), ...(limit !== null ? { runLimitUsd: limit } : {}) });
  }
  return out;
}

function sanitizeRef(v: unknown): ModelRef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const connectionId = str(r.connectionId);
  const model = str(r.model);
  return connectionId && model ? { connectionId, model } : null;
}

/** The fields every version shares (no models, no key). */
function baseFields(v: Record<string, unknown>) {
  return {
    kind: KINDS.includes(v.kind as ProviderKind) ? (v.kind as ProviderKind) : ('openai' as ProviderKind),
    name: str(v.name).trim().slice(0, 60),
    baseUrl: str(v.baseUrl).trim(),
    tokenUrl: str(v.tokenUrl).trim(),
    clientId: str(v.clientId).trim(),
    scope: str(v.scope).trim(),
    maxConcurrent: num(v.maxConcurrent),
    requestsPerMinute: num(v.requestsPerMinute),
    catalogId: str(v.catalogId).trim() || null,
  };
}

export class ProviderStore {
  readonly #file: string;
  readonly #box: SecretBox;
  /** Connections outside this file (the developer's .env.local); the pointers may point at them too. */
  readonly #external: () => ExternalConnection[];
  #data: FileShape = { version: 2, items: [], default: null, strong: null };

  constructor(dir: string, box: SecretBox, external: () => ExternalConnection[] = () => []) {
    this.#file = join(dir, 'providers.json');
    this.#box = box;
    this.#external = external;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Record<string, unknown>;
    } catch {
      return; // No file yet, or unreadable: start empty.
    }
    const list = Array.isArray(raw.items) ? (raw.items as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') : [];
    if (raw.version === 2) {
      this.#data = {
        version: 2,
        items: list.map((x) => ({
          ...baseFields(x),
          id: x.id as string,
          models: sanitizeModels(x.models),
          // Saved before the first characters were kept: worked out once from the key.
          keys: Array.isArray(x.keys) ? (x.keys as SavedKey[]).filter((k) => k && typeof k.sealed === 'string').map((k) => (typeof k.head === 'string' ? { sealed: k.sealed, tail: str(k.tail), head: k.head } : { sealed: k.sealed, ...this.#partsOfSealed(k.sealed, x.id as string) })) : [],
        })),
        default: sanitizeRef(raw.default),
        strong: sanitizeRef(raw.strong),
      };
      return;
    }
    // Version 1: one entry per model (plus a strong one); the default by entry.
    const items = list.map((x): SavedConnection => {
      const model = str(x.model).trim();
      const strong = str(x.strongModel).trim();
      const models: ConnectionModel[] = [];
      if (model) models.push({ id: model, contextWindow: num(x.contextWindow), contextFrom: 'user' });
      if (strong && strong !== model) models.push({ id: strong, contextWindow: null, contextFrom: 'user' });
      const sealed = typeof x.secret === 'string' ? x.secret : '';
      return { ...baseFields(x), id: x.id as string, models, keys: sealed ? [{ sealed, ...this.#partsOfSealed(sealed, x.id as string) }] : [] };
    });
    const defId = typeof raw.defaultId === 'string' ? raw.defaultId : null;
    const def = items.find((p) => p.id === defId);
    this.#data = {
      version: 2,
      items,
      default: def?.models[0] ? { connectionId: def.id, model: def.models[0].id } : null,
      strong: def?.models[1] ? { connectionId: def.id, model: def.models[1].id } : null,
    };
    // An old default on an outside connection (.env.local) keeps pointing there.
    if (!def && defId) {
      const ext = this.#external().find((e) => e.id === defId);
      if (ext?.models[0]) this.#data.default = { connectionId: defId, model: ext.models[0] };
      if (ext?.models[1]) this.#data.strong = { connectionId: defId, model: ext.models[1] };
    }
    this.#write();
  }

  /**
   * The characters a key may show, worked out from its sealed form. Before the app is ready the OS key store
   * cannot be used (Electron's safeStorage on Windows): then nothing is shown for now, it is said in the log
   * (without the key), and fillKeyMasks() works it out once the app is ready.
   */
  #partsOfSealed(sealed: string, id = ''): { head: string; tail: string } {
    try {
      return keyMaskParts(this.#box.decrypt(sealed));
    } catch (err) {
      console.warn(`[spica] providers: the saved key${id ? ` of ${id}` : ''} could not be read to show its first and last characters (${err instanceof Error ? err.message : 'unknown error'}); tried again once the app is ready`);
      return { head: '', tail: '' };
    }
  }

  /**
   * Keys saved without the characters they may show (moved from version 1 before the app was ready, or saved
   * by a version that did not keep them): worked out now and written back. Call once the app is ready; a key
   * too short to show anything is simply worked out again next time. Returns how many were filled in.
   */
  fillKeyMasks(): number {
    let filled = 0;
    for (const p of this.#data.items) {
      for (const k of p.keys) {
        if (!k.sealed || k.head || k.tail) continue;
        const parts = this.#partsOfSealed(k.sealed, p.id);
        if (!parts.head && !parts.tail) continue;
        k.head = parts.head;
        k.tail = parts.tail;
        filled++;
      }
    }
    if (filled) this.#write();
    return filled;
  }

  /** Every connection with the models it has, saved ones and outside ones. */
  #known(): ExternalConnection[] {
    // Only models in use count for the pointers (one unchecked is not there).
    return [...this.#external(), ...this.#data.items.map((p) => ({ id: p.id, models: enabledModels(p.models).map((m) => m.id) }))];
  }

  #valid(ref: ModelRef | null): boolean {
    return Boolean(ref && this.#known().some((c) => c.id === ref.connectionId && c.models.includes(ref.model)));
  }

  /** The model new conversations use: as set if it still exists, else the first model there is. */
  defaultRef(): ModelRef | null {
    if (this.#data.default && this.#valid(this.#data.default)) return this.#data.default;
    const first = this.#known().find((c) => c.models.length);
    return first ? { connectionId: first.id, model: first.models[0]! } : null;
  }

  /** The model for heavy work, if set and still there. */
  strongRef(): ModelRef | null {
    return this.#data.strong && this.#valid(this.#data.strong) ? this.#data.strong : null;
  }

  /** The connection holding the default model (the one-model form's 「默认」). */
  defaultId(): string | null {
    return this.defaultRef()?.connectionId ?? null;
  }

  list(): ProviderView[] {
    return this.#data.items.map((p) => this.#view(p));
  }

  /**
   * Saves a new or existing connection. Throws a plain-language Error when it
   * cannot. A pointer whose model was unticked moves (see #repoint).
   */
  save(draft: ProviderDraft, opts: { needsKey?: boolean } = {}): ProviderView {
    const existing = draft.id ? this.#data.items.find((p) => p.id === draft.id) : undefined;
    // The name must not be another connection's (saved here, or one of those read from .env.local).
    const otherNames = [...this.#data.items.filter((p) => p.id !== draft.id).map((p) => p.name), ...DEV_CONNECTION_NAMES];
    const errors = validateDraft(draft, existing ? existing.keys.length > 0 : false, { ...opts, otherNames });
    const first = Object.values(errors)[0];
    if (first) throw new Error(first);
    let keys = existing?.keys ?? [];
    const typed = draft.secret?.trim();
    if (typed) {
      if (!this.#box.available()) throw new Error('无法加密保存密钥，未保存。');
      keys = [{ sealed: this.#box.encrypt(typed), ...keyMaskParts(typed) }];
    }
    const saved: SavedConnection = {
      ...baseFields(draft as unknown as Record<string, unknown>),
      id: existing?.id ?? `p-${randomUUID().slice(0, 8)}`,
      models: modelsOfDraft(draft, existing?.models),
      keys,
    };
    this.#data.items = existing ? this.#data.items.map((p) => (p.id === saved.id ? saved : p)) : [...this.#data.items, saved];
    this.#repoint();
    this.#write();
    return this.#view(saved);
  }

  /**
   * The 单次运行花费上限 that was one value for every model before it moved to each model: every model in use that
   * has none of its own gets it (once, when the app starts; the settings then forget the old value). Returns whether
   * anything changed.
   */
  adoptRunLimit(usd: number): boolean {
    let changed = false;
    this.#data.items = this.#data.items.map((p) => ({
      ...p,
      models: p.models.map((m) => {
        if (m.enabled === false || m.runLimitUsd !== undefined) return m;
        changed = true;
        return { ...m, runLimitUsd: usd };
      }),
    }));
    if (changed) this.#write();
    return changed;
  }

  remove(id: string): void {
    this.#data.items = this.#data.items.filter((p) => p.id !== id);
    this.#repoint();
    this.#write();
  }

  /** Makes this connection's first model the default (the one-model form's 「设为默认」). */
  setDefault(id: string): void {
    const c = this.#known().find((x) => x.id === id);
    if (!c) throw new Error('找不到该模型配置。');
    if (!c.models[0]) throw new Error('该服务商未选择模型。');
    this.setDefaultModel({ connectionId: id, model: c.models[0] });
  }

  setDefaultModel(ref: ModelRef): void {
    if (!this.#valid(ref)) throw new Error('找不到该模型。');
    this.#data.default = { ...ref };
    this.#write();
  }

  /** The model for heavy work; null: none. */
  setStrongModel(ref: ModelRef | null): void {
    if (ref && !this.#valid(ref)) throw new Error('找不到该模型。');
    this.#data.strong = ref ? { ...ref } : null;
    this.#write();
  }

  /**
   * A pointer whose model is gone moves to the first model left on the same
   * connection, then to the first anywhere; the strong one is dropped instead
   * of moving to another connection. Like deleting the default entry did.
   */
  #repoint(): void {
    const known = this.#known();
    const move = (ref: ModelRef | null, anywhere: boolean): ModelRef | null => {
      if (!ref || this.#valid(ref)) return ref;
      const same = known.find((c) => c.id === ref.connectionId && c.models.length);
      if (same) return { connectionId: same.id, model: same.models[0]! };
      if (!anywhere) return null;
      const other = known.find((c) => c.models.length);
      return other ? { connectionId: other.id, model: other.models[0]! } : null;
    };
    this.#data.default = move(this.#data.default, true);
    this.#data.strong = move(this.#data.strong, false);
    if (!this.#data.default) {
      const first = known.find((c) => c.models.length);
      if (first) this.#data.default = { connectionId: first.id, model: first.models[0]! };
    }
  }

  /** The key of a saved connection, decrypted (main process only). */
  secretOf(id: string): string | undefined {
    const p = this.#data.items.find((x) => x.id === id);
    const sealed = p?.keys[0]?.sealed;
    if (!sealed) return undefined;
    try {
      return this.#box.decrypt(sealed);
    } catch {
      return undefined;
    }
  }

  /**
   * Connections with a saved key this Windows user cannot open here (the key was sealed in another settings
   * folder or on another computer: the sealing key lives in that folder's Local State). They are left out of
   * resolved(), so the page has to say why. Call once the app is ready.
   */
  unreadableKeys(): string[] {
    return this.#data.items.filter((p) => p.keys[0]?.sealed && this.secretOf(p.id) === undefined).map((p) => p.id);
  }

  /** Everything needed to connect. Without a key only when `needsKey` says the provider takes none. */
  resolved(needsKey: (catalogId: string | null) => boolean = () => true): ResolvedProvider[] {
    const out: ResolvedProvider[] = [];
    for (const p of this.#data.items) {
      const secret = this.secretOf(p.id);
      if (!secret && needsKey(p.catalogId)) continue;
      const { keys: _keys, ...fields } = p;
      void _keys;
      // The core gets only the models in use.
      out.push({ ...fields, models: enabledModels(p.models), ...legacyModelFields(p.models), secret: secret ?? '' });
    }
    return out;
  }

  #view(p: SavedConnection): ProviderView {
    const { keys, ...fields } = p;
    return {
      ...fields,
      ...legacyModelFields(p.models),
      hasSecret: keys.length > 0,
      keyMask: keys[0] ? keyMaskText({ head: keys[0].head ?? '', tail: keys[0].tail }) : null,
      isDefault: this.defaultId() === p.id,
    };
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }
}
