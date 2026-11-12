// Settings > 插件, two tabs. 已安装: the plugins as a list on the left (已启用 / 已停用; the box on top searches
// them, the filter narrows them, 检查更新 checks every source) and the one picked on the right: its switch
// beside the name, a row of what can be done to it (更新到 / 回退到 / 删除, and while it updates, how far it
// is), then its model budget, mail sorting and what it has, and its own settings pages (views with placement
// settings) under tabs. 市场: the plugin sources (检查更新 for each and for all, 添加来源 for a folder, .zip or
// web address, 移除), then what they offer and is not installed, each with 安装.
// A plugin turned on or off stays where it is in the list while the page is
// open; it moves to its group the next time the page opens (the counts are only
// in the filter, as things are now). Mock mode and the plugin folder are at the bottom.
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isLocation,
  spentText,
  stepText,
  unquote,
  usd,
  type InstallStepView,
  type PluginIconView,
  type PluginModelView,
  type PluginPackage,
  type PluginsCommand,
  type PluginsProgress,
  type PluginsResult,
  type PluginSourceView,
  type PluginsState,
  type PluginView,
} from '../../../shared/plugins';
import { friendlyError } from '../store/agent';
import { ConfirmDialog } from '../ui/Dialog';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { InfoTip } from '../ui/InfoTip';
import { MailSettings, type MailSettingsProps } from './MailSettings';
import { Group, matches as searchMatches, Pane, Row, SearchHit, SettingsSearchContext } from './Group';
import { SpicaStatusIcon } from '@spica/brand/react';
import type { PluginView as PageView } from '../../../shared/plugin-view';
import { PluginPage, type PluginPageProps } from '../shell/PluginFrame';
import { spendText } from '../../../shared/spend';
import { letterBadge } from '../ui/badge';
import { formatClock } from '../chat/format';

export interface PluginsApi {
  run(cmd: PluginsCommand): Promise<PluginsResult>;
  onChanged(listener: () => void): () => void;
  /** How far an install the page started is. */
  onProgress?: (listener: (p: PluginsProgress) => void) => () => void;
  /** The system's folder picker: the folder goes into the box and is looked at. */
  pickFolder?: () => Promise<string | null>;
}

/** The plugins' own settings pages (views with placement settings, of enabled plugins) and how to show one. */
export interface SettingsPages {
  views: PageView[];
  props(v: PageView): PluginPageProps;
}

/**
 * A plugin's settings page, under its tab in the detail: it fills what is left of the column and scrolls
 * itself. Its own background (--spica-bg) is the settings pane's, so the page and the pane are one; what it
 * sets apart on --spica-surface gets the window's, so it still stands out. (The skin is painted on :root
 * before the page renders; without it, the card's grey.)
 */
function settingsTheme(page: PluginPageProps): PluginPageProps['theme'] {
  const vars = page.theme.vars;
  const bg = vars['--spica-bg'] ?? '';
  const surface = vars['--spica-surface'] ?? bg;
  const pane = typeof document === 'undefined' ? '' : document.documentElement.style.getPropertyValue('--spica-settings-pane').trim();
  return { ...page.theme, vars: { ...vars, '--spica-bg': pane || surface, '--spica-surface': bg } };
}

const SERVER_STATUS: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  restarting: '重启中',
  stopped: '已停止',
  failed: '错误',
};

export { Switch } from './Switch';

type Filter = 'all' | 'on' | 'update' | 'problem';

/** What is wrong with a plugin, in words (its issues and servers that failed); empty when nothing. */
export function pluginProblems(p: PluginView): string[] {
  return [...p.issues, ...p.servers.filter((s) => s.status === 'failed').map((s) => s.lastError ?? `「${s.id}」启动失败`)];
}

const matches = (p: PluginView, f: Filter) => (f === 'on' ? p.enabled : f === 'update' ? Boolean(p.update) : f === 'problem' ? pluginProblems(p).length > 0 : true);

/** Below this width the list and the detail take turns (the detail has a way back). */
const NARROW = 620;

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{items.length ? items.join('、') : '—'}</dd>
    </>
  );
}

/**
 * A plugin that uses the user's models: what that means for their budget, the
 * plugin's own reason, today's spending, and a daily limit they can lower (not
 * raise above the plugin's own) or set to nothing.
 */
function ModelUse({ p, m, busy, run }: { p: PluginView; m: PluginModelView; busy: boolean; run(cmd: PluginsCommand): void }) {
  // Typed but not saved: kept like the provider form (leave the page and come back, it is still there).
  const [limit, setLimit, limitDone] = useKeptDraft(`plugins.limit.${p.name}`, String(m.maxUsdPerDay));
  // Saved elsewhere (保存, 禁止使用模型, 恢复默认): the field shows the new value.
  const [prev, setPrev] = useState(m.maxUsdPerDay);
  if (prev !== m.maxUsdPerDay) {
    setPrev(m.maxUsdPerDay);
    setLimit(String(m.maxUsdPerDay));
  }
  const value = Number(limit);
  const problem = limit.trim() === '' || !Number.isFinite(value) || value < 0 ? '须为 0 或正数' : value > m.declaredMaxUsdPerDay ? `不能高于 ${usd(m.declaredMaxUsdPerDay)}` : null;
  const off = m.maxUsdPerDay <= 0;
  const used = m.spentTodayUsd;
  return (
    <div className="plugin-model">
      <p className="plugin-model-line">
        {off ? '使用模型 · 已禁止' : `使用模型 · 每日上限 ${usd(m.maxUsdPerDay)}`}
        {typeof used === 'number' && !off ? (
          <span className={used >= m.maxUsdPerDay ? 'plugin-model-spent is-full' : 'plugin-model-spent'}>
            {used >= m.maxUsdPerDay ? ` · 今日 ${spendText(used, m.unpricedToday, spentText)}（已达上限）` : ` · 今日 ${spendText(used, m.unpricedToday, spentText)}`}
          </span>
        ) : null}
      </p>
      <p className="plugin-model-reason">用途：{m.reason}</p>
      <div className="plugin-model-limit">
        <label className="plugin-model-input">
          <span>每日上限 $</span>
          <input
            className={problem ? 'input is-invalid' : 'input'}
            type="number"
            min={0}
            max={m.declaredMaxUsdPerDay}
            step={0.01}
            value={limit}
            aria-label={`「${p.displayName}」每日上限（美元）`}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy || problem !== null || value === m.maxUsdPerDay}
          onClick={() => {
            run({ op: 'modelLimit', name: p.name, maxUsdPerDay: value });
            limitDone();
          }}
        >
          保存
        </button>
        {value !== m.maxUsdPerDay && limit.trim() !== '' ? <span className="provider-unsaved">未保存</span> : null}
        {off ? null : (
          <button
            type="button"
            className="btn btn-small"
            disabled={busy}
            onClick={() => {
              run({ op: 'modelLimit', name: p.name, maxUsdPerDay: 0 });
              limitDone();
            }}
          >
            禁止使用模型
          </button>
        )}
        {m.userMaxUsdPerDay !== undefined ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={busy}
            onClick={() => {
              run({ op: 'modelLimit', name: p.name, maxUsdPerDay: null });
              limitDone();
            }}
          >
            恢复默认（{usd(m.declaredMaxUsdPerDay)}）
          </button>
        ) : null}
        {problem ? <span className="field-error">{problem}</span> : null}
      </div>
    </div>
  );
}

/** A plugin's badge: the first character of its name (a letter in upper case) on a colour its id always gets (ui/badge.ts). */
export function pluginBadge(p: { name: string; displayName: string }): { letter: string; colour: string } {
  return letterBadge(p.displayName.trim() || p.name, p.name);
}

/**
 * The plugin's own icon (a picture only) when it has one, else its letter badge. Two pictures, one per skin,
 * when the plugin gives two: the style sheet shows the one for the skin in force (it changes with the skin).
 */
function Badge({ name, displayName, icon }: { name: string; displayName: string; icon?: PluginIconView | undefined }) {
  if (icon && icon.light === icon.dark) return <img className="plugin-badge plugin-icon" src={icon.light} alt="" aria-hidden draggable={false} />;
  if (icon)
    return (
      <>
        <img className="plugin-badge plugin-icon is-light" src={icon.light} alt="" aria-hidden draggable={false} />
        <img className="plugin-badge plugin-icon is-dark" src={icon.dark} alt="" aria-hidden draggable={false} />
      </>
    );
  const b = pluginBadge({ name, displayName });
  return (
    <span className="plugin-badge" style={{ background: b.colour }} aria-hidden>
      {b.letter}
    </span>
  );
}

const pkgTitle = (a: PluginPackage) => a.displayName ?? a.name;

/**
 * 已安装: one plugin a full-width row (as Claude's plugin list): its icon, its name and version, a grey line of
 * what it does under them (cut at the end), and at the end what needs looking at (有更新, a problem), then the
 * chevron of a row that opens a page. A press opens its page.
 */
function PluginRow({ p, onPick }: { p: PluginView; onPick(): void }) {
  const problems = pluginProblems(p);
  return (
    <li>
      <button type="button" className={p.enabled ? 'plugin-item' : 'plugin-item is-off'} onClick={onPick}>
        <Badge name={p.name} displayName={p.displayName} icon={p.icon} />
        <span className="plugin-item-text">
          <span className="plugin-item-title">
            <span className="plugin-row-name">{p.displayName}</span>
            <span className="plugin-version">{p.version}</span>
          </span>
          {p.description ? <span className="settings-hint plugin-item-desc">{p.description}</span> : null}
        </span>
        {p.update ? <span className="provider-default plugin-row-state is-newer">可更新</span> : null}
        {problems.length ? <SpicaStatusIcon name="error" size={14} title={problems.join('；')} /> : null}
        {p.enabled ? null : <span className="visually-hidden">已停用</span>}
        <Icon name="chevronRight" size={14} className="plugin-item-go" />
      </button>
    </li>
  );
}

/** 市场: 已安装 (this version is the one here), 可更新 (a newer one than here), nothing when it is not installed. */
export function packageState(a: PluginPackage): '' | '已安装' | '可更新' {
  return a.newer ? '可更新' : a.installed ? '已安装' : '';
}

/**
 * 市场: one package a card (as Claude's Discover grid): icon, name and version, two lines of what it does, its
 * state at the foot (已安装 / 可更新). A press opens its page; one not here (or with a newer version) has its
 * install button at the top right, so it can be put in without opening it.
 */
function PackageCard({ a, busy, running, onPick, onInstall }: { a: PluginPackage; busy: boolean; running: boolean; onPick(): void; onInstall(): void }) {
  const state = packageState(a);
  const can = !a.installed || a.newer;
  return (
    <li className="plugin-card-item">
      <button type="button" className="plugin-card-open" onClick={onPick} aria-label={pkgTitle(a)}>
        <Badge name={a.name} displayName={pkgTitle(a)} icon={a.icon} />
        <span className="plugin-item-text">
          <span className="plugin-item-title">
            <span className="plugin-row-name">{pkgTitle(a)}</span>
            {a.version ? <span className="plugin-version">{a.version}</span> : null}
          </span>
          {a.description ? <span className="settings-hint plugin-card-desc">{a.description}</span> : null}
          {/* Quiet words, as 默认 in 模型 and 官方 by a source: not a button. */}
          {state ? <span className={state === '可更新' ? 'provider-default plugin-row-state is-newer' : 'provider-default plugin-row-state'}>{state}</span> : null}
        </span>
      </button>
      {can ? (
        <button type="button" className="btn btn-small btn-square plugin-card-install" disabled={busy} onClick={onInstall} aria-label={installLabel(a)} title={installLabel(a)}>
          {running ? <span className="spinner" aria-hidden /> : <Icon name={a.newer ? 'refresh' : 'plus'} size={14} />}
        </button>
      ) : null}
    </li>
  );
}

/** An install (or update) the page started and is waiting for. */
interface Running {
  job: string;
  /** The plugin it is for (a package's name, or an installed plugin's). */
  name: string;
  startedAt: number;
  step?: InstallStepView;
}

/** How far the install is: the step in words, the time so far (7s, 1m 4s, as every clock); a bar while the download size is known. */
function Progress({ run }: { run: Running }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = run.step;
  const held = s?.step === 'replace' && s.busyMs !== undefined;
  const share = s?.step === 'download' && s.total ? Math.min(1, s.received / s.total) : null;
  return (
    <div className={held ? 'plugin-progress is-held' : 'plugin-progress'} role="status">
      <span className="plugin-progress-line">
        <SpicaStatusIcon name="running" size={14} />
        <span className="plugin-progress-text">{s ? stepText(s) : '正在安装'}</span>
        <span className="plugin-progress-time">{formatClock(now - run.startedAt)}</span>
      </span>
      {share !== null ? (
        <span className="plugin-progress-bar" aria-hidden>
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** Where it is from and which version, the grey line under a plugin's name on its page (as Claude's 「from … · 0.1.0」). */
function subLine(location: string | undefined, version: string | undefined): string {
  return [location, version].filter(Boolean).join(' · ');
}

/** Back to the list the page was opened from, at its top left. */
function Back({ label, onBack }: { label: string; onBack(): void }) {
  return (
    <button type="button" className="back-link plugin-back" onClick={onBack}>
      <Icon name="arrowLeft" size={16} />
      <span className="icon-text">{label}</span>
    </button>
  );
}

/**
 * The plugin's page (as Claude's): ← back at the top left; its icon and name with where it is from and its
 * version under them; at the right 更新到 x, its switch and 「…」 (回退到 x, 删除). While it updates, how far it is
 * under that. An enabled plugin with settings pages gets a row of tabs: 详情 (what it does, needs, has) and one
 * per page. A page loads when its tab is first picked and stays (hidden) while 详情 is shown, so what was typed in
 * it is still there; another plugin starts over at 详情 (the page is keyed by plugin).
 */
function PluginDetail({
  p,
  busy,
  running,
  run,
  update,
  ask,
  mail,
  pages = [],
  back,
  note,
}: {
  p: PluginView;
  busy: boolean;
  running: Running | undefined;
  run(cmd: PluginsCommand): void;
  update(): void;
  ask(kind: 'uninstall' | 'rollback', p: PluginView): void;
  mail?: MailSettingsProps | undefined;
  pages?: PluginPageProps[] | undefined;
  back: { label: string; onBack(): void };
  /** The result line (installed, updated, a failure), under the title line, where the progress was. */
  note?: ReactNode;
}) {
  const problems = pluginProblems(p);
  const [picked, setPicked] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  // A page gone (the plugin turned off, updated without it): back on 详情.
  const tab = pages.some((g) => g.view.id === picked) ? picked : '';
  const pick = (id: string) => {
    setPicked(id);
    if (id && !opened.includes(id)) setOpened([...opened, id]);
  };
  const cls = ['plugin-detail', p.enabled ? '' : 'is-off', tab ? 'is-page' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label={p.displayName}>
      <Back {...back} />
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge name={p.name} displayName={p.displayName} icon={p.icon} />
          <span className="plugin-title-text">
            <span className="plugin-name">{p.displayName}</span>
            <span className="settings-hint plugin-sub" title={p.source?.location} data-tip-clipped="">
              {subLine(p.source?.location, p.version)}
            </span>
          </span>
        </div>
        <div className="plugin-head-actions">
          {p.update && !running ? (
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={update}>
              更新到 {p.update}
            </button>
          ) : null}
          <Switch on={p.enabled} label={p.enabled ? `停用「${p.displayName}」` : `启用「${p.displayName}」`} disabled={busy} onChange={(on) => run({ op: on ? 'enable' : 'disable', name: p.name })} />
          <button
            type="button"
            className="icon-btn"
            aria-label="更多操作"
            title="更多操作"
            aria-haspopup="menu"
            disabled={busy}
            onClick={(e) => {
              const el = e.currentTarget;
              setMenu((m) => (m ? null : el));
            }}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      </header>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={[
            ...(p.previousVersion ? [{ label: `回退到 ${p.previousVersion}`, onSelect: () => ask('rollback', p) }] : []),
            { label: '删除', danger: true, onSelect: () => ask('uninstall', p) },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {running ? (
        <div className="plugin-actions">
          <Progress run={running} />
        </div>
      ) : null}
      {note}
      {pages.length ? (
        <div className="tabs plugin-tabs" role="tablist" aria-label={`「${p.displayName}」`}>
          {[{ id: '', label: '详情' }, ...pages.map((g) => ({ id: g.view.id, label: g.view.title.trim() || '设定' }))].map((t) => (
            <button key={t.id || '-'} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab is-on' : 'tab'} onClick={() => pick(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="plugin-detail-body" hidden={tab !== ''}>
        {p.description ? <p className="plugin-desc">{p.description}</p> : null}
        {p.enabled ? null : <p className="plugin-off">已停用</p>}
        {problems.length ? (
          <p className="plugin-problem status-with-icon">
            <SpicaStatusIcon name="error" size={14} />
            {problems.join('；')}
          </p>
        ) : null}
        {mail ? (
          <div className="plugin-mail">
            <MailSettings {...mail} />
          </div>
        ) : null}
        {p.model ? <ModelUse p={p} m={p.model} busy={busy} run={run} /> : null}
        <dl className="detail-facts plugin-facts">
          <List label="工具" items={p.tools} />
          <List label="技能" items={p.skills.map((s) => s.name)} />
          <List label="命令" items={p.commands.map((c) => `/${c.id}`)} />
          <List label="进程" items={p.servers.map((s) => `${s.id}（${SERVER_STATUS[s.status] ?? s.status}）`)} />
          <dt>模拟模式</dt>
          <dd>{p.mockSupported ? '支持' : '不支持'}</dd>
        </dl>
      </div>
      {pages
        .filter((g) => opened.includes(g.view.id))
        .map((g) => (
          <div key={g.view.id} className="plugin-tab-page" hidden={tab !== g.view.id}>
            <PluginPage {...g} theme={settingsTheme(g)} />
          </div>
        ))}
    </section>
  );
}

/** What 安装 says for a package: install, 更新到 a newer one, install again (the same version), or install that (older) version. */
function installLabel(a: PluginPackage): string {
  if (!a.installed) return '安装';
  if (a.newer && a.version) return `更新到 ${a.version}`;
  if (a.version === a.installed) return '重新安装';
  return a.version ? `安装 ${a.version}` : '安装';
}

/** A package's page: ← back, its name with where it is and its version, 安装 (with its progress) at the right, then what it says. */
function PackageDetail({ a, busy, running, install, onShow, back, note }: { a: PluginPackage; busy: boolean; running: Running | undefined; install(): void; onShow?: (() => void) | undefined; back: { label: string; onBack(): void }; note?: ReactNode }) {
  // In 市场, one that is here as it is: said so, and the way to it under 已安装 (no 重新安装 offered there).
  const here = a.installed !== undefined && !a.newer && a.version === a.installed && a.source !== undefined;
  return (
    <section className="plugin-detail" aria-label={pkgTitle(a)}>
      <Back {...back} />
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge name={a.name} displayName={pkgTitle(a)} icon={a.icon} />
          <span className="plugin-title-text">
            <span className="plugin-name">{pkgTitle(a)}</span>
            <span className="settings-hint plugin-sub" title={a.location} data-tip-clipped="">
              {subLine(a.location, a.version)}
            </span>
          </span>
        </div>
        <div className="plugin-head-actions">
          {running ? null : here && onShow ? (
            <>
              <span className="provider-default plugin-here">已安装</span>
              <button type="button" className="btn btn-small" onClick={onShow}>
                在已安装中查看
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={install}>
              {installLabel(a)}
            </button>
          )}
        </div>
      </header>
      {running ? (
        <div className="plugin-actions">
          <Progress run={running} />
        </div>
      ) : null}
      {note}
      {a.description ? <p className="plugin-desc">{a.description}</p> : null}
      <dl className="detail-facts plugin-facts">
        {a.installed ? (
          <>
            <dt>已安装</dt>
            <dd>{a.installed}</dd>
          </>
        ) : null}
        {a.skills ? <List label="技能" items={a.skills} /> : null}
        {a.commands ? <List label="命令" items={a.commands} /> : null}
        {a.pages ? <List label="页面" items={a.pages} /> : null}
      </dl>
    </section>
  );
}

/** What 模拟模式 does, on hover beside it. */
export const MOCK_TIP = '插件改用演示数据，不连接真实系统。';

/** 已安装: the plugins here, with their switches, updates and own pages. 市场: the sources and what they offer. */
export type PluginsTab = 'installed' | 'market';

const TABS: [PluginsTab, string][] = [
  ['installed', '已安装'],
  ['market', '市场'],
];

/** 「上次读取 14:05 · 3 个插件」, 「连接失败」: how a source went the last time it was read. */
export function sourceLine(s: PluginSourceView, now: Date = new Date()): string {
  if (s.error) return '连接失败';
  if (!s.readAt) return '尚未读取';
  const at = new Date(s.readAt);
  const sameDay = at.toDateString() === now.toDateString();
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const when = sameDay ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
  return `上次读取 ${when}${s.count !== undefined ? ` · ${s.count} 个插件` : ''}`;
}

let jobs = 0;

/** 已安装's filter (a menu under its button, as 使用日志's 项目). */
const FILTERS: [Filter, string][] = [
  ['all', '全部'],
  ['on', '已启用'],
  ['update', '有更新'],
  ['problem', '有问题'],
];

export interface PluginsProps {
  api: PluginsApi;
  mail?: MailSettingsProps;
  pages?: SettingsPages | undefined;
  /** Which tab is open, when the caller keeps it (the settings remember it); else the page keeps it. */
  tab?: PluginsTab;
  onTab?: (tab: PluginsTab) => void;
  /** A plugin to show (搜索设置 went to it): picked under 已安装. */
  focus?: string;
}

export function Plugins({ api, mail, pages, tab: tabProp, onTab, focus }: PluginsProps) {
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false);
  // 'info': a notice (no sources to check), shown plain like 正在检查更新….
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  // 检查更新 running (all sources, or one by its location): said beside it until it ends.
  const [checking, setChecking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'uninstall' | 'rollback'; p: PluginView } | { kind: 'removeSource'; s: PluginSourceView } | null>(null);
  const [ownTab, setOwnTab] = useKeptDraft('plugins.tab', 'installed');
  const search = useContext(SettingsSearchContext);
  const tab: PluginsTab = tabProp ?? (ownTab === 'market' ? 'market' : 'installed');
  const pickTab = (t: PluginsTab) => {
    setOwnTab(t);
    onTab?.(t);
    setNote(null);
    setShowDetail(false);
  };
  // The search on the top row: the installed plugins under 已安装, what the sources offer under 市场.
  const [query, setQuery] = useKeptDraft('plugins.query', '');
  const [filter, setFilter] = useState<Filter>('all');
  const [filterMenu, setFilterMenu] = useState<HTMLElement | null>(null);
  // 添加来源: open, and what is typed in it.
  const [adding, setAdding] = useState(false);
  const [place, setPlace] = useKeptDraft('plugins.addSource', '');
  // What was last added: a single package on the web is listed under it to install.
  const [added, setAdded] = useState<string | null>(null);
  // What is picked: an installed plugin by name, or a package by 'pkg:' + key.
  const [picked, setPicked] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | undefined>(undefined);
  const runningRef = useRef<Running | undefined>(undefined);
  // Which group each plugin is shown in, fixed while the page is open (turning one off does not move it).
  const [groupOf, setGroupOf] = useState<Record<string, boolean>>({});
  // The list (or the cards) and a plugin's page take turns (as Claude's); narrow, the cards go one a row.
  const root = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const plugins = useMemo(() => state?.plugins ?? [], [state]);
  // 搜索设置 went to a plugin: it is the one shown under 已安装.
  const [focused, setFocused] = useState<string | undefined>(undefined);
  if (focus && focus !== focused) {
    setFocused(focus);
    setPicked(focus);
    setOwnTab('installed');
    setShowDetail(true);
  }
  // Plugins that provide mail (enabled): one shows the mail settings in its detail; two or more, once above the list.
  const mailSources = mail ? plugins.filter((p) => p.mail) : [];

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A plugin seen for the first time (page opened, or just installed) goes to the group of its state then;
  // one being installed waits until it is done (it is on only at the end).
  const missing = plugins.filter((p) => !(p.name in groupOf) && p.name !== running?.name);
  if (missing.length) setGroupOf({ ...groupOf, ...Object.fromEntries(missing.map((p) => [p.name, p.enabled])) });

  // One plugin command at a time (install, enable, update, delete, limits…): a second click while one runs is dropped.
  const inFlight = useRef(false);
  const run = useCallback(
    async (cmd: PluginsCommand) => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setBusy(true);
      try {
        const r = await api.run(cmd);
        setState(r.state);
        setNote(r.message ? { tone: !r.ok ? 'bad' : r.info ? 'info' : 'ok', text: r.message } : r.ok ? null : { tone: 'bad', text: '操作失败，请重试。' });
        return r;
      } catch (e) {
        setNote({ tone: 'bad', text: friendlyError(e) });
        return undefined;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .run({ op: 'state' })
        .then((r) => {
          if (alive) setState(r.state);
        })
        .catch(() => {});
    // What the page had last time shows first; the remembered sources are listed again behind it (市场).
    void refresh().then(() =>
      api
        .run({ op: 'refreshSources' })
        .then((r) => {
          if (alive) setState(r.state);
        })
        .catch(() => {}),
    );
    const off = api.onChanged(refresh);
    const offProgress = api.onProgress?.((p) => {
      const cur = runningRef.current;
      if (!cur || p.job !== cur.job) return;
      const { job: _job, ...step } = p;
      void _job;
      const next = { ...cur, step };
      runningRef.current = next;
      setRunning(next);
    });
    return () => {
      alive = false;
      off();
      offProgress?.();
    };
  }, [api]);

  /** Install a package (or update a plugin) with its progress at the top of its detail; the result in the result line. */
  const install = async (name: string, cmd: (job: string) => PluginsCommand) => {
    const job = `${Date.now()}-${++jobs}`;
    const r0: Running = { job, name, startedAt: Date.now() };
    runningRef.current = r0;
    setRunning(r0);
    setNote(null);
    const r = await run(cmd(job));
    runningRef.current = undefined;
    setRunning(undefined);
    if (r?.ok) {
      // Now it is installed (and on): its group is its state now, and it is the one shown under 已安装.
      setGroupOf((g) => {
        const { [name]: _gone, ...rest } = g;
        void _gone;
        return rest;
      });
      if (r.state.plugins.some((p) => p.name === name)) {
        setPicked(name);
        // Its page under 已安装, with the result line (已安装「…」) kept.
        setOwnTab('installed');
        onTab?.('installed');
        setShowDetail(true);
      }
    }
  };

  /** 检查更新: one source by its location, or all of them (undefined); said beside the button while it runs. */
  const check = async (location?: string) => {
    setChecking(location ?? '');
    setNote(null);
    await run(location === undefined ? { op: 'checkSources' } : { op: 'checkSources', location });
    setChecking(null);
  };

  /** 添加来源: the place typed or picked is read; added, the box closes; not added, why is said under it. */
  const addSource = async (text: string) => {
    const where = unquote(text);
    if (!isLocation(where)) return;
    setAdded(where);
    const r = await run({ op: 'addSource', location: where });
    if (r?.ok && !r.info) {
      setPlace('');
      setAdding(false);
    }
  };

  const q = query.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  const installedTab = tab === 'installed';
  const shown = plugins.filter((p) => matches(p, filter) && hit(`${p.displayName} ${p.name} ${p.description}`));
  // A package of a plugin already here goes by that plugin's name and icon when it does not say its own (an index says neither).
  const known = (a: PluginPackage): PluginPackage => {
    const p = a.installed ? plugins.find((x) => x.name === a.name) : undefined;
    return p ? { ...a, displayName: a.displayName ?? p.displayName, ...(a.icon || !p.icon ? {} : { icon: p.icon }) } : a;
  };
  const sources = state?.sources ?? [];
  // 市场: what the sources offer; and a single package on the web just typed into 添加来源 (it cannot be a source).
  const single = added && state?.found?.location === added && !sources.some((s) => s.location === added) ? state.found.packages.map(known) : [];
  const offered = (state?.available ?? []).map(known);
  const pkgHit = (a: PluginPackage) => hit(`${pkgTitle(a)} ${a.name} ${a.description ?? ''}`);
  const current = !installedTab ? undefined : picked && !picked.startsWith('pkg:') ? plugins.find((p) => p.name === picked) : undefined;
  const currentPkg = !installedTab && picked?.startsWith('pkg:') ? [...offered, ...single].find((a) => `pkg:${a.key}` === picked) : undefined;
  // A plugin's or a package's page in place of the list (as Claude's), with ← back to the list.
  const detailShown = showDetail && (current !== undefined || currentPkg !== undefined);
  const count = (f: Filter) => plugins.filter((p) => matches(p, f)).length;
  const pick = (key: string) => {
    setPicked(key);
    setShowDetail(true);
  };
  const back = { label: installedTab ? '已安装' : '市场', onBack: () => setShowDetail(false) };
  const pickFolder = api.pickFolder
    ? () =>
        void api.pickFolder?.().then((dir) => {
          if (dir) {
            setPlace(dir);
            void addSource(dir);
          }
        })
    : undefined;
  // Its own settings page, while it is enabled (only enabled plugins' pages are listed).
  const settingsOf = (pl: PluginView): PluginPageProps[] =>
    pages ? pages.views.filter((x) => x.plugin === pl.name && x.placement === 'settings').map((v) => pages.props(v)) : [];
  const installPkg = (a: PluginPackage) => void install(a.name, (job) => ({ op: 'installAvailable', key: a.key, job }));
  const filterLabel = FILTERS.find(([f]) => f === filter)![1];

  const resultLine =
    checking !== null ? (
      <p className="provider-result plugin-note" role="status">
        正在检查更新…
      </p>
    ) : note ? (
      <p className={note.tone === 'ok' ? 'provider-result is-ok plugin-note' : note.tone === 'bad' ? 'provider-result is-bad plugin-note' : 'provider-result plugin-note'} role="status">
        {note.tone === 'info' ? null : <SpicaStatusIcon name={note.tone === 'ok' ? 'done' : 'error'} size={15} />}
        {note.text}
      </p>
    ) : null;

  /** 已安装: a part (已启用 / 已停用) with its count, its plugins one full-width row each. */
  const installedPart = (title: string, list: PluginView[]) =>
    list.length ? (
      <section className="plugins-part" aria-label={title}>
        <h3 className="plugins-part-title">
          {title}
          <span className="tab-count">{list.length}</span>
        </h3>
        <ul className="group-box group-list plugin-items">
          {list.map((p) => (
            <PluginRow key={p.name} p={p} onPick={() => pick(p.name)} />
          ))}
        </ul>
      </section>
    ) : null;

  /** 市场: what one source offers, as cards. */
  const grid = (list: PluginPackage[]) => (
    <ul className="plugin-grid">
      {list.map((a) => (
        <PackageCard key={a.key} a={a} busy={busy} running={running?.name === a.name} onPick={() => pick(`pkg:${a.key}`)} onInstall={() => installPkg(a)} />
      ))}
    </ul>
  );

  return (
    <section className={narrow ? 'settings-section plugins-page is-narrow' : 'settings-section plugins-page'} ref={root}>
      {/* 搜索设置: an installed plugin by its name or what it does (its own settings page cannot be searched). */}
      {search?.query
        ? plugins
            .filter((pl) => search.sectionHit || searchMatches(search.query, pl.displayName, pl.name, pl.description))
            .map((pl) => <SearchHit key={pl.name} title={`已安装 › ${pl.displayName}`} hint={pl.description} onGo={() => search.jumpPlugin?.(pl.name)} />)
        : null}

      {detailShown && current ? (
        <PluginDetail
          key={current.name}
          p={current}
          busy={busy}
          running={running?.name === current.name ? running : undefined}
          run={(c) => void run(c)}
          update={() => void install(current.name, (job) => ({ op: 'update', name: current.name, job }))}
          ask={(kind, pl) => setConfirm({ kind, p: pl })}
          mail={mailSources.length === 1 && current.mail ? mail : undefined}
          pages={current.enabled ? settingsOf(current) : []}
          back={back}
          note={resultLine}
        />
      ) : detailShown && currentPkg ? (
        <PackageDetail
          a={currentPkg}
          busy={busy}
          running={running?.name === currentPkg.name ? running : undefined}
          install={() => installPkg(currentPkg)}
          onShow={() => {
            setPicked(currentPkg.name);
            pickTab('installed');
          }}
          back={back}
          note={resultLine}
        />
      ) : (
        <>
          {/* One row on top (as Claude's): 已安装 / 市场, the search, then what acts on every source. */}
          <div className="plugins-bar">
            <div className="tabs plugins-tabs" role="tablist" aria-label="插件">
              {TABS.map(([t, label]) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'tab is-on' : 'tab'} onClick={() => pickTab(t)}>
                  {label}
                  {t === 'installed' && plugins.length ? <span className="tab-count">{plugins.length}</span> : null}
                </button>
              ))}
            </div>
            <input className="input plugins-search" value={query} placeholder="搜索插件" aria-label="搜索插件" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            {installedTab ? (
              <button
                type="button"
                className={filter === 'all' ? 'btn btn-small' : 'btn btn-small is-on'}
                aria-haspopup="menu"
                aria-label={`筛选：${filterLabel}`}
                onClick={(e) => {
                  const el = e.currentTarget;
                  setFilterMenu((m) => (m ? null : el));
                }}
              >
                <span className="icon-text">{filterLabel}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            ) : null}
            <button type="button" className="btn btn-small" disabled={busy || !sources.length} onClick={() => void check()}>
              {checking === '' ? <span className="spinner" aria-hidden /> : null}
              全部检查更新
            </button>
            <button
              type="button"
              className={adding ? 'btn btn-small is-on' : 'btn btn-small'}
              aria-expanded={adding}
              onClick={() => {
                // What is added is listed under 市场.
                setAdding(!adding);
                if (!adding) pickTab('market');
              }}
            >
              <Icon name="plus" size={14} />
              <span className="icon-text">添加来源</span>
            </button>
          </div>
          {filterMenu ? (
            <ContextMenu
              x={0}
              y={0}
              anchor={filterMenu}
              items={FILTERS.map(([f, label]) => ({ label: `${label} ${count(f)}`, checked: filter === f, onSelect: () => setFilter(f) }))}
              onClose={() => setFilterMenu(null)}
            />
          ) : null}

          {adding ? (
            <div className="group-box plugins-add">
              <Pane className="source-add">
                <form
                  className="install-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addSource(place);
                  }}
                >
                  <input className="input" value={place} placeholder="粘贴文件夹路径、.zip 或网址" aria-label="插件来源的位置" spellCheck={false} autoFocus onChange={(e) => setPlace(e.target.value)} />
                  {pickFolder ? (
                    <button type="button" className="btn btn-square" onClick={pickFolder} aria-label="选择文件夹" title="选择文件夹">
                      <Icon name="folder" size={16} />
                    </button>
                  ) : null}
                  <button type="submit" className="btn btn-primary" disabled={busy || !isLocation(place)}>
                    添加
                  </button>
                </form>
                <p className="settings-hint">可添加：插件文件夹、.zip、带 index.json 的文件夹或网址</p>
              </Pane>
            </div>
          ) : null}

          {resultLine}

          {installedTab ? (
            <>
              {mail && mailSources.length > 1 ? (
                <div className="settings-group plugin-mail-shared">
                  <MailSettings {...mail} extra={<Row title="来源" hint={mailSources.map((p) => p.displayName).join('、')} />} />
                </div>
              ) : null}
              <nav className="plugins-list" aria-label="插件列表">
                {state !== null && plugins.length === 0 ? (
                  <p className="settings-hint plugins-empty">未安装插件</p>
                ) : shown.length === 0 && state !== null ? (
                  <p className="settings-hint plugins-empty">{q ? '没有匹配的插件' : '没有符合条件的插件'}</p>
                ) : (
                  <>
                    {installedPart(
                      '已启用',
                      shown.filter((p) => groupOf[p.name] ?? p.enabled),
                    )}
                    {installedPart(
                      '已停用',
                      shown.filter((p) => !(groupOf[p.name] ?? p.enabled)),
                    )}
                  </>
                )}
              </nav>
              {state ? (
                <Group className="plugins-foot">
                  <Row
                    title={
                      <>
                        模拟模式
                        <InfoTip text={MOCK_TIP} label="模拟模式" />
                        {state.mock ? <span className="mock-tag">模拟数据</span> : null}
                      </>
                    }
                  >
                    <Switch on={state.mock} label="模拟模式" disabled={busy} onChange={(on) => void run({ op: 'mock', on })} />
                  </Row>
                  <Row title="插件目录" hint={state.root} path={{ hint: state.root }}>
                    <button type="button" className="btn btn-square" onClick={() => void run({ op: 'openRoot' })} aria-label="打开文件夹" title="打开文件夹">
                      <Icon name="folder" size={16} />
                    </button>
                  </Row>
                </Group>
              ) : null}
            </>
          ) : (
            <nav className="plugins-list" aria-label="插件列表">
              {/* No official source in this build: said, with where it is set, so an empty list does not look broken. */}
              {state !== null && !sources.some((x) => x.official) ? <p className="settings-hint sources-no-official">没有配置官方来源。官方来源在打包时写进 deploy.json 的 pluginSources。</p> : null}
              {state !== null && sources.length === 0 && single.length === 0 ? <p className="settings-hint plugins-empty">没有插件来源</p> : null}
              {/* By source (the official ones first, as they are listed): its name, how it went, 检查更新 and 移除 on its
                  title line, then what it offers as cards. */}
              <ul className="plugin-sources" aria-label="插件来源">
                {sources.map((s) => {
                  const list = offered.filter((a) => a.source === s.location);
                  const matching = list.filter(pkgHit);
                  if (q && matching.length === 0) return null;
                  return (
                    <li key={s.location} className="plugins-part">
                      <div className="plugins-part-head">
                        <div className="plugins-part-text">
                          <h3 className="plugins-part-title" title={s.location}>
                            <span className="path-text">{s.label ?? s.location}</span>
                            {/* An official source (deploy.json): said in quiet words, as 默认 in 模型; it cannot be removed. */}
                            {s.official ? <span className="provider-default source-official">官方</span> : null}
                            {list.length ? <span className="tab-count">{list.length}</span> : null}
                          </h3>
                          <span className={s.error ? 'settings-hint source-failed' : 'settings-hint'} title={s.error}>
                            {sourceLine(s)}
                          </span>
                        </div>
                        <div className="plugins-part-actions">
                          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void check(s.location)}>
                            {checking === s.location ? <span className="spinner" aria-hidden /> : null}
                            检查更新
                          </button>
                          {s.official ? null : (
                            <button type="button" className="btn btn-small btn-quiet-danger btn-square" disabled={busy} onClick={() => setConfirm({ kind: 'removeSource', s })} aria-label="移除来源" title="移除来源">
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {matching.length ? grid(matching) : s.error ? null : <p className="settings-hint plugins-none">这个来源里没有插件</p>}
                    </li>
                  );
                })}
                {single.filter(pkgHit).length ? (
                  <li className="plugins-part">
                    <div className="plugins-part-head">
                      <h3 className="plugins-part-title">找到的插件</h3>
                    </div>
                    {grid(single.filter(pkgHit))}
                  </li>
                ) : null}
              </ul>
            </nav>
          )}
        </>
      )}

      {confirm ? (
        <ConfirmDialog
          title={
            confirm.kind === 'removeSource'
              ? `移除来源「${confirm.s.label ?? confirm.s.location}」？`
              : confirm.kind === 'uninstall'
                ? `删除插件「${confirm.p.displayName}」？`
                : `将「${confirm.p.displayName}」回退到 ${confirm.p.previousVersion}？`
          }
          {...(confirm.kind === 'uninstall' ? { detail: '该插件的工具和页面将不再可用。' } : {})}
          confirmLabel={confirm.kind === 'removeSource' ? '移除' : confirm.kind === 'uninstall' ? '删除' : '回退'}
          danger={confirm.kind !== 'rollback'}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            if (c.kind === 'removeSource') void run({ op: 'removeSource', location: c.s.location });
            else {
              // Deleted: its page is gone, back to the list.
              if (c.kind === 'uninstall') setShowDetail(false);
              void run({ op: c.kind, name: c.p.name });
            }
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
