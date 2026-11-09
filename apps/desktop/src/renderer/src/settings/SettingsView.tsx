// Settings page, shown in the main pane: 外观 and 模型 as two tabs.
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';
import { Plugins, type PluginsApi } from './Plugins';

export type SettingsTab = 'appearance' | 'models' | 'plugins';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型' },
  { id: 'plugins', label: '插件' },
];

export interface SettingsViewProps {
  shell: ShellStore;
  providers: ProvidersApi;
  plugins: PluginsApi;
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
}

export function SettingsView({ shell, providers, plugins, tab, onTab }: SettingsViewProps) {
  const { settings } = useShell(shell);
  return (
    <div className="settings">
      <div className="settings-column">
        <div className="tabs" role="tablist" aria-label="设置">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              className={tab === t.id ? 'tab is-on' : 'tab'}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'appearance' ? (
            <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
          ) : tab === 'models' ? (
            <Models api={providers} />
          ) : (
            <Plugins api={plugins} />
          )}
        </div>
      </div>
    </div>
  );
}
