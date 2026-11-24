// Shell settings on the renderer side: optimistic local value, persisted by main.
import { useSyncExternalStore } from 'react';
import type { DesktopBridge, ShellState } from '../../../shared/bridge';
import { applyPatch, type AutostartSupport, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import { resolveSkin, schemeOf, type Skin } from '../../../shared/skin';
import { Store } from './external';
import { applyLanguage } from '../i18n';
import { applyCodeSize, applyCodeTheme, applySkin, applyTextSize, applyUiFont } from '../theme';

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
  /** Whether 开机时启动 works in this copy (ShellState.autostart). */
  readonly autostart: AutostartSupport;
  /** 操作电脑 is there in this run (ShellState.computerUse). */
  readonly computerUse: boolean;
  /** The automatic account (ShellState.autoAccount); the one in force is effectiveAccount(settings, this). */
  readonly autoAccount: string;
  /** Windows' languages (ShellState.systemLanguages), for 语言 跟随系统. */
  readonly systemLanguages: readonly string[];

  constructor(bridge: DesktopBridge, initial: ShellState) {
    this.#bridge = bridge;
    this.demo = initial.demo;
    this.legacyDefaultCwd = initial.legacyDefaultCwd;
    this.autostart = initial.autostart ?? 'unsupported';
    this.computerUse = initial.computerUse === true;
    this.autoAccount = initial.autoAccount ?? '';
    this.systemLanguages = initial.systemLanguages ?? [];
    // The language first: the first paint is already in it.
    applyLanguage(initial.settings.language, this.systemLanguages);
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
    // Switched before the redraw the state change causes, so every t() in it reads the new language.
    if (patch.language) applyLanguage(patch.language, this.systemLanguages);
    this.state.set((v) => ({ ...v, settings: applyPatch(v.settings, patch) }));
    this.#paint();
    void this.#bridge.updateSettings(patch).catch(() => {
      // Main keeps the source of truth; the next settings event corrects us.
    });
  }

  #replace(settings: ShellSettings): void {
    applyLanguage(settings.language, this.systemLanguages);
    this.state.set((v) => ({ ...v, settings }));
    this.#paint();
  }

  #paint(): void {
    const skin = this.activeSkin();
    applySkin(skin);
    applyCodeTheme(this.state.get().settings.codeTheme, schemeOf(skin.bg));
    applyCodeSize(this.state.get().settings.codeSize);
    applyTextSize(this.state.get().settings.textSize);
    applyUiFont(this.state.get().settings.uiFont);
  }
}

export function useShell(store: ShellStore): ShellView {
  return useSyncExternalStore(store.state.subscribe, store.state.get);
}
