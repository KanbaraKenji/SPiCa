// Settings > 插件: the installed plugins as a list on the left (已启用 / 已停用,
// with search and a status filter) and the one picked on the right with its
// switch, update, model budget, mail sorting, tools and going back / deleting.
// A plugin turned on or off stays where it is in the list while the page is
// open; it moves to its group the next time the page opens (the counts are only
// in the filter, as things are now). Mock mode and the
// plugin folder are at the bottom; installing opens from the + at the top.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { spentText, usd, type PluginModelView, type PluginsCommand, type PluginsResult, type PluginsState, type PluginView } from '../../../shared/plugins';
import { friendlyError } from '../store/agent';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { MailSettings, type MailSettingsProps } from './MailSettings';
import { SpicaStatusIcon } from '@spica/brand/react';

export interface PluginsApi {
  run(cmd: PluginsCommand): Promise<PluginsResult>;
  onChanged(listener: () => void): () => void;
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
  const [limit, setLimit] = useState(String(m.maxUsdPerDay));
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
        <button type="button" className="btn btn-small" disabled={busy || problem !== null || value === m.maxUsdPerDay} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: value })}>
          保存
        </button>
        {value !== m.maxUsdPerDay && limit.trim() !== '' ? <span className="provider-unsaved">未保存</span> : null}
        {off ? null : (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: 0 })}>
            禁止使用模型
          </button>
        )}
        {m.userMaxUsdPerDay !== undefined ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: null })}>
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
export function pluginBadge(p: Pick<PluginView, 'name' | 'displayName'>): { letter: string; colour: string } {
  const first = [...(p.displayName.trim() || p.name)][0] ?? '?';
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return { letter: /[a-z]/i.test(first) ? first.toUpperCase() : first, colour: BADGE_COLOURS[h % BADGE_COLOURS.length]! };
}

function Badge({ p }: { p: PluginView }) {
  const b = pluginBadge(p);
  return (
    <span className="plugin-badge" style={{ background: b.colour }} aria-hidden>
      {b.letter}
    </span>
  );
}

/** One row of the list: name, a refresh mark when there is an update, the error mark when something is wrong. */
function PluginRow({ p, on, onPick }: { p: PluginView; on: boolean; onPick(): void }) {
  const problems = pluginProblems(p);
  return (
    <li>
      <button type="button" className={['plugin-row', on ? 'is-on' : '', p.enabled ? '' : 'is-off'].filter(Boolean).join(' ')} aria-current={on ? 'true' : undefined} onClick={onPick}>
        <Badge p={p} />
        <span className="plugin-row-name">{p.displayName}</span>
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

/** The plugin picked: switch at the top, then what it does, what it needs, what it has. */
function PluginDetail({
  p,
  busy,
  run,
  ask,
  mail,
  onBack,
}: {
  p: PluginView;
  busy: boolean;
  run(cmd: PluginsCommand): void;
  ask(kind: 'uninstall' | 'rollback', p: PluginView): void;
  mail?: MailSettingsProps | undefined;
  onBack?: (() => void) | undefined;
}) {
  const problems = pluginProblems(p);
  return (
    <section className={p.enabled ? 'card plugin-card plugin-detail' : 'card plugin-card plugin-detail is-off'} aria-label={p.displayName}>
      {onBack ? (
        <button type="button" className="text-btn plugin-back" onClick={onBack}>
          <Icon name="back" size={14} />
          插件
        </button>
      ) : null}
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge p={p} />
          <span className="plugin-name">{p.displayName}</span>
          <span className="plugin-version">{p.version}</span>
        </div>
        {p.update ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run({ op: 'update', name: p.name })}>
            更新到 {p.update}
          </button>
        ) : null}
        <Switch on={p.enabled} label={p.enabled ? `停用「${p.displayName}」` : `启用「${p.displayName}」`} disabled={busy} onChange={(on) => run({ op: on ? 'enable' : 'disable', name: p.name })} />
      </header>
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
            <dd className="detail-path" title={p.source.location}>
              {p.source.location}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="plugin-actions">
        {p.previousVersion ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => ask('rollback', p)}>
            回退到 {p.previousVersion}
          </button>
        ) : null}
        <button type="button" className="btn btn-small btn-quiet-danger btn-square" disabled={busy} onClick={() => ask('uninstall', p)} aria-label="删除" title="删除">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </section>
  );
}

/** `mail`: the mail sorting settings, shown with the plugin(s) that provide mail. */
export function Plugins({ api, mail }: { api: PluginsApi; mail?: MailSettingsProps }) {
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [location, setLocation, locationDone] = useKeptDraft('plugins.location', '');
  const [confirm, setConfirm] = useState<{ kind: 'uninstall' | 'rollback'; p: PluginView } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
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

  // A plugin seen for the first time (page opened, or just installed) goes to the group of its state then.
  const missing = plugins.filter((p) => !(p.name in groupOf));
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
        setNote(r.message ? { ok: r.ok, text: r.message } : r.ok ? null : { ok: false, text: '操作失败，请重试。' });
        return r;
      } catch (e) {
        setNote({ ok: false, text: friendlyError(e) });
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
    refresh();
    const off = api.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const install = async () => {
    const r = await run({ op: 'install', location });
    if (r?.ok && !r.state.available?.length) {
      setLocation('');
      locationDone();
      setInstalling(false);
      const added = r.state.plugins.find((p) => !plugins.some((x) => x.name === p.name));
      if (added) setPicked(added.name);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = plugins.filter((p) => matches(p, filter) && (!q || `${p.displayName} ${p.name} ${p.description}`.toLowerCase().includes(q)));
  const groups = [
    { key: 'on', title: '已启用', items: shown.filter((p) => groupOf[p.name] ?? p.enabled) },
    { key: 'off', title: '已停用', items: shown.filter((p) => !(groupOf[p.name] ?? p.enabled)) },
  ].filter((g) => g.items.length);
  const current = shown.find((p) => p.name === picked) ?? groups[0]?.items[0];
  const count = (f: Filter) => plugins.filter((p) => matches(p, f)).length;
  const empty = state !== null && plugins.length === 0;
  const installOpen = installing || empty;
  const listView = !narrow || !showDetail;
  const detailView = !narrow || showDetail;

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

      {empty ? <p className="settings-hint plugins-empty">未安装插件</p> : null}

      {listView && !empty ? (
        <div className="plugins-bar">
          {plugins.length ? <input className="input plugins-search" value={query} placeholder="搜索插件" aria-label="搜索插件" spellCheck={false} onChange={(e) => setQuery(e.target.value)} /> : <span className="plugins-bar-gap" />}
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
          <button type="button" className="icon-btn" disabled={busy || !plugins.length} onClick={() => void run({ op: 'checkUpdates' })} aria-label="检查更新" title="检查更新">
            <Icon name="refresh" size={16} />
          </button>
          <button type="button" className={installOpen ? 'icon-btn is-on' : 'icon-btn'} aria-expanded={installOpen} disabled={empty} onClick={() => setInstalling(!installing)} aria-label="安装插件" title="安装插件">
            <Icon name="plus" size={16} />
          </button>
        </div>
      ) : null}

      {installOpen && listView ? (
        <div className="settings-group plugins-install">
          <form
            className="install-row"
            onSubmit={(e) => {
              e.preventDefault();
              void install();
            }}
          >
            <input className="input" value={location} spellCheck={false} placeholder="插件文件夹、.zip、共享盘路径或网址" aria-label="插件位置" onChange={(e) => setLocation(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy || !location.trim()}>
              {busy ? <span className="spinner" aria-hidden /> : null}
              安装
            </button>
          </form>
          {state?.available?.length ? (
            <ul className="available-list">
              {state.available.map((a) => (
                <li key={a.key} className="available-item">
                  <span className="available-text">
                    <span className="plugin-name">{a.name}</span> <span className="plugin-version">{a.version}</span>
                    {a.description ? <span className="settings-hint"> {a.description}</span> : null}
                  </span>
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ op: 'installAvailable', key: a.key })}>
                    安装
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <p className={note.ok ? 'provider-result is-ok plugin-note' : 'provider-result is-bad plugin-note'} role="status">
          <SpicaStatusIcon name={note.ok ? 'done' : 'error'} size={15} />
          {note.text}
        </p>
      ) : null}

      {plugins.length ? (
        <div className="plugins-two">
          {listView ? (
            <nav className="plugins-list" aria-label="插件列表">
              {groups.length ? (
                groups.map((g) => (
                  <div key={g.key} className="plugins-group">
                    <h3 className="plugins-group-title">{g.title}</h3>
                    <ul>
                      {g.items.map((p) => (
                        <PluginRow
                          key={p.name}
                          p={p}
                          on={!narrow && current?.name === p.name}
                          onPick={() => {
                            setPicked(p.name);
                            setShowDetail(true);
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="settings-hint plugins-none">{q ? '没有匹配的插件' : '没有符合条件的插件'}</p>
              )}
            </nav>
          ) : null}
          {detailView && current ? (
            <PluginDetail
              p={current}
              busy={busy}
              run={(c) => void run(c)}
              ask={(kind, pl) => setConfirm({ kind, p: pl })}
              mail={mailSources.length === 1 && current.mail ? mail : undefined}
              onBack={narrow ? () => setShowDetail(false) : undefined}
            />
          ) : null}
        </div>
      ) : null}

      {state && listView ? (
        <div className="settings-group plugins-foot">
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-title">模拟模式</span>
            </div>
            <Switch on={state.mock} label="模拟模式" disabled={busy} onChange={(on) => void run({ op: 'mock', on })} />
          </div>
          <p className="plugin-root">
            <span className="settings-hint">插件目录</span>
            <span className="detail-path" title={state.root}>
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
