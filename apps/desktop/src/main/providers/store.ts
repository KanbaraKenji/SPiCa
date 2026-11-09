// Saved model providers (userData/providers.json). Secrets are encrypted with
// the OS user's key (Electron safeStorage = Windows DPAPI) and never leave the
// main process in clear text.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDraft, type ProviderDraft, type ProviderFields, type ProviderKind, type ProviderView, type ResolvedProvider } from '../../shared/providers';

export type { ResolvedProvider } from '../../shared/providers';

export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

interface SavedProvider extends ProviderFields {
  id: string;
  /** Encrypted secret (base64), if any. */
  secret?: string;
}

interface FileShape {
  defaultId: string | null;
  items: SavedProvider[];
}

const KINDS: ProviderKind[] = ['openai', 'anthropic', 'wso2'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function sanitizeFields(v: Record<string, unknown>): ProviderFields {
  return {
    kind: KINDS.includes(v.kind as ProviderKind) ? (v.kind as ProviderKind) : 'openai',
    name: str(v.name).trim().slice(0, 60),
    baseUrl: str(v.baseUrl).trim(),
    model: str(v.model).trim(),
    strongModel: str(v.strongModel).trim(),
    tokenUrl: str(v.tokenUrl).trim(),
    clientId: str(v.clientId).trim(),
    scope: str(v.scope).trim(),
    maxConcurrent: num(v.maxConcurrent),
    requestsPerMinute: num(v.requestsPerMinute),
  };
}

export class ProviderStore {
  readonly #file: string;
  readonly #box: SecretBox;
  /** Providers that exist outside this file (the developer's .env.local); they can be the default too. */
  readonly #external: () => string[];
  #data: FileShape = { defaultId: null, items: [] };

  constructor(dir: string, box: SecretBox, external: () => string[] = () => []) {
    this.#file = join(dir, 'providers.json');
    this.#box = box;
    this.#external = external;
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<FileShape>;
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter((x): x is SavedProvider => Boolean(x) && typeof x === 'object' && typeof (x as SavedProvider).id === 'string')
            .map((x) => ({ ...sanitizeFields(x as unknown as Record<string, unknown>), id: x.id, ...(typeof x.secret === 'string' ? { secret: x.secret } : {}) }))
        : [];
      this.#data = { defaultId: typeof raw.defaultId === 'string' ? raw.defaultId : null, items };
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  list(): ProviderView[] {
    return this.#data.items.map((p) => this.#view(p));
  }

  /** The default if it still exists; otherwise the first external one, then the first saved one. */
  defaultId(): string | null {
    const known = [...this.#external(), ...this.#data.items.map((p) => p.id)];
    const id = this.#data.defaultId;
    return id && known.includes(id) ? id : (known[0] ?? null);
  }

  /** Saves a new or existing provider. Throws a plain-language Error when it cannot. */
  save(draft: ProviderDraft): ProviderView {
    const existing = draft.id ? this.#data.items.find((p) => p.id === draft.id) : undefined;
    const errors = validateDraft(draft, Boolean(existing?.secret));
    const first = Object.values(errors)[0];
    if (first) throw new Error(first);
    const fields = sanitizeFields(draft as unknown as Record<string, unknown>);
    let secret = existing?.secret;
    const typed = draft.secret?.trim();
    if (typed) {
      if (!this.#box.available()) throw new Error('这台电脑上没法安全保存密钥，没有保存。');
      secret = this.#box.encrypt(typed);
    }
    const saved: SavedProvider = { ...fields, id: existing?.id ?? `p-${randomUUID().slice(0, 8)}`, ...(secret ? { secret } : {}) };
    this.#data.items = existing ? this.#data.items.map((p) => (p.id === saved.id ? saved : p)) : [...this.#data.items, saved];
    if (!this.defaultId()) this.#data.defaultId = saved.id;
    this.#write();
    return this.#view(saved);
  }

  remove(id: string): void {
    this.#data.items = this.#data.items.filter((p) => p.id !== id);
    if (this.#data.defaultId === id) this.#data.defaultId = null;
    this.#write();
  }

  setDefault(id: string): void {
    if (!this.#data.items.some((p) => p.id === id) && !this.#external().includes(id)) throw new Error('找不到这个模型配置。');
    this.#data.defaultId = id;
    this.#write();
  }

  /** Secret of a saved provider, decrypted (main process only). */
  secretOf(id: string): string | undefined {
    const p = this.#data.items.find((x) => x.id === id);
    if (!p?.secret) return undefined;
    try {
      return this.#box.decrypt(p.secret);
    } catch {
      return undefined;
    }
  }

  /** Everything needed to connect, for providers whose secret can be read. */
  resolved(): ResolvedProvider[] {
    const out: ResolvedProvider[] = [];
    for (const p of this.#data.items) {
      const secret = this.secretOf(p.id);
      if (!secret) continue;
      const { secret: _sealed, ...fields } = p;
      void _sealed;
      out.push({ ...fields, secret });
    }
    return out;
  }

  #view(p: SavedProvider): ProviderView {
    const { secret, ...fields } = p;
    return { ...fields, hasSecret: Boolean(secret), isDefault: this.defaultId() === p.id };
  }

  #write(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }
}
