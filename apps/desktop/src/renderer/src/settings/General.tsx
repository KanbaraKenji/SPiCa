// Settings > 常规: starting with Windows and what closing the window does, the folder workflow files are read from, the network,
// exporting the usage log. Mail sorting is with the mail plugin (设置 › 插件).
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_NETWORK, type AutostartSupport, type CloseWindow, type LinkOpen, type NetworkPrefs, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import type { LocalConnectInfo, NetworkState, UsageLogRequest, UsageLogResult, WorkflowsState } from '../../../shared/bridge';
import { ContextMenu } from '../ui/ContextMenu';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { useGuard } from '../ui/guard';
import { InfoTip } from '../ui/InfoTip';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';
import { Group, Pane, Row } from './Group';
import { APP_NAME } from '../../../shared/app-identity';
import type { PluginView } from '../../../shared/plugin-view';
import { BUILT_IN, previewerId, previewKinds, previewPagesFor } from '../../../shared/previewers';
import { intlLocale, N_, t, tc, tx } from '../../../shared/i18n';

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
  /** 浏览器 › 浏览数据: clears the built-in browser's sign-ins, storage and cache. Absent: no such row. */
  clearBrowsingData?: () => Promise<unknown>;
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
    <Group title={t('文件预览')}>
        {kinds.map((ext) => {
          const pages = previewPagesFor(ext, previewPages);
          const kept = settings.previewers[ext];
          const gone = kept !== undefined && !pages.some((v) => previewerId(v) === kept);
          const twice = (v: PluginView) => pages.filter((p) => p.title === v.title).length > 1;
          return (
            <Row key={ext} title={<span className="preview-kind-ext">{ext}</span>}>
              <Select
                className="preview-kind-pick"
                label={t('{ext} 文件预览', { ext })}
                value={kept ?? BUILT_IN}
                onChange={(v) => set(ext, v)}
                options={[
                  { value: BUILT_IN, label: t('自带预览') },
                  ...pages.map((v) => ({ value: previewerId(v), label: twice(v) ? t('{title}（{plugin}）', { title: v.title, plugin: v.pluginTitle }) : v.title })),
                  ...(gone ? [{ value: kept, label: t('插件不可用'), disabled: true }] : []),
                ]}
              />
            </Row>
          );
        })}
    </Group>
  );
}

/** Why 开机时启动 cannot be turned on in this copy (main/autostart.ts). */
const AUTOSTART_UNAVAILABLE: Record<Exclude<AutostartSupport, 'ok'>, string> = {
  dev: N_('开发版不能开机启动，只有安装版能用。'),
  portable: N_('便携版不能开机启动，只有安装版能用。'),
  unsupported: N_('只有 Windows 安装版能用。'),
};

/** 浏览器 › 打开网址: where a web address clicked in the app opens (shell/links.tsx). */
const LINK_OPEN: [LinkOpen, string][] = [
  ['ask', N_('每次询问')],
  ['panel', N_('应用内')],
  ['system', N_('系统浏览器')],
];

/** 浏览器: where web addresses open, and the built-in browser's own sign-ins and storage (kept until cleared here). */
function Browser({ settings, onChange, clearBrowsingData }: GeneralProps) {
  const [cleared, setCleared] = useState(false);
  return (
    <Group title={t('浏览器')}>
      <Row title={t('打开网址')}>
        <div className="segmented" role="radiogroup" aria-label={t('打开网址')}>
          {LINK_OPEN.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.linkOpen === value} className={settings.linkOpen === value ? 'segment is-on' : 'segment'} onClick={() => onChange({ linkOpen: value })}>
              {t(label)}
            </button>
          ))}
        </div>
      </Row>
      {clearBrowsingData ? (
        <Row title={t('浏览数据')}>
          <button
            type="button"
            className="btn"
            disabled={cleared}
            onClick={() => {
              void clearBrowsingData().then(() => setCleared(true));
            }}
          >
            {cleared ? t('已清除') : t('清除')}
          </button>
        </Row>
      ) : null}
    </Group>
  );
}

/** 关闭窗口时: the choices, in the order of the question the × asks (main/tray.ts). */
const CLOSE_WINDOW: [CloseWindow, string][] = [
  ['ask', N_('每次询问')],
  ['tray', N_('最小化到托盘')],
  ['quit', N_('退出 {app}')],
];

/** 启动与托盘: starting with Windows, and what the window's × does. */
function Startup({ settings, onChange, autostart = 'unsupported' }: GeneralProps) {
  const usable = autostart === 'ok';
  return (
    <Group title={t('启动与托盘')}>
      <Row title={t('开机时启动')} hint={autostart === 'ok' ? t('登录 Windows 后自动启动。') : t(AUTOSTART_UNAVAILABLE[autostart])}>
        <Switch on={usable && settings.openAtLogin} label={t('开机时启动')} disabled={!usable} onChange={(v) => onChange({ openAtLogin: v })} />
      </Row>
      <Row title={t('关闭窗口时')}>
        <div className="segmented" role="radiogroup" aria-label={t('关闭窗口时')}>
          {CLOSE_WINDOW.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.closeWindow === value} className={settings.closeWindow === value ? 'segment is-on' : 'segment'} onClick={() => onChange({ closeWindow: value })}>
              {t(label, { app: APP_NAME })}
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
    const timer = setTimeout(() => {
      void localConnect()
        .then((i) => alive && setInfo(i))
        .catch(() => undefined);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [localConnect, on]);
  const shown = on ? info : null;
  return (
    <Group title={t('开发者')}>
      <Row title={t('允许本机脚本连接 {app}', { app: APP_NAME })} hint={t('开启后，本机脚本可连接 {app} 并修改 设置 › 模型。', { app: APP_NAME })}>
        <Switch on={on} label={t('允许本机脚本连接 {app}', { app: APP_NAME })} onChange={(v) => onChange({ localConnect: v })} />
      </Row>
      {on ? (
        <Row
          title={shown ? shown.url : t('正在打开…')}
          hint={shown?.tokenFile ? t('令牌文件 {file}', { file: shown.tokenFile }) : undefined}
          path={{ title: shown?.url ?? '', ...(shown?.tokenFile ? { hint: shown.tokenFile } : {}) }}
        >
          {shown ? (
            <>
              <button
                type="button"
                className="btn btn-square"
                aria-label={copied ? t('已复制') : t('复制连接信息')}
                title={copied ? t('已复制') : t('复制连接信息')}
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
    const timer = setTimeout(() => {
      void networkState()
        .then((s) => alive && setState(s))
        .catch(() => undefined);
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [networkState, key]);
  return (
    <Group
      title={t('网络')}
      after={
        <>
          {state ? (
            <p className="settings-hint group-note">
              {t('当前：{status}', {
                status: [
                  state.proxy ? t('代理：{proxy}', { proxy: state.proxy }) : t('直连'),
                  state.noProxy.length ? t('{n} 个例外地址', { n: state.noProxy.length }) : '',
                  state.caFile ? t('已添加证书文件') : '',
                  state.useSystemCa ? t('使用 Windows 证书') : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
              })}
            </p>
          ) : null}
          {state?.problems.map((p) => (
            <p key={p} className="provider-result is-bad group-note">
              {tx(p)}
            </p>
          ))}
        </>
      }
    >
      <Row title={tc('network', '代理')} stack>
      <div className="net-grid">
        <label className="form-field">
          <span className="field-label">
            {t('代理地址')}
            <InfoTip text={t('留空则使用系统环境变量中的代理。')} decorative />
          </span>
          <input className="input" spellCheck={false} value={proxy} placeholder="http://proxy.example.com:8080" onChange={(e) => setProxy(e.target.value)} aria-description={t('留空则使用系统环境变量中的代理。')} />
        </label>
        <label className="form-field">
          <span className="field-label">{t('不使用代理的地址')}</span>
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
          {t('保存')}
        </button>
        {changed ? <span className="provider-unsaved">{t('未保存')}</span> : null}
      </div>
      </Row>
      <Row title={t('信任的证书文件')} hint={saved.caFile || t('无')} path={{ hint: saved.caFile }}>
          {pickFiles ? (
            <button
              type="button"
              className="btn btn-square"
              onClick={() =>
                void pickFiles(t('选择证书文件（.pem / .crt）')).then((files) => {
                  if (files[0]) save({ caFile: files[0] });
                })
              }
              aria-label={t('选择文件')}
              title={t('选择文件')}
            >
              <Icon name="folder" size={16} />
            </button>
          ) : null}
          {saved.caFile ? (
            <button type="button" className="btn btn-square" onClick={() => save({ caFile: '' })} aria-label={t('移除')} title={t('移除')}>
              <Icon name="close" size={14} />
            </button>
          ) : null}
      </Row>
      <Row title={t('使用 Windows 证书存储')}>
        <Switch on={saved.useSystemCa} label={t('使用 Windows 证书存储')} onChange={(useSystemCa) => save({ useSystemCa })} />
      </Row>
    </Group>
  );
}


type Range = 'all' | 'today' | 'week' | 'month';
const RANGES: [Range, string][] = [
  ['all', N_('全部')],
  ['today', N_('今天')],
  ['week', N_('最近 7 天')],
  ['month', N_('最近 30 天')],
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
      setResult({ error: N_('导出失败，请重试。') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    <Group
      title={t('使用日志')}
      actions={
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run()}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          {t('导出…')}
        </button>
      }
    >
      {projects.length ? (
        <Row title={t('项目')}>
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
            {project?.name ?? t('全部项目')}
            <Icon name="chevronDown" size={12} />
          </button>
        </Row>
      ) : null}
      <Row title={t('时间')}>
        <div className="segmented" role="radiogroup" aria-label={t('时间')}>
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
              {t(label)}
            </button>
          ))}
        </div>
      </Row>
      {result && 'error' in result ? (
        <Pane>
          <p className="provider-result is-bad">{tx(result.error)}</p>
        </Pane>
      ) : null}
      {result && 'file' in result ? (
        <Row className="usage-result" title={result.records ? t('已导出 {count} 条记录', { n: result.records, count: result.records.toLocaleString(intlLocale()) }) : t('该时间段没有记录。')} hint={result.file} path={{ hint: result.file, open: () => showInFolder(result.file), openLabel: t('在文件夹中显示') }} />
      ) : null}
    </Group>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={[{ id: '', name: t('全部项目') }, ...projects].map((p) => ({ label: p.name, checked: p.id === projectId, onSelect: () => setProjectId(p.id) }))}
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
    <Group title={t('工作流')}>
      <Row
        title={state?.dir || '—'}
        path={{ title: state?.dir ?? '', open: () => void refresh('open') }}
        hint={state === null ? '' : state.names.length ? t('已读取 {n} 个：{names}', { n: state.names.length, names: state.names.join(t('、')) }) : t('文件夹中没有工作流文件（.json）。')}
      >
          <button type="button" className="btn btn-square" onClick={() => void choose()} aria-label={t('更改')} title={t('更改')}>
            <Icon name="pencil" size={16} />
          </button>
          <button type="button" className="btn btn-square" onClick={() => void refresh('reload')} aria-label={t('重新读取')} title={t('重新读取')}>
            <Icon name="refresh" size={16} />
          </button>
          {settings.workflowsDir ? (
            <button type="button" className="btn" onClick={() => onChange({ workflowsDir: '' })}>
              {t('恢复默认')}
            </button>
          ) : null}
      </Row>
      {state?.problems.length || state?.message ? (
        <Pane>
          {state.problems.length ? (
            <ul className="workflow-problems">
              {state.problems.map((p) => (
                <li key={p} className="provider-result is-bad">
                  {tx(p)}
                </li>
              ))}
            </ul>
          ) : null}
          {state.message ? <p className="provider-result is-bad">{tx(state.message)}</p> : null}
        </Pane>
      ) : null}
    </Group>
  );
}

export function General(props: GeneralProps) {
  return (
    <section className="settings-section">
      <Startup {...props} />
      <FilePreviews {...props} />
      <Browser {...props} />
      <Workflows {...props} />
      <Network {...props} />
      <UsageLog {...props} />
      {props.localConnect ? <Developer {...props} /> : null}
    </section>
  );
}
