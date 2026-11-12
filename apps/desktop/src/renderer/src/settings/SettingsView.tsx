// Settings page, shown in the main pane: 常规 / 外观 / 模型 / 记忆 / 插件 / 关于 as tabs.
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';
import { Plugins, type PluginsApi, type SettingsPages } from './Plugins';
import { About } from './About';
import { General, type GeneralProps, type WorkflowsApi } from './General';
import { Icon } from '../ui/Icon';
import { Memory, type MemoryProps } from './Memory';
import type { UpdateState } from '../../../shared/updates';

export type SettingsTab = 'general' | 'appearance' | 'models' | 'memory' | 'plugins' | 'about';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型' },
  { id: 'memory', label: '记忆' },
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
  /** Back to the conversation (same as Esc). */
  onBack(): void;
  workflows: WorkflowsApi;
  pickFolder(): Promise<string | null>;
  onBackendRestarted(listener: () => void): () => void;
  projects: GeneralProps['projects'];
  exportUsageLog: GeneralProps['exportUsageLog'];
  showInFolder: GeneralProps['showInFolder'];
  mailModel?: string;
  networkState?: GeneralProps['networkState'];
  pickFiles?: GeneralProps['pickFiles'];
  localConnect?: GeneralProps['localConnect'];
  previewPages?: GeneralProps['previewPages'];
  /** The plugins' own settings pages, shown in their detail under 插件. */
  pluginPages?: SettingsPages;
  /** 记忆 (absent when the core keeps none: no tab). The switch is a shell setting. */
  memory?: Omit<MemoryProps, 'enabled' | 'onEnabled'>;
}

export function SettingsView({ shell, providers, plugins, version, update, onCheckUpdate, onInstallUpdate, tab, onTab, onBack, workflows, pickFolder, onBackendRestarted, projects, exportUsageLog, showInFolder, mailModel, networkState, pickFiles, localConnect, previewPages, pluginPages, memory }: SettingsViewProps) {
  const { settings } = useShell(shell);
  const tabs = memory ? TABS : TABS.filter((t) => t.id !== 'memory');
  return (
    <div className="settings">
      {/* 插件: the list and the detail fill the window's height (each scrolls on its own). */}
      <div className={tab === 'plugins' ? 'settings-column is-fill' : 'settings-column'}>
        <div className="settings-top">
          {/* Only the arrow: he wants no text on it; the name is for hover and screen readers. */}
          <button type="button" className="icon-btn settings-back" aria-label="返回对话" title="返回对话（Esc）" onClick={onBack}>
            <Icon name="back" size={16} />
          </button>
        <div className="tabs" role="tablist" aria-label="设置">
          {tabs.map((t) => (
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
        </div>
        <div role="tabpanel" className="settings-panel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
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
              {...(networkState ? { networkState } : {})}
              {...(pickFiles ? { pickFiles } : {})}
              {...(localConnect ? { localConnect } : {})}
              {...(previewPages ? { previewPages } : {})}
              autostart={shell.autostart}
            />
          ) : tab === 'appearance' ? (
            <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
          ) : tab === 'models' ? (
            <Models api={providers} />
          ) : tab === 'memory' && memory ? (
            <Memory {...memory} enabled={settings.memory} onEnabled={(on) => shell.update({ memory: on })} />
          ) : tab === 'plugins' ? (
            <Plugins api={plugins} pages={pluginPages} mail={{ prefs: settings.mail, onChange: (patch) => shell.update({ mail: { ...settings.mail, ...patch } }), ...(mailModel ? { model: mailModel } : {}) }} />
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
