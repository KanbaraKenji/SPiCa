// Settings page, shown in the main pane: 常规 / 外观 / 模型 / 插件 / 关于 as tabs.
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';
import { Plugins, type PluginsApi } from './Plugins';
import { About } from './About';
import { General, type GeneralProps, type WorkflowsApi } from './General';
import type { UpdateState } from '../../../shared/updates';

export type SettingsTab = 'general' | 'appearance' | 'models' | 'plugins' | 'about';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型' },
  { id: 'plugins', label: '插件' },
  { id: 'about', label: '关于' },
];

export interface SettingsViewProps {
  shell: ShellStore;
  providers: ProvidersApi;
  plugins: PluginsApi;
  version: string;
  update: UpdateState | null;
  onCheckUpdate(): void;
  onInstallUpdate(): void;
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
  workflows: WorkflowsApi;
  pickFolder(): Promise<string | null>;
  onBackendRestarted(listener: () => void): () => void;
  projects: GeneralProps['projects'];
  exportUsageLog: GeneralProps['exportUsageLog'];
  showInFolder: GeneralProps['showInFolder'];
  mailModel?: string;
}

export function SettingsView({ shell, providers, plugins, version, update, onCheckUpdate, onInstallUpdate, tab, onTab, workflows, pickFolder, onBackendRestarted, projects, exportUsageLog, showInFolder, mailModel }: SettingsViewProps) {
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
          {tab === 'general' ? (
            <General
              settings={settings}
              onChange={(p) => shell.update(p)}
              workflows={workflows}
              pickFolder={pickFolder}
              onBackendRestarted={onBackendRestarted}
              projects={projects}
              exportUsageLog={exportUsageLog}
              showInFolder={showInFolder}
              {...(mailModel ? { mailModel } : {})}
            />
          ) : tab === 'appearance' ? (
            <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
          ) : tab === 'models' ? (
            <Models api={providers} />
          ) : tab === 'plugins' ? (
            <Plugins api={plugins} />
          ) : (
            <About
              version={version}
              update={update}
              ownSource={settings.updateSource}
              onSource={(updateSource) => shell.update({ updateSource })}
              onCheck={onCheckUpdate}
              onInstall={onInstallUpdate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
