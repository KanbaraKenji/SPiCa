// Persists shell settings as JSON under userData. Reads once at startup,
// writes atomically (temp file + rename) shortly after each change.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPatch, sanitizeSettings, type SettingsPatch, type ShellSettings } from '../shared/settings';

export class SettingsStore {
  readonly #file: string;
  readonly #persist: boolean;
  #value: ShellSettings;
  #timer: NodeJS.Timeout | undefined;
  #listeners = new Set<(s: ShellSettings) => void>();

  constructor(dir: string, options: { persist?: boolean } = {}) {
    this.#file = join(dir, 'settings.json');
    this.#persist = options.persist ?? true;
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      // Missing or broken file: start from defaults.
    }
    this.#value = sanitizeSettings(raw);
  }

  get(): ShellSettings {
    return structuredClone(this.#value);
  }

  update(patch: SettingsPatch): ShellSettings {
    this.#value = applyPatch(this.#value, patch);
    this.#schedule();
    const snapshot = this.get();
    for (const l of this.#listeners) l(snapshot);
    return snapshot;
  }

  onChange(listener: (s: ShellSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Writes pending changes now (call before quitting). */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#persist) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#value, null, 2), 'utf8');
      renameSync(tmp, this.#file);
    } catch {
      // Disk full or locked: keep running with the in-memory value.
    }
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 300);
  }
}
