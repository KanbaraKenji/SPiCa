// Settings, as a large dialog over the window (他 2026-11-12 picked 「大弹窗」): the window behind dims, the
// sections (常规 / 账号 / 外观 / 模型 / 记忆 / 插件 / 关于) are a column on the left, the section on the right scrolls by
// itself. The close button at the top right and a press outside close it; so does Esc, through App's own Esc
// (as before it was a dialog), so a confirm box, a menu or a field inside closes only itself.
// On a small window it fills the window under the title bar.
import { useRef } from 'react';
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';
import { Plugins, type PluginsApi, type PluginsTab, type SettingsPages } from './Plugins';
import { About } from './About';
import { Account } from './Account';
import { General, type GeneralProps, type WorkflowsApi } from './General';
import { Icon } from '../ui/Icon';
import { useModal } from '../ui/useModal';
import { Memory, type MemoryProps } from './Memory';
import type { UpdateState } from '../../../shared/updates';

export type SettingsTab = 'general' | 'account' | 'appearance' | 'models' | 'memory' | 'plugins' | 'about';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'account', label: '账号' },
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
  /** 插件's own tabs (已安装 / 市场), kept by the caller: the sidebar's 插件市场 opens 市场. */
  pluginsTab?: PluginsTab;
  onPluginsTab?: (tab: PluginsTab) => void;
  /** Closes the dialog (the close button, a press outside, Esc). */
  onClose(): void;
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
  /** 记忆 (absent when the core keeps none: no section). The switch is a shell setting. */
  memory?: Omit<MemoryProps, 'enabled' | 'onEnabled'>;
}

export function SettingsView({ shell, providers, plugins, version, update, onCheckUpdate, onInstallUpdate, tab, onTab, pluginsTab, onPluginsTab, onClose, workflows, pickFolder, onBackendRestarted, projects, exportUsageLog, showInFolder, mailModel, networkState, pickFiles, localConnect, previewPages, pluginPages, memory }: SettingsViewProps) {
  const { settings } = useShell(shell);
  const tabs = memory ? TABS : TABS.filter((t) => t.id !== 'memory');
  const box = useRef<HTMLDivElement>(null);
  // The keyboard starts in the dialog (no ring on a section until Tab is pressed) and stays in it. Esc is App's:
  // it closes the settings only when nothing inside (a confirm box, a menu, a field) handled it first.
  useModal(box, onClose, box, { esc: false });
  return (
    <div className="scrim settings-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} ref={box}>
        <nav className="settings-nav" role="tablist" aria-label="设置" aria-orientation="vertical">
          <h2 className="settings-nav-title">设置</h2>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              className={tab === t.id ? 'settings-nav-item is-on' : 'settings-nav-item'}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <button type="button" className="icon-btn settings-close" aria-label="关闭设置" title="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
          {/* 插件: the list and the detail fill the dialog's height (each scrolls on its own). */}
          <div className="settings" key={tab}>
            <div className={tab === 'plugins' ? 'settings-column is-fill' : 'settings-column'}>
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
                ) : tab === 'account' ? (
                  <Account settings={settings} onChange={(p) => shell.update(p)} autoAccount={shell.autoAccount} />
                ) : tab === 'appearance' ? (
                  <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
                ) : tab === 'models' ? (
                  <Models api={providers} runLimit={{ value: settings.runLimitUsd, onChange: (runLimitUsd) => shell.update({ runLimitUsd }) }} />
                ) : tab === 'memory' && memory ? (
                  <Memory {...memory} enabled={settings.memory} onEnabled={(on) => shell.update({ memory: on })} />
                ) : tab === 'plugins' ? (
                  <Plugins
                    api={plugins}
                    pages={pluginPages}
                    mail={{ prefs: settings.mail, onChange: (patch) => shell.update({ mail: { ...settings.mail, ...patch } }), ...(mailModel ? { model: mailModel } : {}) }}
                    {...(pluginsTab ? { tab: pluginsTab } : {})}
                    {...(onPluginsTab ? { onTab: onPluginsTab } : {})}
                  />
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
        </div>
      </div>
    </div>
  );
}
