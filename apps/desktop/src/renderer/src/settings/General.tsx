// Settings > 常规: the user's account for plugins, starting with Windows and what closing the window does, the folder workflow files are read from, the network,
// exporting the usage log. Mail sorting is with the mail plugin (设置 › 插件).
import { useCallback, useEffect, useState } from 'react';
import { ACCOUNT_MAX, accountValue, DEFAULT_NETWORK, type AutostartSupport, type CloseWindow, type NetworkPrefs, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import type { LocalConnectInfo, NetworkState, UsageLogRequest, UsageLogResult, WorkflowsState } from '../../../shared/bridge';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { useGuard } from '../ui/guard';
import { InfoTip } from '../ui/InfoTip';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { Group, Pane, Row } from './Group';
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
  /** The account by the company rule (main/user-account.ts); '' or absent: none was found. */
  autoAccount?: string;
}

/**
 * 账号: what plugins get as the user's account. The box shows the automatic one in grey; what is typed replaces
 * it, kept when the box is left or Enter is pressed (not at each key: plugin processes restart with a new one).
 */
function Account({ settings, onChange, autoAccount = '' }: GeneralProps) {
  const [text, setText] = useState(settings.account);
  // changed elsewhere (恢复自动, another window): show it
  const [shown, setShown] = useState(settings.account);
  if (shown !== settings.account) {
    setShown(settings.account);
    setText(settings.account);
  }
  const keep = () => {
    const typed = accountValue(text);
    // typing the automatic one again is the same as none typed
    const account = typed === autoAccount ? '' : typed;
    setText(account);
    if (account !== settings.account) onChange({ account });
  };
  const hint = settings.account
    ? autoAccount
      ? `已手动填写，自动取到的是 ${autoAccount}。`
      : '已手动填写。'
    : autoAccount
      ? '取自 Windows 用户文件夹名，提供给插件。'
      : '没有取到 Windows 用户文件夹名，插件读到的账号为空。可以手动填写。';
  return (
    <Group title="账号">
      <Row title="账号" hint={hint}>
        <input
          className="input account-field"
          value={text}
          placeholder={autoAccount || '未取到'}
          spellCheck={false}
          autoComplete="off"
          maxLength={ACCOUNT_MAX}
          aria-label="账号"
          onChange={(e) => setText(e.target.value)}
          onBlur={keep}
          onKeyDown={(e) => {
            if (e.key === 'Enter') keep();
          }}
        />
        {settings.account ? (
          <button type="button" className="btn" onClick={() => onChange({ account: '' })}>
            恢复自动
          </button>
        ) : null}
      </Row>
    </Group>
  );
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
    <Group title="文件预览">
        {kinds.map((ext) => {
          const pages = previewPagesFor(ext, previewPages);
          const kept = settings.previewers[ext];
          const gone = kept !== undefined && !pages.some((v) => previewerId(v) === kept);
          const twice = (v: PluginView) => pages.filter((p) => p.title === v.title).length > 1;
          return (
            <Row key={ext} title={<span className="preview-kind-ext">{ext}</span>}>
              <select className="input preview-kind-pick" aria-label={`${ext} 文件预览`} value={kept ?? BUILT_IN} onChange={(e) => set(ext, e.target.value)}>
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
            </Row>
          );
        })}
    </Group>
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
    <Group title="启动与托盘">
      <Row title="开机时启动" hint={autostart === 'ok' ? '登录 Windows 后自动启动。' : AUTOSTART_UNAVAILABLE[autostart]}>
        <Switch on={usable && settings.openAtLogin} label="开机时启动" disabled={!usable} onChange={(v) => onChange({ openAtLogin: v })} />
      </Row>
      <Row title="关闭窗口时">
        <div className="segmented" role="radiogroup" aria-label="关闭窗口时">
          {CLOSE_WINDOW.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.closeWindow === value} className={settings.closeWindow === value ? 'segment is-on' : 'segment'} onClick={() => onChange({ closeWindow: value })}>
              {label}
            </button>
          ))}
        </div>
      </Row>
    </Group>
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
    <Group title="开发者">
      <Row title={`允许本机脚本连接 ${APP_NAME}`} hint={`开启后，本机脚本可连接 ${APP_NAME} 并修改模型设置。`}>
        <Switch on={on} label={`允许本机脚本连接 ${APP_NAME}`} onChange={(v) => onChange({ localConnect: v })} />
      </Row>
      {on ? (
        <Row
          title={shown ? shown.url : '正在打开…'}
          hint={shown?.tokenFile ? `令牌文件 ${shown.tokenFile}` : undefined}
          path={{ title: shown?.url ?? '', ...(shown?.tokenFile ? { hint: shown.tokenFile } : {}) }}
        >
          {shown ? (
            <>
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
            </>
          ) : null}
        </Row>
      ) : null}
    </Group>
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
    <Group
      title="网络"
      after={
        <>
          {state ? (
            <p className="settings-hint group-note">
              当前：{state.proxy ? `代理：${state.proxy}` : '直连'}
              {state.noProxy.length ? ` · ${state.noProxy.length} 个例外地址` : ''}
              {state.caFile ? ' · 已添加证书文件' : ''}
              {state.useSystemCa ? ' · 使用 Windows 证书' : ''}
            </p>
          ) : null}
          {state?.problems.map((p) => (
            <p key={p} className="provider-result is-bad group-note">
              {p}
            </p>
          ))}
        </>
      }
    >
      <Row title="代理" stack>
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
      </Row>
      <Row title="信任的证书文件" hint={saved.caFile || '无'} path={{ hint: saved.caFile }}>
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
      </Row>
      <Row title="使用 Windows 证书存储">
        <Switch on={saved.useSystemCa} label="使用 Windows 证书存储" onChange={(useSystemCa) => save({ useSystemCa })} />
      </Row>
    </Group>
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
    <>
    <Group
      title="使用日志"
      actions={
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run()}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          导出…
        </button>
      }
    >
      {projects.length ? (
        <Row title="项目">
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
        </Row>
      ) : null}
      <Row title="时间">
        <div className="segmented" role="radiogroup" aria-label="时间">
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </div>
      </Row>
      {result && 'error' in result ? (
        <Pane>
          <p className="provider-result is-bad">{result.error}</p>
        </Pane>
      ) : null}
      {result && 'file' in result ? (
        <Row className="usage-result" title={result.records ? `已导出 ${result.records.toLocaleString('zh-CN')} 条记录` : '该时间段没有记录。'} hint={result.file} path={{ hint: result.file }}>
          <button type="button" className="btn btn-square" onClick={() => showInFolder(result.file)} aria-label="在文件夹中显示" title="在文件夹中显示">
            <Icon name="folder" size={16} />
          </button>
        </Row>
      ) : null}
    </Group>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={[{ id: '', name: '全部项目' }, ...projects].map((p) => ({ label: p.name, checked: p.id === projectId, onSelect: () => setProjectId(p.id) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
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
    <Group title="工作流">
      <Row
        title={state?.dir || '—'}
        path={{ title: state?.dir ?? '' }}
        hint={state === null ? '' : state.names.length ? `已读取 ${state.names.length} 个：${state.names.join('、')}` : '文件夹中没有工作流文件（.json）。'}
      >
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
      </Row>
      {state?.problems.length || state?.message ? (
        <Pane>
          {state.problems.length ? (
            <ul className="workflow-problems">
              {state.problems.map((p) => (
                <li key={p} className="provider-result is-bad">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}
          {state.message ? <p className="provider-result is-bad">{state.message}</p> : null}
        </Pane>
      ) : null}
    </Group>
  );
}

export function General(props: GeneralProps) {
  return (
    <section className="settings-section">
      <Account {...props} />
      <Startup {...props} />
      <FilePreviews {...props} />
      <Workflows {...props} />
      <Network {...props} />
      <UsageLog {...props} />
      {props.localConnect ? <Developer {...props} /> : null}
    </section>
  );
}
