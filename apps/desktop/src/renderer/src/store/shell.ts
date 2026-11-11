// Shell settings on the renderer side: optimistic local value, persisted by main.
import { useSyncExternalStore } from 'react';
import type { DesktopBridge, ShellState } from '../../../shared/bridge';
import { applyPatch, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import { resolveSkin, schemeOf, type Skin } from '../../../shared/skin';
import { Store } from './external';
import { applyCodeTheme, applySkin } from '../theme';

export interface ShellView {
  settings: ShellSettings;
  systemDark: boolean;
}

export class ShellStore {
  readonly state: Store<ShellView>;
  readonly #bridge: DesktopBridge;
  /** No model configured: the conversation runs on demo data. */
  readonly demo: boolean;
  /** The folder conversations shared up to 0.1.0-rc.2 (ShellState.legacyDefaultCwd). */
  readonly legacyDefaultCwd: string | undefined;

  constructor(bridge: DesktopBridge, initial: ShellState) {
    this.#bridge = bridge;
    this.demo = initial.demo;
    this.legacyDefaultCwd = initial.legacyDefaultCwd;
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : initial.systemDark;
    this.state = new Store<ShellView>({ settings: initial.settings, systemDark: media });
    bridge.onSettingsChanged((settings) => this.#replace(settings));
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        // While the skin follows the system, main sets themeSource to 'system',
        // so this query reports the OS setting.
        this.state.set((v) => ({ ...v, systemDark: e.matches }));
        this.#paint();
      });
    }
    this.#paint();
  }

  get settings(): ShellSettings {
    return this.state.get().settings;
  }

  activeSkin(): Skin {
    const { settings, systemDark } = this.state.get();
    return resolveSkin(settings.skin, systemDark, settings.customSkins);
  }

  update(patch: SettingsPatch): void {
    this.state.set((v) => ({ ...v, settings: applyPatch(v.settings, patch) }));
    this.#paint();
    void this.#bridge.updateSettings(patch).catch(() => {
      // Main keeps the source of truth; the next settings event corrects us.
    });
  }

  #replace(settings: ShellSettings): void {
    this.state.set((v) => ({ ...v, settings }));
    this.#paint();
  }

  #paint(): void {
    const skin = this.activeSkin();
    applySkin(skin);
    applyCodeTheme(this.state.get().settings.codeTheme, schemeOf(skin.bg));
  }
}

export function useShell(store: ShellStore): ShellView {
  return useSyncExternalStore(store.state.subscribe, store.state.get);
}
