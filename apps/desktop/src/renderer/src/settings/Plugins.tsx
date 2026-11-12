// Settings > 插件: the plugins as a list on the left (已启用 / 已停用, and 未安装:
// what the remembered sources offer) and the one picked on the right: its switch
// beside the name, a row of what can be done to it (安装 / 更新到 / 回退到 /
// 删除, and while it installs, how far it is), then its model budget, mail
// sorting and what it has, and its own settings pages (views with placement settings) under tabs. One box at the top searches, or, given a folder,
// .zip, shared folder or web address, lists what is there to install.
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
  type NotFoundReason,
  type PluginsFound,
  type PluginIconView,
  type PluginModelView,
  type PluginPackage,
  type PluginsCommand,
  type PluginsProgress,
  type PluginsResult,
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

const NOT_FOUND_TITLE: Record<NotFoundReason, string> = {
  missing: '找不到该位置',
  unreadable: '无法打开',
  unreachable: '无法连接',
  empty: '没有找到插件',
};

/**
 * A typed location held nothing to install: what was looked at, which way it failed, and what can be done
 * next (pick a folder, try again when it could not be reached or opened, or clear the box).
 */
function NotFound({ found, onPick, onRetry, onClear }: { found: PluginsFound; onPick?: (() => void) | undefined; onRetry(): void; onClear(): void }) {
  const reason = found.reason ?? 'unreadable';
  const title = NOT_FOUND_TITLE[reason];
  return (
    <section className="card plugins-notfound" role="status" aria-label={title}>
      <SpicaStatusIcon name={reason === 'empty' ? 'info' : 'warning'} size={22} />
      <h3 className="plugins-notfound-title">{title}</h3>
      <p className="plugins-notfound-where" title={found.location}>
        {found.location}
      </p>
      {reason === 'empty' ? (
        <p className="plugins-notfound-detail">可安装：插件文件夹、.zip、带 index.json 的文件夹或网址</p>
      ) : reason !== 'missing' && found.error ? (
        <p className="plugins-notfound-detail">{found.error}</p>
      ) : null}
      <div className="plugins-notfound-actions">
        {onPick ? (
          <button type="button" className="btn btn-small" onClick={onPick}>
            <Icon name="folder" size={14} />
            选择文件夹
          </button>
        ) : null}
        {reason === 'unreachable' || reason === 'unreadable' ? (
          <button type="button" className="btn btn-small" onClick={onRetry}>
            重试
          </button>
        ) : null}
        <button type="button" className="btn btn-small" onClick={onClear}>
          清除
        </button>
      </div>
    </section>
  );
}

/** What 模拟模式 does, on hover beside it. */
export const MOCK_TIP = '插件改用演示数据，不连接真实系统。';

/** How long a typed location rests before it is looked at (Enter, a paste or a picked folder look at once). */
export const LOOK_AFTER_MS = 500;

let jobs = 0;

export function Plugins({ api, mail, pages }: { api: PluginsApi; mail?: MailSettingsProps; pages?: SettingsPages | undefined }) {
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false);
  // 'info': a notice (no sources to check), shown plain like 正在检查更新….
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  // 检查更新 running: said beside the result line until it ends.
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'uninstall' | 'rollback'; p: PluginView } | null>(null);
  // The one box: a search term, or a folder / .zip / address to look at.
  const [query, setQuery] = useKeptDraft('plugins.query', '');
  const [filter, setFilter] = useState<Filter>('all');
  // What is picked: an installed plugin by name, or a package by 'pkg:' + key.
  const [picked, setPicked] = useState<string | null>(null);
  // A lookup of a typed location is under way (its number; older answers are dropped).
  const [looking, setLooking] = useState(0);
  const lookSeq = useRef(0);
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
    // What the page had last time shows first; the remembered sources are listed again behind it (未安装).
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

  /** Look at a typed location (not through run(): it never blocks or is blocked by a command, and says nothing in the result line). */
  const look = useCallback(
    (text: string) => {
      if (!isLocation(text)) return;
      const n = ++lookSeq.current;
      setLooking(n);
      // The result line was about the last action, not this place.
      setNote(null);
      void api
        .run({ op: 'find', location: unquote(text) })
        .then((r) => {
          if (n === lookSeq.current) setState(r.state);
        })
        .catch(() => {})
        .finally(() => {
          if (n === lookSeq.current) setLooking(0);
        });
    },
    [api],
  );

  // A location typed and left for a moment is looked at.
  useEffect(() => {
    if (!isLocation(query)) return;
    const t = setTimeout(() => look(query), LOOK_AFTER_MS);
    return () => clearTimeout(t);
  }, [query, look]);

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
      // Now it is installed (and on): back to the list, its group is its state now, and it is the one shown.
      if (isLocation(query)) setQuery('');
      setGroupOf((g) => {
        const { [name]: _gone, ...rest } = g;
        void _gone;
        return rest;
      });
      if (r.state.plugins.some((p) => p.name === name)) setPicked(name);
    }
  };

  const located = isLocation(query);
  const q = located ? '' : query.trim().toLowerCase();
  const found = located && state?.found && state.found.location === unquote(query) ? state.found : undefined;
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  const shown = located ? [] : plugins.filter((p) => matches(p, filter) && hit(`${p.displayName} ${p.name} ${p.description}`));
  // A package of a plugin already here goes by that plugin's name and icon when it does not say its own (an index says neither).
  const known = (a: PluginPackage): PluginPackage => {
    const p = a.installed ? plugins.find((x) => x.name === a.name) : undefined;
    return p ? { ...a, displayName: a.displayName ?? p.displayName, ...(a.icon || !p.icon ? {} : { icon: p.icon }) } : a;
  };
  const offered = (located ? (found?.packages ?? []) : filter === 'all' ? (state?.available ?? []).filter((a) => hit(`${pkgTitle(a)} ${a.name} ${a.description ?? ''}`)) : []).map(known);
  const groups: { key: string; title: string; plugins?: PluginView[]; packages?: PluginPackage[] }[] = [
    { key: 'on', title: '已启用', plugins: shown.filter((p) => groupOf[p.name] ?? p.enabled) },
    { key: 'off', title: '已停用', plugins: shown.filter((p) => !(groupOf[p.name] ?? p.enabled)) },
    // A location's packages of plugins already here are said apart from the new ones.
    { key: 'have', title: '已安装', packages: offered.filter((a) => a.installed) },
    { key: 'new', title: '未安装', packages: offered.filter((a) => !a.installed) },
  ].filter((g) => (g.plugins ?? g.packages ?? []).length);
  const firstKey = groups[0]?.plugins?.[0]?.name ?? (groups[0]?.packages?.[0] ? `pkg:${groups[0].packages[0].key}` : null);
  const pickedKey = picked && (shown.some((p) => p.name === picked) || offered.some((a) => `pkg:${a.key}` === picked)) ? picked : firstKey;
  const current = pickedKey && !pickedKey.startsWith('pkg:') ? shown.find((p) => p.name === pickedKey) : undefined;
  const currentPkg = pickedKey?.startsWith('pkg:') ? offered.find((a) => `pkg:${a.key}` === pickedKey) : undefined;
  const count = (f: Filter) => plugins.filter((p) => matches(p, f)).length;
  const nothing = state !== null && plugins.length === 0 && !(state.available?.length ?? 0) && !located;
  const listView = !narrow || !showDetail;
  const detailView = !narrow || showDetail;
  const pick = (key: string) => {
    setPicked(key);
    setShowDetail(true);
  };
  const emptyText = located ? (looking ? '正在查找…' : '') : q ? '没有匹配的插件' : '没有符合条件的插件';
  // A typed location with nothing to install: said in full in place of the list and the detail.
  const notFound = located && !looking && found?.error ? found : undefined;
  const pickFolder = api.pickFolder
    ? () =>
        void api.pickFolder?.().then((dir) => {
          if (dir) {
            setQuery(dir);
            look(dir);
          }
        })
    : undefined;
  // Its own settings page, while it is enabled (only enabled plugins' pages are listed).
  const settingsOf = (pl: PluginView): PluginPageProps[] =>
    pages ? pages.views.filter((x) => x.plugin === pl.name && x.placement === 'settings').map((v) => pages.props(v)) : [];

  return (
    <section className={narrow ? 'settings-section plugins-page is-narrow' : 'settings-section plugins-page'} ref={root}>
      {mail && mailSources.length > 1 ? (
        <div className="settings-group">
          <div className="card plugin-mail-shared">
            <MailSettings {...mail} />
            <p className="plugin-mail-sources">
              <span className="field-label">来源</span>
              {mailSources.map((p) => p.displayName).join('、')}
            </p>
          </div>
        </div>
      ) : null}

      {listView ? (
        <div className="plugins-bar">
          <form
            className="plugins-find"
            onSubmit={(e) => {
              e.preventDefault();
              look(query);
            }}
          >
            <input
              className="input plugins-search"
              value={query}
              placeholder="搜索插件，或输入路径、网址"
              aria-label="搜索插件"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                // Pasted: look now, not after the pause.
                if ((e.nativeEvent as InputEvent).inputType === 'insertFromPaste') look(e.target.value);
              }}
            />
            {pickFolder ? (
              <button type="button" className="btn btn-square" onClick={pickFolder} aria-label="选择文件夹" title="选择文件夹">
                <Icon name="folder" size={16} />
              </button>
            ) : null}
          </form>
          {plugins.length ? (
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
          ) : null}
          <button
            type="button"
            className="btn btn-square"
            disabled={busy || !plugins.length}
            onClick={() => {
              setChecking(true);
              setNote(null);
              void run({ op: 'checkUpdates' }).finally(() => setChecking(false));
            }}
            aria-label="检查更新"
            title="检查更新"
          >
            {checking ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
          </button>
        </div>
      ) : null}

      {nothing ? <p className="settings-hint plugins-empty">未安装插件</p> : null}

      {checking ? (
        <p className="provider-result plugin-note" role="status">
          正在检查更新…
        </p>
      ) : note ? (
        <p className={note.tone === 'ok' ? 'provider-result is-ok plugin-note' : note.tone === 'bad' ? 'provider-result is-bad plugin-note' : 'provider-result plugin-note'} role="status">
          {note.tone === 'info' ? null : <SpicaStatusIcon name={note.tone === 'ok' ? 'done' : 'error'} size={15} />}
          {note.text}
        </p>
      ) : null}

      {nothing ? null : notFound ? (
        <div className="plugins-two">
          <NotFound found={notFound} onPick={pickFolder} onRetry={() => look(query)} onClear={() => setQuery('')} />
        </div>
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
              ) : emptyText ? (
                <p className="settings-hint plugins-none">{emptyText}</p>
              ) : null}
              {!located && filter === 'all' && state?.sourceErrors?.length ? (
                <p className="settings-hint plugins-none" title={state.sourceErrors.join('\n')}>
                  {state.sourceErrors.length} 个插件来源连接失败
                </p>
              ) : null}
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

      {state && listView ? (
        <div className="settings-group plugins-foot">
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-title">
                模拟模式
                <InfoTip text={MOCK_TIP} label="模拟模式" />
                {state.mock ? <span className="mock-tag">模拟数据</span> : null}
              </span>
            </div>
            <Switch on={state.mock} label="模拟模式" disabled={busy} onChange={(on) => void run({ op: 'mock', on })} />
          </div>
          <p className="plugin-root">
            <span className="settings-hint">插件目录</span>
            <span className="detail-path" title={state.root} data-tip-clipped="">
              {state.root}
            </span>
            <button type="button" className="icon-btn" onClick={() => void run({ op: 'openRoot' })} aria-label="打开文件夹" title="打开文件夹">
              <Icon name="folder" size={16} />
            </button>
          </p>
        </div>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.kind === 'uninstall' ? `删除插件「${confirm.p.displayName}」？` : `将「${confirm.p.displayName}」回退到 ${confirm.p.previousVersion}？`}
          {...(confirm.kind === 'uninstall' ? { detail: '该插件的工具和页面将不再可用。' } : {})}
          confirmLabel={confirm.kind === 'uninstall' ? '删除' : '回退'}
          danger={confirm.kind === 'uninstall'}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void run({ op: c.kind, name: c.p.name });
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
