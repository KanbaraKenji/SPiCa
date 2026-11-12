// Settings > 常规: starting with Windows and what closing the window does, the folder workflow files are read from, the network,
// exporting the usage log. Mail sorting is with the mail plugin (设置 › 插件).
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_NETWORK, type AutostartSupport, type CloseWindow, type NetworkPrefs, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import type { LocalConnectInfo, NetworkState, UsageLogRequest, UsageLogResult, WorkflowsState } from '../../../shared/bridge';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { useGuard } from '../ui/guard';
import { InfoTip } from '../ui/InfoTip';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { APP_NAME } from '../../../shared/app-identity';
import type { PluginView } from '../../../shared/plugin-view';
import { BUILT_IN, previewerId, previewKinds, previewPagesFor } from '../../../shared/previewers';

export interface WorkflowsApi {
  run(op: 'state' | 'open' | 'reload'): Promise<WorkflowsState>;
}

export interface GeneralProps {
  settings: ShellSettings;
  onChange(patch: SettingsPatch): void;
  workflows: WorkflowsApi;
  pickFolder(): Promise<string | null>;
  /** Subscribes to the core coming back (it re-reads the workflow folder then). */
  onBackendRestarted(listener: () => void): () => void;
  /** Projects to pick from when exporting the usage log. */
  projects: { id: string; name: string }[];
  exportUsageLog(req: UsageLogRequest): Promise<UsageLogResult>;
  showInFolder(path: string): void;
  /** For tests. */
  now?: Date;
  /** What the core uses for the network now; absent: the status line is left out. */
  networkState?: () => Promise<NetworkState | null>;
  /** Windows' file picker (for the certificate file). */
  pickFiles?: (title?: string) => Promise<string[]>;
  /** Where local scripts reach Spica now (null: off). Absent: no 开发者 group. */
  localConnect?: () => Promise<LocalConnectInfo | null>;
  /** Preview pages of the enabled plugins (placement preview), for 文件预览. */
  previewPages?: PluginView[];
  /** Whether 开机时启动 works in this copy (an installed one); absent: shown disabled. */
  autostart?: AutostartSupport;
}

/** 文件预览: per kind of file a plugin page can show, the app's own preview or that page. Not shown without any. */
function FilePreviews({ settings, onChange, previewPages = [] }: GeneralProps) {
  const kinds = previewKinds(settings.previewers, previewPages);
  if (!kinds.length) return null;
  const set = (ext: string, id: string) => {
    const next = { ...settings.previewers };
    if (id === BUILT_IN) delete next[ext];
    else next[ext] = id;
    onChange({ previewers: next });
  };
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">文件预览</h3>
      <div className="preview-kinds">
        {kinds.map((ext) => {
          const pages = previewPagesFor(ext, previewPages);
          const kept = settings.previewers[ext];
          const gone = kept !== undefined && !pages.some((v) => previewerId(v) === kept);
          const twice = (v: PluginView) => pages.filter((p) => p.title === v.title).length > 1;
          return (
            <label key={ext} className="preview-kind">
              <span className="preview-kind-ext">{ext}</span>
              <select className="input" aria-label={`${ext} 文件预览`} value={kept ?? BUILT_IN} onChange={(e) => set(ext, e.target.value)}>
                <option value={BUILT_IN}>自带预览</option>
                {pages.map((v) => (
                  <option key={previewerId(v)} value={previewerId(v)}>
                    {twice(v) ? `${v.title}（${v.pluginTitle}）` : v.title}
                  </option>
                ))}
                {gone ? (
                  <option value={kept} disabled>
                    插件不可用
                  </option>
                ) : null}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Why 开机时启动 cannot be turned on in this copy (main/autostart.ts). */
const AUTOSTART_UNAVAILABLE: Record<Exclude<AutostartSupport, 'ok'>, string> = {
  dev: '开发版不能开机启动，只有安装版能用。',
  portable: '便携版不能开机启动，只有安装版能用。',
  unsupported: '只有 Windows 安装版能用。',
};

/** 关闭窗口时: the choices, in the order of the question the × asks (main/tray.ts). */
const CLOSE_WINDOW: [CloseWindow, string][] = [
  ['ask', '每次询问'],
  ['tray', '最小化到托盘'],
  ['quit', `退出 ${APP_NAME}`],
];

/** 启动与托盘: starting with Windows, and what the window's × does. */
function Startup({ settings, onChange, autostart = 'unsupported' }: GeneralProps) {
  const usable = autostart === 'ok';
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">启动与托盘</h3>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">开机时启动</span>
          <span className="settings-hint">{autostart === 'ok' ? '登录 Windows 后自动启动。' : AUTOSTART_UNAVAILABLE[autostart]}</span>
        </div>
        <Switch on={usable && settings.openAtLogin} label="开机时启动" disabled={!usable} onChange={(v) => onChange({ openAtLogin: v })} />
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">关闭窗口时</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="关闭窗口时">
          {CLOSE_WINDOW.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.closeWindow === value} className={settings.closeWindow === value ? 'segment is-on' : 'segment'} onClick={() => onChange({ closeWindow: value })}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 开发者: lets scripts on this machine (e.g. a plugin's install script) reach the running Spica. */
function Developer({ settings, onChange, localConnect }: GeneralProps) {
  const on = settings.localConnect === true;
  const [info, setInfo] = useState<LocalConnectInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!localConnect) return;
    let alive = true;
    const t = setTimeout(() => {
      void localConnect()
        .then((i) => alive && setInfo(i))
        .catch(() => undefined);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [localConnect, on]);
  const shown = on ? info : null;
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">开发者</h3>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">允许本机脚本连接 {APP_NAME}</span>
          <span className="settings-hint">开启后，本机脚本可连接 {APP_NAME} 并修改模型设置。</span>
        </div>
        <Switch on={on} label={`允许本机脚本连接 ${APP_NAME}`} onChange={(v) => onChange({ localConnect: v })} />
      </div>
      {on ? (
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title path-text">{shown ? shown.url : '正在打开…'}</span>
            {shown?.tokenFile ? (
              <span className="settings-hint path-text" title={shown.tokenFile} data-tip-clipped="">
                令牌文件 {shown.tokenFile}
              </span>
            ) : null}
          </div>
          {shown ? (
            <div className="row-buttons">
              <button
                type="button"
                className="btn btn-square"
                aria-label={copied ? '已复制' : '复制连接信息'}
                title={copied ? '已复制' : '复制连接信息'}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(JSON.stringify({ url: shown.url, tokenFile: shown.tokenFile }, null, 2))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => undefined)
                }
              >
                <Icon name={copied ? 'check' : 'copy'} size={16} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/** 网络: proxy, hosts that skip it, an extra certificate file, Windows' certificates. */
function Network({ settings, onChange, networkState, pickFiles }: GeneralProps) {
  const saved = settings.network ?? DEFAULT_NETWORK;
  const [proxy, setProxy, proxyDone] = useKeptDraft('network.proxy', saved.proxy);
  const [noProxy, setNoProxy, noProxyDone] = useKeptDraft('network.noProxy', saved.noProxy);
  const [state, setState] = useState<NetworkState | null>(null);
  const changed = proxy.trim() !== saved.proxy || noProxy.trim() !== saved.noProxy;
  const save = (patch: Partial<NetworkPrefs>) => onChange({ network: { ...saved, ...patch } });
  // What the core uses now; read again a moment after a change (it applies on the next request).
  const key = JSON.stringify(saved);
  useEffect(() => {
    if (!networkState) return;
    let alive = true;
    const t = setTimeout(() => {
      void networkState()
        .then((s) => alive && setState(s))
        .catch(() => undefined);
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [networkState, key]);
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">网络</h3>
      <div className="net-grid">
        <label className="form-field">
          <span className="field-label">
            代理地址
            <InfoTip text="留空则使用系统环境变量中的代理。" decorative />
          </span>
          <input className="input" spellCheck={false} value={proxy} placeholder="http://proxy.example.com:8080" onChange={(e) => setProxy(e.target.value)} aria-description="留空则使用系统环境变量中的代理。" />
        </label>
        <label className="form-field">
          <span className="field-label">不使用代理的地址</span>
          <input className="input" spellCheck={false} value={noProxy} placeholder="localhost, 10.0.0.0/8, .corp.example.com" onChange={(e) => setNoProxy(e.target.value)} />
        </label>
      </div>
      <div className="rule-actions">
        <button type="button" className="btn" disabled={!changed} onClick={() => {
            save({ proxy: proxy.trim(), noProxy: noProxy.trim() });
            proxyDone();
            noProxyDone();
          }}
        >
          保存
        </button>
        {changed ? <span className="provider-unsaved">未保存</span> : null}
      </div>
      <div className="setting-row net-ca">
        <div className="setting-text">
          <span className="setting-title">信任的证书文件</span>
          <span className="settings-hint path-text" title={saved.caFile} data-tip-clipped="">
            {saved.caFile || '无'}
          </span>
        </div>
        <div className="row-buttons">
          {pickFiles ? (
            <button
              type="button"
              className="btn btn-square"
              onClick={() =>
                void pickFiles('选择证书文件（.pem / .crt）').then((files) => {
                  if (files[0]) save({ caFile: files[0] });
                })
              }
              aria-label="选择文件"
              title="选择文件"
            >
              <Icon name="folder" size={16} />
            </button>
          ) : null}
          {saved.caFile ? (
            <button type="button" className="btn btn-square" onClick={() => save({ caFile: '' })} aria-label="移除" title="移除">
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">使用 Windows 证书存储</span>
        </div>
        <Switch on={saved.useSystemCa} label="使用 Windows 证书存储" onChange={(useSystemCa) => save({ useSystemCa })} />
      </div>
      {state ? (
        <p className="settings-hint net-now">
          当前：{state.proxy ? `代理：${state.proxy}` : '直连'}
          {state.noProxy.length ? ` · ${state.noProxy.length} 个例外地址` : ''}
          {state.caFile ? ' · 已添加证书文件' : ''}
          {state.useSystemCa ? ' · 使用 Windows 证书' : ''}
        </p>
      ) : null}
      {state?.problems.map((p) => (
        <p key={p} className="provider-result is-bad plugin-note">
          {p}
        </p>
      ))}
    </div>
  );
}


type Range = 'all' | 'today' | 'week' | 'month';
const RANGES: [Range, string][] = [
  ['all', '全部'],
  ['today', '今天'],
  ['week', '最近 7 天'],
  ['month', '最近 30 天'],
];

/** Start of the range (local midnight), as ISO; nothing for 全部. */
export function rangeStart(range: Range, now: Date = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (range === 'week') d.setDate(d.getDate() - 6);
  if (range === 'month') d.setDate(d.getDate() - 29);
  return d.toISOString();
}

function UsageLog({ projects, exportUsageLog, showInFolder, now }: GeneralProps) {
  const [projectId, setProjectId] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UsageLogResult>(null);
  const project = projects.find((p) => p.id === projectId);
  const guard = useGuard();
  const run = () => guard(exportNow);
  const exportNow = async () => {
    setBusy(true);
    setResult(null);
    const from = rangeStart(range, now);
    try {
      setResult(await exportUsageLog({ ...(project ? { projectId: project.id } : {}), ...(from ? { from } : {}) }));
    } catch {
      setResult({ error: '导出失败，请重试。' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">使用日志</h3>
      {projects.length ? (
        <div className="interval-row">
          <span className="field-label">项目</span>
          <button
            type="button"
            className="btn"
            aria-haspopup="menu"
            onClick={(e) => {
              // Under the button (over it when there is no room below); the button again closes it.
              const el = e.currentTarget;
              setMenu((now) => (now ? null : el));
            }}
          >
            {project?.name ?? '全部项目'}
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      ) : null}
      <div className="interval-row">
        <span className="field-label">时间</span>
        <div className="segmented" role="radiogroup" aria-label="时间">
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="rule-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          导出…
        </button>
      </div>
      {result && 'error' in result ? <p className="provider-result is-bad plugin-note">{result.error}</p> : null}
      {result && 'file' in result ? (
        <div className="setting-row usage-result">
          <div className="setting-text">
            <span className="setting-title">{result.records ? `已导出 ${result.records.toLocaleString('zh-CN')} 条记录` : '该时间段没有记录。'}</span>
            <span className="settings-hint path-text" title={result.file} data-tip-clipped="">
              {result.file}
            </span>
          </div>
          <div className="row-buttons">
            <button type="button" className="btn btn-square" onClick={() => showInFolder(result.file)} aria-label="在文件夹中显示" title="在文件夹中显示">
              <Icon name="folder" size={16} />
            </button>
          </div>
        </div>
      ) : null}
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={[{ id: '', name: '全部项目' }, ...projects].map((p) => ({ label: p.name, checked: p.id === projectId, onSelect: () => setProjectId(p.id) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function Workflows({ settings, onChange, workflows, pickFolder, onBackendRestarted }: GeneralProps) {
  const [state, setState] = useState<WorkflowsState | null>(null);
  const refresh = useCallback(
    (op: 'state' | 'open' | 'reload' = 'state') =>
      workflows
        .run(op)
        .then(setState)
        .catch(() => undefined),
    [workflows],
  );
  // Read again when the folder changes and when the core comes back after a crash.
  useEffect(() => {
    void refresh();
    return onBackendRestarted(() => void refresh());
  }, [refresh, onBackendRestarted, settings.workflowsDir]);

  const choose = async () => {
    const dir = await pickFolder();
    if (dir && dir !== settings.workflowsDir) onChange({ workflowsDir: dir });
  };
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">工作流</h3>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title path-text" title={state?.dir ?? ''}>
            {state?.dir || '—'}
          </span>
          <span className="settings-hint">
            {state === null
              ? ''
              : state.names.length
                ? `已读取 ${state.names.length} 个：${state.names.join('、')}`
                : '文件夹中没有工作流文件（.json）。'}
          </span>
        </div>
        <div className="row-buttons">
          <button type="button" className="btn btn-square" onClick={() => void refresh('open')} aria-label="打开文件夹" title="打开文件夹">
            <Icon name="folder" size={16} />
          </button>
          <button type="button" className="btn btn-square" onClick={() => void choose()} aria-label="更改" title="更改">
            <Icon name="pencil" size={16} />
          </button>
          <button type="button" className="btn btn-square" onClick={() => void refresh('reload')} aria-label="重新读取" title="重新读取">
            <Icon name="refresh" size={16} />
          </button>
          {settings.workflowsDir ? (
            <button type="button" className="btn" onClick={() => onChange({ workflowsDir: '' })}>
              恢复默认
            </button>
          ) : null}
        </div>
      </div>
      {state?.problems.length ? (
        <ul className="workflow-problems">
          {state.problems.map((p) => (
            <li key={p} className="provider-result is-bad">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {state?.message ? <p className="provider-result is-bad plugin-note">{state.message}</p> : null}
    </div>
  );
}

export function General(props: GeneralProps) {
  return (
    <section className="settings-section">
      <Startup {...props} />
      <FilePreviews {...props} />
      <Workflows {...props} />
      <Network {...props} />
      <UsageLog {...props} />
      {props.localConnect ? <Developer {...props} /> : null}
    </section>
  );
}
