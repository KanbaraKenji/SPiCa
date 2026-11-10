// Settings > 插件: what is installed, turn each on or off (its tools appear or
// vanish at once), mock mode, install from a folder / zip / shared folder /
// web address, updates and going back one version.
import { useCallback, useEffect, useState } from 'react';
import { usd, type PluginModelView, type PluginsCommand, type PluginsResult, type PluginsState, type PluginView } from '../../../shared/plugins';
import { friendlyError } from '../store/agent';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { useKeptDraft } from './drafts';

export interface PluginsApi {
  run(cmd: PluginsCommand): Promise<PluginsResult>;
  onChanged(listener: () => void): () => void;
}

const SERVER_STATUS: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  restarting: '重启中',
  stopped: '没在运行',
  failed: '出错了',
};

export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={on ? 'switch is-on' : 'switch'} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

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
  const problem = limit.trim() === '' || !Number.isFinite(value) || value < 0 ? '填 0 或正数' : value > m.declaredMaxUsdPerDay ? `不能高于 ${usd(m.declaredMaxUsdPerDay)}` : null;
  const off = m.maxUsdPerDay <= 0;
  const used = m.spentTodayUsd;
  return (
    <div className="plugin-model">
      <p className="plugin-model-line">
        {off ? '它想用你配好的模型，现在不让它用。' : `会用你配好的模型，花费记在你的额度里，每天最多 ${usd(m.maxUsdPerDay)}。`}
        {typeof used === 'number' && !off ? (
          <span className={used >= m.maxUsdPerDay ? 'plugin-model-spent is-full' : 'plugin-model-spent'}>
            {used >= m.maxUsdPerDay ? ` 今天花了 ${usd(used)}，今天的额度用完了。` : ` 今天花了 ${usd(used)}。`}
          </span>
        ) : null}
      </p>
      <p className="plugin-model-reason">它说：{m.reason}</p>
      <div className="plugin-model-limit">
        <label className="plugin-model-input">
          <span>每天最多 $</span>
          <input
            className={problem ? 'input is-invalid' : 'input'}
            type="number"
            min={0}
            max={m.declaredMaxUsdPerDay}
            step={0.01}
            value={limit}
            aria-label={`「${p.displayName}」每天最多花多少美元`}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-small" disabled={busy || problem !== null || value === m.maxUsdPerDay} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: value })}>
          保存上限
        </button>
        {off ? null : (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: 0 })}>
            不让它用模型
          </button>
        )}
        {m.userMaxUsdPerDay !== undefined ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run({ op: 'modelLimit', name: p.name, maxUsdPerDay: null })}>
            恢复成插件写的 {usd(m.declaredMaxUsdPerDay)}
          </button>
        ) : null}
        {problem ? <span className="field-error">{problem}</span> : null}
      </div>
    </div>
  );
}

function PluginCard({ p, busy, run, ask }: { p: PluginView; busy: boolean; run(cmd: PluginsCommand): void; ask(kind: 'uninstall' | 'rollback', p: PluginView): void }) {
  const [open, setOpen] = useState(false);
  const failed = p.servers.filter((s) => s.status === 'failed');
  return (
    <section className={p.enabled ? 'card plugin-card' : 'card plugin-card is-off'} aria-label={p.displayName}>
      <header className="plugin-head">
        <div className="plugin-title">
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
      {p.model ? <ModelUse p={p} m={p.model} busy={busy} run={run} /> : null}
      {p.issues.length || failed.length ? (
        <p className="plugin-problem">{[...p.issues, ...failed.map((s) => s.lastError ?? `「${s.id}」没有启动起来`)].join('；')}</p>
      ) : null}
      <button type="button" className="fold-head plugin-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="fold-label">{p.enabled ? `能用的工具 ${p.tools.length} 个` : '已停用，工具不可用'}</span>
        <Icon name="chevronRight" size={14} className="fold-chevron" />
      </button>
      {open ? (
        <div className="plugin-details">
          <dl className="detail-facts">
            <List label="工具" items={p.tools} />
            <List label="技能" items={p.skills.map((s) => s.name)} />
            <List label="命令" items={p.commands.map((c) => `/${c.id}`)} />
            <List label="进程" items={p.servers.map((s) => `${s.id}（${SERVER_STATUS[s.status] ?? s.status}）`)} />
            <dt>模拟模式</dt>
            <dd>{p.mockSupported ? '支持' : '不支持'}</dd>
            {p.source ? (
              <>
                <dt>装自</dt>
                <dd className="detail-path" title={p.source.location}>
                  {p.source.location}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="plugin-actions">
            {p.previousVersion ? (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => ask('rollback', p)}>
                退回 {p.previousVersion}
              </button>
            ) : null}
            <button type="button" className="btn btn-small btn-quiet-danger" disabled={busy} onClick={() => ask('uninstall', p)}>
              <Icon name="trash" size={14} />
              删除
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function Plugins({ api }: { api: PluginsApi }) {
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [location, setLocation, locationDone] = useKeptDraft('plugins.location', '');
  const [confirm, setConfirm] = useState<{ kind: 'uninstall' | 'rollback'; p: PluginView } | null>(null);

  const run = useCallback(
    async (cmd: PluginsCommand) => {
      setBusy(true);
      try {
        const r = await api.run(cmd);
        setState(r.state);
        setNote(r.message ? { ok: r.ok, text: r.message } : r.ok ? null : { ok: false, text: '没有成功，请再试一次。' });
        return r;
      } catch (e) {
        setNote({ ok: false, text: friendlyError(e) });
        return undefined;
      } finally {
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
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">模拟模式</span>
            <span className="settings-hint">插件用自带的样例数据回答，不连真实系统</span>
          </div>
          <Switch on={state?.mock ?? false} label="模拟模式" disabled={busy || !state} onChange={(on) => void run({ op: 'mock', on })} />
        </div>
      </div>

      <div className="settings-group">
        <h3 className="settings-subheading">安装插件</h3>
        <form
          className="install-row"
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          <input
            className="input"
            value={location}
            spellCheck={false}
            placeholder="插件文件夹、.zip、共享盘路径或网址"
            aria-label="插件在哪里"
            onChange={(e) => setLocation(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !location.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            安装
          </button>
        </form>
        {note ? (
          <p className={note.ok ? 'provider-result is-ok plugin-note' : 'provider-result is-bad plugin-note'} role="status">
            {note.ok ? <Icon name="check" size={14} /> : null}
            {note.text}
          </p>
        ) : null}
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

      <div className="settings-group">
        <div className="plugins-bar">
          <h3 className="settings-subheading">已安装</h3>
          <button type="button" className="btn btn-small" disabled={busy || !state?.plugins.length} onClick={() => void run({ op: 'checkUpdates' })}>
            检查更新
          </button>
        </div>
        {state && state.plugins.length === 0 ? <p className="settings-hint">还没有安装插件</p> : null}
        <div className="plugin-list">
          {state?.plugins.map((p) => (
            <PluginCard key={p.name} p={p} busy={busy} run={(c) => void run(c)} ask={(kind, pl) => setConfirm({ kind, p: pl })} />
          ))}
        </div>
        {state ? (
          <p className="plugin-root">
            <span className="settings-hint">插件放在</span>
            <span className="detail-path" title={state.root}>
              {state.root}
            </span>
            <button type="button" className="link-btn" onClick={() => void run({ op: 'openRoot' })}>
              打开文件夹
            </button>
          </p>
        ) : null}
      </div>

      {confirm ? (
        <ConfirmDialog
          title={confirm.kind === 'uninstall' ? `删除插件「${confirm.p.displayName}」？` : `把「${confirm.p.displayName}」退回 ${confirm.p.previousVersion}？`}
          confirmLabel={confirm.kind === 'uninstall' ? '删除' : '退回'}
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
