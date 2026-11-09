// Settings page, shown in the main pane: 外观 and 模型 as two tabs.
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';

export type SettingsTab = 'appearance' | 'models';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型' },
];

export interface SettingsViewProps {
  shell: ShellStore;
  providers: ProvidersApi;
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
}

export function SettingsView({ shell, providers, tab, onTab }: SettingsViewProps) {
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
          ) : (
            <Models api={providers} />
          )}
        </div>
      </div>
    </div>
  );
}
