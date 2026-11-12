// Settings, as a dialog over the window (他 2026-11-12 picked 「大弹窗」): the window behind dims; on the left
// 搜索设置 and the sections in groups (应用 / 扩展 / 个人, then 关于), on the right the section's name and the
// section itself, which scrolls by itself. While 搜索设置 holds words the right side lists the rows that match. The close button at the top right and a press outside close it; so does Esc, through App's own Esc
// (as before it was a dialog), so a confirm box, a menu or a field inside closes only itself.
// On a small window it fills the window under the title bar.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';
import { Models, type ProvidersApi } from './Models';
import { Plugins, type PluginsApi, type PluginsTab, type SettingsPages } from './Plugins';
import { About } from './About';
import { Account } from './Account';
import { General, type GeneralProps, type WorkflowsApi } from './General';
import { Icon, type IconName } from '../ui/Icon';
import { useModal } from '../ui/useModal';
import { Memory, type MemoryProps } from './Memory';
import { matches, SettingsSearchContext } from './Group';
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

/**
 * The sections in the left column, in groups split by a short line, no group names (as Claude's settings, the
 * picture he sent 2026-11-12): you (账号); how Spica works for you (常规, 外观, 记忆); what it works with (模型,
 * 插件); then 关于 on its own.
 */
const NAV_GROUPS: SettingsTab[][] = [['account'], ['general', 'appearance', 'memory'], ['models', 'plugins'], ['about']];

/** Each section's mark before its name (Claude's column has one). */
const NAV_ICON: Record<SettingsTab, IconName> = {
  account: 'account',
  general: 'settings',
  appearance: 'palette',
  memory: 'thinking',
  models: 'model',
  plugins: 'plugin',
  about: 'info',
};

const labelOf = (id: SettingsTab) => TABS.find((t) => t.id === id)?.label ?? '';

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
  /** 插件's own tabs (已安装 / 市场), kept by the caller: the dialog opens again on the one left. */
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
  // 搜索设置: while it holds words, the pane lists the matching rows by section.
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  // Where a result goes: the row (by its name) to bring into sight, or the plugin to show under 已安装.
  const [found, setFound] = useState<{ title: string } | null>(null);
  const [focusPlugin, setFocusPlugin] = useState<string | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const go = (id: SettingsTab, title: string) => {
    setQuery('');
    onTab(id);
    setFound({ title });
  };
  const goPlugin = (name: string) => {
    setQuery('');
    onTab('plugins');
    onPluginsTab?.('installed');
    setFocusPlugin(name);
  };
  // The row gone to: brought into sight and marked until the next press anywhere.
  useEffect(() => {
    if (!found || searching) return;
    const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-setting]') ?? [])].find((r) => r.dataset.setting === found.title);
    if (!row) return;
    row.scrollIntoView?.({ block: 'center' });
    row.classList.add('is-found');
    const clear = () => row.classList.remove('is-found');
    window.addEventListener('pointerdown', clear, { once: true, capture: true });
    return () => window.removeEventListener('pointerdown', clear, { capture: true });
  }, [found, searching, tab]);

  const sectionFor = (id: SettingsTab) =>
    id === 'general' ? (
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
    ) : id === 'account' ? (
      <Account settings={settings} onChange={(p) => shell.update(p)} autoAccount={shell.autoAccount} />
    ) : id === 'appearance' ? (
      <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
    ) : id === 'models' ? (
      <Models
        api={providers}
        runLimit={{ value: settings.runLimitUsd, onChange: (runLimitUsd) => shell.update({ runLimitUsd }) }}
        agentMessages={{ value: settings.agentMessageLimit, onChange: (agentMessageLimit) => shell.update({ agentMessageLimit }) }}
      />
    ) : id === 'memory' && memory ? (
      <Memory {...memory} enabled={settings.memory} onEnabled={(on) => shell.update({ memory: on })} />
    ) : id === 'plugins' ? (
      <Plugins
        api={plugins}
        pages={pluginPages}
        mail={{ prefs: settings.mail, onChange: (patch) => shell.update({ mail: { ...settings.mail, ...patch } }), ...(mailModel ? { model: mailModel } : {}) }}
        {...(pluginsTab ? { tab: pluginsTab } : {})}
        {...(onPluginsTab ? { onTab: onPluginsTab } : {})}
        {...(focusPlugin ? { focus: focusPlugin } : {})}
      />
    ) : id === 'about' ? (
      <About
        version={version}
        update={update}
        ownSource={settings.updateSource}
        onSource={(updateSource) => shell.update({ updateSource })}
        onCheck={onCheckUpdate}
        onInstall={onInstallUpdate}
      />
    ) : null;

  return (
    <div className="scrim settings-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={box}>
        {/* A title bar across the dialog: 设置 and the close button, a line under it. */}
        <header className="settings-titlebar">
          <h2 className="settings-title" id="settings-title">
            设置
          </h2>
          <button type="button" className="icon-btn settings-close" aria-label="关闭设置" title="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="settings-body">
        <nav className="settings-nav" aria-label="分区">
          <div className="settings-search">
            <Icon name="search" size={14} className="settings-search-icon" />
            <input className="input" type="search" value={query} placeholder="搜索设置" aria-label="搜索设置" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="settings-nav-list" role="tablist" aria-label="分区" aria-orientation="vertical">
            {NAV_GROUPS.map((g, i) => {
              const items = g.filter((id) => tabs.some((t) => t.id === id));
              return items.length ? (
                <div key={i} className="settings-nav-group" role="presentation">
                  {items.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`tab-${id}`}
                      aria-selected={!searching && tab === id}
                      aria-controls={`panel-${id}`}
                      className={!searching && tab === id ? 'settings-nav-item is-on' : 'settings-nav-item'}
                      onClick={() => {
                        setQuery('');
                        onTab(id);
                      }}
                    >
                      <Icon name={NAV_ICON[id]} size={16} className="settings-nav-icon" />
                      {labelOf(id)}
                    </button>
                  ))}
                </div>
              ) : null;
            })}
          </div>
        </nav>
        <div className="settings-main">
          {searching ? (
            <div className="settings">
              <div className="settings-column search-results">
                <h3 className="settings-page-title">搜索结果</h3>
                {/* Every section, out of sight: its rows that match put themselves into its list above it. */}
                {tabs.map((t) => (
                  <SearchSection key={t.id} label={t.label} query={query} onGo={(title) => go(t.id, title)} onPlugin={goPlugin}>
                    {sectionFor(t.id)}
                  </SearchSection>
                ))}
                <p className="settings-hint search-empty">没有找到相关设置</p>
              </div>
            </div>
          ) : (
            // 插件: the list and the detail fill the dialog's height (each scrolls on its own).
            <div className="settings" key={tab}>
              <div className={tab === 'plugins' ? 'settings-column is-fill' : 'settings-column'}>
                {/* The section's name, a short bold line at the top of its content (as Claude's). */}
                <h3 className="settings-page-title">{labelOf(tab)}</h3>
                <div role="tabpanel" className="settings-panel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} ref={panel}>
                  {sectionFor(tab)}
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/** One section's results: its name, then the rows of it that match; the section itself is rendered unseen. */
function SearchSection({ label, query, onGo, onPlugin, children }: { label: string; query: string; onGo(title: string): void; onPlugin(name: string): void; children: ReactNode }) {
  const [results, setResults] = useState<HTMLElement | null>(null);
  return (
    <section className="search-section" aria-label={label}>
      <h3 className="settings-subheading">{label}</h3>
      <div className="search-hits" ref={setResults} />
      <SettingsSearchContext.Provider value={{ query, results, sectionHit: matches(query, label), jump: onGo, jumpPlugin: onPlugin }}>
        <div hidden>{children}</div>
      </SettingsSearchContext.Provider>
    </section>
  );
}
