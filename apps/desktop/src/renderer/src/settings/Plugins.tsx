// Settings > 插件, two tabs. 已安装: the plugins as a list on the left (已启用 / 已停用; the box on top searches
// them, the filter narrows them, 检查更新 checks every source) and the one picked on the right: its switch
// beside the name, a row of what can be done to it (更新到 / 回退到 / 删除, and while it updates, how far it
// is), then its model budget, mail sorting and what it has, and its own settings pages (views with placement
// settings) under tabs. 市场: the plugin sources (检查更新 for each and for all, 添加来源 for a folder, .zip or
// web address, 移除), then what they offer and is not installed, each with 安装.
// A plugin turned on or off stays where it is in the list while the page is
// open; it moves to its group the next time the page opens (the counts are only
// in the filter, as things are now). Mock mode and the plugin folder are at the bottom.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { Icon } from '../ui/Icon';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { InfoTip } from '../ui/InfoTip';
import { MailSettings, type MailSettingsProps } from './MailSettings';
import { Group, Pane, Row } from './Group';
import { SpicaStatusIcon } from '@spica/brand/react';
import type { PluginView as PageView } from '../../../shared/plugin-view';
import { PluginPage, type PluginPageProps } from '../shell/PluginFrame';

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
 * itself. The page's two backgrounds are swapped: its own (--spica-bg) is the card's, and what it sets apart
 * (buttons, boxes on --spica-surface) gets the window's, so it still stands out on the card.
 */
function settingsTheme(page: PluginPageProps): PluginPageProps['theme'] {
  const vars = page.theme.vars;
  const bg = vars['--spica-bg'] ?? '';
  const surface = vars['--spica-surface'] ?? bg;
  return { ...page.theme, vars: { ...vars, '--spica-bg': surface, '--spica-surface': bg } };
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
            {used >= m.maxUsdPerDay ? ` · 今日 ${spentText(used)}（已达上限）` : ` · 今日 ${spentText(used)}`}
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

/** Badge colours: mid tones that carry white text on a light or a dark skin. */
const BADGE_COLOURS = ['#4f7cff', '#16a37f', '#c2410c', '#7c3aed', '#0e7490', '#b45309', '#be185d', '#4d7c0f', '#1d4ed8', '#9333ea', '#0f766e', '#a16207'];

/** A plugin's badge: the first character of its name (a letter in upper case) on a colour its id always gets. */
export function pluginBadge(p: { name: string; displayName: string }): { letter: string; colour: string } {
  const first = [...(p.displayName.trim() || p.name)][0] ?? '?';
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return { letter: /[a-z]/i.test(first) ? first.toUpperCase() : first, colour: BADGE_COLOURS[h % BADGE_COLOURS.length]! };
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

/** One row of the list: name and version, a refresh mark when there is an update, the error mark when something is wrong. */
function PluginRow({ p, on, onPick }: { p: PluginView; on: boolean; onPick(): void }) {
  const problems = pluginProblems(p);
  return (
    <li>
      <button type="button" className={['plugin-row', on ? 'is-on' : '', p.enabled ? '' : 'is-off'].filter(Boolean).join(' ')} aria-current={on ? 'true' : undefined} onClick={onPick}>
        <Badge name={p.name} displayName={p.displayName} icon={p.icon} />
        <span className="plugin-row-name">{p.displayName}</span>
        <span className="plugin-version plugin-row-version">{p.version}</span>
        {p.update ? (
          <span className="plugin-row-mark" role="img" aria-label={`有更新：${p.update}`} title={`有更新：${p.update}`}>
            <Icon name="refresh" size={12} />
          </span>
        ) : null}
        {problems.length ? <SpicaStatusIcon name="error" size={13} title={problems.join('；')} /> : null}
        {p.enabled ? null : <span className="visually-hidden">已停用</span>}
      </button>
    </li>
  );
}

/** A package not installed (or found at a typed location): name and version, as a plugin's row. */
function PackageRow({ a, on, onPick }: { a: PluginPackage; on: boolean; onPick(): void }) {
  return (
    <li>
      <button type="button" className={on ? 'plugin-row is-on' : 'plugin-row'} aria-current={on ? 'true' : undefined} onClick={onPick}>
        <Badge name={a.name} displayName={pkgTitle(a)} icon={a.icon} />
        <span className="plugin-row-name">{pkgTitle(a)}</span>
        {a.version ? <span className="plugin-version plugin-row-version">{a.version}</span> : <span className="plugin-row-version" />}
      </button>
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

/** How far the install is: the step in words, the seconds so far; a bar while the download size is known. */
function Progress({ run }: { run: Running }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = run.step;
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const held = s?.step === 'replace' && s.busyMs !== undefined;
  const share = s?.step === 'download' && s.total ? Math.min(1, s.received / s.total) : null;
  return (
    <div className={held ? 'plugin-progress is-held' : 'plugin-progress'} role="status">
      <span className="plugin-progress-line">
        <SpicaStatusIcon name="running" size={14} />
        <span className="plugin-progress-text">{s ? stepText(s) : '正在安装'}</span>
        <span className="plugin-progress-time">{seconds} 秒</span>
      </span>
      {share !== null ? (
        <span className="plugin-progress-bar" aria-hidden>
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** The row of what can be done to it, at the top of the detail; while it installs, how far it is. */
function Actions({ running, children }: { running: Running | undefined; children: React.ReactNode }) {
  return <div className="plugin-actions">{running ? <Progress run={running} /> : children}</div>;
}

/**
 * The plugin picked: switch beside its name, what can be done to it right below, then what it does, needs, has.
 * An enabled plugin with settings pages gets a row of tabs under that: 详情 (all of the above but the two top
 * rows) and one per page. A page loads when its tab is first picked and stays (hidden) while 详情 is shown, so
 * what was typed in it is still there; another plugin starts over at 详情 (the detail is keyed by plugin).
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
  onBack,
}: {
  p: PluginView;
  busy: boolean;
  running: Running | undefined;
  run(cmd: PluginsCommand): void;
  update(): void;
  ask(kind: 'uninstall' | 'rollback', p: PluginView): void;
  mail?: MailSettingsProps | undefined;
  pages?: PluginPageProps[] | undefined;
  onBack?: (() => void) | undefined;
}) {
  const problems = pluginProblems(p);
  const [picked, setPicked] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  // A page gone (the plugin turned off, updated without it): back on 详情.
  const tab = pages.some((g) => g.view.id === picked) ? picked : '';
  const pick = (id: string) => {
    setPicked(id);
    if (id && !opened.includes(id)) setOpened([...opened, id]);
  };
  const cls = ['card plugin-card plugin-detail', p.enabled ? '' : 'is-off', tab ? 'is-page' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label={p.displayName}>
      {onBack ? (
        <button type="button" className="text-btn plugin-back" onClick={onBack}>
          <Icon name="back" size={14} />
          插件
        </button>
      ) : null}
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge name={p.name} displayName={p.displayName} icon={p.icon} />
          <span className="plugin-name">{p.displayName}</span>
          <span className="plugin-version">{p.version}</span>
        </div>
        <Switch on={p.enabled} label={p.enabled ? `停用「${p.displayName}」` : `启用「${p.displayName}」`} disabled={busy} onChange={(on) => run({ op: on ? 'enable' : 'disable', name: p.name })} />
      </header>
      <Actions running={running}>
        {p.update ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={update}>
            更新到 {p.update}
          </button>
        ) : null}
        {p.previousVersion ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => ask('rollback', p)}>
            回退到 {p.previousVersion}
          </button>
        ) : null}
        <button type="button" className="btn btn-small btn-quiet-danger btn-square" disabled={busy} onClick={() => ask('uninstall', p)} aria-label="删除" title="删除">
          <Icon name="trash" size={14} />
        </button>
      </Actions>
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
          {p.source ? (
            <>
              <dt>来源</dt>
              <dd className="detail-path" title={p.source.location} data-tip-clipped="">
                {p.source.location}
              </dd>
            </>
          ) : null}
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

/** What 安装 says for a package: install, install again (the same version), or install that version over the one there. */
function installLabel(a: PluginPackage): string {
  if (!a.installed) return '安装';
  if (a.version === a.installed) return '重新安装';
  return a.version ? `安装 ${a.version}` : '安装';
}

/** A package picked in the list: what it says about itself, where it is, and 安装 (with its progress) at the top. */
function PackageDetail({ a, busy, running, install, onBack }: { a: PluginPackage; busy: boolean; running: Running | undefined; install(): void; onBack?: (() => void) | undefined }) {
  return (
    <section className="card plugin-card plugin-detail" aria-label={pkgTitle(a)}>
      {onBack ? (
        <button type="button" className="text-btn plugin-back" onClick={onBack}>
          <Icon name="back" size={14} />
          插件
        </button>
      ) : null}
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge name={a.name} displayName={pkgTitle(a)} icon={a.icon} />
          <span className="plugin-name">{pkgTitle(a)}</span>
          {a.version ? <span className="plugin-version">{a.version}</span> : null}
        </div>
      </header>
      <Actions running={running}>
        <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={install}>
          {installLabel(a)}
        </button>
      </Actions>
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
        <dt>来源</dt>
        <dd className="detail-path" title={a.location} data-tip-clipped="">
          {a.location}
        </dd>
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

/** From this window width up, 市场 › 插件来源 starts open; narrower, folded. */
export const SOURCES_OPEN_FROM = 1280;

export interface PluginsProps {
  api: PluginsApi;
  mail?: MailSettingsProps;
  pages?: SettingsPages | undefined;
  /** Which tab is open, when the caller keeps it (the sidebar's 插件市场 opens 市场); else the page keeps it. */
  tab?: PluginsTab;
  onTab?: (tab: PluginsTab) => void;
}

export function Plugins({ api, mail, pages, tab: tabProp, onTab }: PluginsProps) {
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false);
  // 'info': a notice (no sources to check), shown plain like 正在检查更新….
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  // 检查更新 running (all sources, or one by its location): said beside it until it ends.
  const [checking, setChecking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'uninstall' | 'rollback'; p: PluginView } | { kind: 'removeSource'; s: PluginSourceView } | null>(null);
  const [ownTab, setOwnTab] = useKeptDraft('plugins.tab', 'installed');
  const tab: PluginsTab = tabProp ?? (ownTab === 'market' ? 'market' : 'installed');
  const pickTab = (t: PluginsTab) => {
    setOwnTab(t);
    onTab?.(t);
    setNote(null);
  };
  // 已安装's search box: only the installed plugins.
  const [query, setQuery] = useKeptDraft('plugins.query', '');
  const [filter, setFilter] = useState<Filter>('all');
  // 添加来源: open, and what is typed in it.
  const [adding, setAdding] = useState(false);
  // 插件来源 folded: on a window narrower than 1280 it starts folded (the list below gets the room); its title
  // line still says how many sources there are and how many could not be read.
  const [sourcesOpen, setSourcesOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= SOURCES_OPEN_FROM);
  const [place, setPlace] = useKeptDraft('plugins.addSource', '');
  // What was last added: a single package on the web is listed under it to install.
  const [added, setAdded] = useState<string | null>(null);
  // What is picked: an installed plugin by name, or a package by 'pkg:' + key.
  const [picked, setPicked] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | undefined>(undefined);
  const runningRef = useRef<Running | undefined>(undefined);
  // Which group each plugin is shown in, fixed while the page is open (turning one off does not move it).
  const [groupOf, setGroupOf] = useState<Record<string, boolean>>({});
  // Narrow: the list and the detail take turns.
  const root = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  // Turning narrow starts at the list.
  const [wasNarrow, setWasNarrow] = useState(false);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    if (narrow) setShowDetail(false);
  }
  const plugins = useMemo(() => state?.plugins ?? [], [state]);
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
        // Shown under 已安装, with the result line (已安装「…」) kept.
        setOwnTab('installed');
        onTab?.('installed');
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
  const shown = installedTab ? plugins.filter((p) => matches(p, filter) && hit(`${p.displayName} ${p.name} ${p.description}`)) : [];
  // A package of a plugin already here goes by that plugin's name and icon when it does not say its own (an index says neither).
  const known = (a: PluginPackage): PluginPackage => {
    const p = a.installed ? plugins.find((x) => x.name === a.name) : undefined;
    return p ? { ...a, displayName: a.displayName ?? p.displayName, ...(a.icon || !p.icon ? {} : { icon: p.icon }) } : a;
  };
  const sources = state?.sources ?? [];
  const failedSources = sources.filter((s) => s.error).length;
  // 市场: what the sources offer; and a single package on the web just typed into 添加来源 (it cannot be a source).
  const single = !installedTab && added && state?.found?.location === added && !sources.some((s) => s.location === added) ? state.found.packages.map(known) : [];
  const offered = installedTab ? [] : [...(state?.available ?? []).map(known), ...single];
  type ListGroup = { key: string; title: string; plugins?: PluginView[]; packages?: PluginPackage[] };
  const allGroups: ListGroup[] = installedTab
    ? [
        { key: 'on', title: '已启用', plugins: shown.filter((p) => groupOf[p.name] ?? p.enabled) },
        { key: 'off', title: '已停用', plugins: shown.filter((p) => !(groupOf[p.name] ?? p.enabled)) },
      ]
    : [{ key: 'new', title: '可安装', packages: offered }];
  const groups = allGroups.filter((g) => (g.plugins ?? g.packages ?? []).length);
  const firstKey = groups[0]?.plugins?.[0]?.name ?? (groups[0]?.packages?.[0] ? `pkg:${groups[0].packages[0].key}` : null);
  const pickedKey = picked && (shown.some((p) => p.name === picked) || offered.some((a) => `pkg:${a.key}` === picked)) ? picked : firstKey;
  const current = pickedKey && !pickedKey.startsWith('pkg:') ? shown.find((p) => p.name === pickedKey) : undefined;
  const currentPkg = pickedKey?.startsWith('pkg:') ? offered.find((a) => `pkg:${a.key}` === pickedKey) : undefined;
  const count = (f: Filter) => plugins.filter((p) => matches(p, f)).length;
  const nothing = state !== null && (installedTab ? plugins.length === 0 : offered.length === 0);
  const listView = !narrow || !showDetail;
  const detailView = !narrow || showDetail;
  const pick = (key: string) => {
    setPicked(key);
    setShowDetail(true);
  };
  const emptyText = q ? '没有匹配的插件' : '没有符合条件的插件';
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

  return (
    <section className={narrow ? 'settings-section plugins-page is-narrow' : 'settings-section plugins-page'} ref={root}>
      <div className="tabs plugins-tabs" role="tablist" aria-label="插件">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'tab is-on' : 'tab'} onClick={() => pickTab(t)}>
            {label}
            {t === 'installed' && plugins.length ? <span className="tab-count">{plugins.length}</span> : null}
          </button>
        ))}
      </div>

      {installedTab && mail && mailSources.length > 1 ? (
        <div className="settings-group plugin-mail-shared">
          <MailSettings {...mail} extra={<Row title="来源" hint={mailSources.map((p) => p.displayName).join('、')} />} />
        </div>
      ) : null}

      {installedTab && listView && plugins.length ? (
        <div className="plugins-bar">
          <input className="input plugins-search" value={query} placeholder="搜索已安装的插件" aria-label="搜索插件" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          <div className="segmented plugins-filter" role="radiogroup" aria-label="筛选">
            {(
              [
                ['all', '全部'],
                ['on', '已启用'],
                ['update', '有更新'],
                ['problem', '有问题'],
              ] as const
            ).map(([f, label]) => (
              <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'segment is-on' : 'segment'} onClick={() => setFilter(f)}>
                {label} {count(f)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-square" disabled={busy} onClick={() => void check()} aria-label="检查更新" title="检查更新">
            {checking !== null ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
          </button>
        </div>
      ) : null}

      {!installedTab && listView ? (
        <Group
          title={
            <button type="button" className="fold-head sources-fold" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(!sourcesOpen)}>
              <span className="fold-label">插件来源</span>
              <Icon name="chevronRight" size={14} className="fold-chevron" />
              {sourcesOpen ? null : (
                <span className="sources-summary">
                  {sources.length ? `${sources.length} 个来源` : '没有来源'}
                  {failedSources ? <span className="source-failed">{` · ${failedSources} 个连接失败`}</span> : null}
                </span>
              )}
            </button>
          }
          className="plugin-sources"
          folded={!sourcesOpen}
          actions={
            <>
              <button type="button" className="btn btn-small" disabled={busy || !sources.length} onClick={() => void check()}>
                {checking === '' ? <span className="spinner" aria-hidden /> : null}
                全部检查更新
              </button>
              <button
                type="button"
                className={adding && sourcesOpen ? 'btn btn-small is-on' : 'btn btn-small'}
                onClick={() => {
                  // Folded: open the group with the box to type in.
                  setAdding(!adding || !sourcesOpen);
                  setSourcesOpen(true);
                }}
                aria-expanded={adding && sourcesOpen}
              >
                <Icon name="plus" size={14} />
                添加来源
              </button>
            </>
          }
        >
          {adding ? (
            <Pane className="source-add">
              <form
                className="install-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addSource(place);
                }}
              >
                <input
                  className="input"
                  value={place}
                  placeholder="粘贴文件夹路径、.zip 或网址"
                  aria-label="插件来源的位置"
                  spellCheck={false}
                  autoFocus
                  onChange={(e) => setPlace(e.target.value)}
                />
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
          ) : null}
          {sources.length ? (
            <ul className="group-list" aria-label="插件来源">
              {sources.map((s) => (
                <li key={s.location}>
                  <Row
                    title={
                      <>
                        {s.label ?? s.location}
                        {/* An official source (deploy.json): said in quiet words, as 默认 in 模型; it cannot be removed. */}
                        {s.official ? <span className="provider-default source-official">官方</span> : null}
                      </>
                    }
                    path={{ title: s.location }}
                    hint={<span className={s.error ? 'source-failed' : undefined} title={s.error}>{sourceLine(s)}</span>}
                  >
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => void check(s.location)}>
                      {checking === s.location ? <span className="spinner" aria-hidden /> : null}
                      检查更新
                    </button>
                    {s.official ? null : (
                      <button type="button" className="btn btn-small btn-quiet-danger btn-square" disabled={busy} onClick={() => setConfirm({ kind: 'removeSource', s })} aria-label="移除来源" title="移除来源">
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </Row>
                </li>
              ))}
            </ul>
          ) : adding ? null : (
            <Pane>
              <p className="settings-hint">没有插件来源</p>
            </Pane>
          )}
        </Group>
      ) : null}

      {resultLine}

      {nothing ? (
        <p className="settings-hint plugins-empty">{installedTab ? '未安装插件' : '没有可安装的插件'}</p>
      ) : (
        <div className="plugins-two">
          {listView ? (
            <nav className="plugins-list" aria-label="插件列表">
              {groups.length ? (
                groups.map((g) => (
                  <div key={g.key} className="plugins-group">
                    <h3 className="plugins-group-title">{g.title}</h3>
                    <ul>
                      {g.plugins?.map((p) => <PluginRow key={p.name} p={p} on={!narrow && current?.name === p.name} onPick={() => pick(p.name)} />)}
                      {g.packages?.map((a) => <PackageRow key={a.key} a={a} on={!narrow && currentPkg?.key === a.key} onPick={() => pick(`pkg:${a.key}`)} />)}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="settings-hint plugins-none">{emptyText}</p>
              )}
            </nav>
          ) : null}
          {detailView && current ? (
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
              onBack={narrow ? () => setShowDetail(false) : undefined}
            />
          ) : detailView && currentPkg ? (
            <PackageDetail
              a={currentPkg}
              busy={busy}
              running={running?.name === currentPkg.name ? running : undefined}
              install={() => void install(currentPkg.name, (job) => ({ op: 'installAvailable', key: currentPkg.key, job }))}
              onBack={narrow ? () => setShowDetail(false) : undefined}
            />
          ) : null}
        </div>
      )}

      {state && installedTab && listView ? (
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
            else void run({ op: c.kind, name: c.p.name });
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
