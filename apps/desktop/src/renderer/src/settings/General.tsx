// Settings > 常规: mail sorting (on / off, how often, what to ignore), the
// folder workflow files are read from, and exporting the usage log.
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_NETWORK, MAIL_INTERVALS, type MailPrefs, type NetworkPrefs, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import type { LocalConnectInfo, NetworkState, UsageLogRequest, UsageLogResult, WorkflowsState } from '../../../shared/bridge';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { useKeptDraft } from './drafts';
import { ConfirmDialog } from '../ui/Dialog';
import { Switch } from './Plugins';
import { APP_NAME } from '../../../shared/app-identity';

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
  /** The model mail goes to for sorting, in words (e.g. 「DeepSeek · deepseek-chat」); empty when none is set. */
  mailModel?: string;
  /** What the core uses for the network now; absent: the status line is left out. */
  networkState?: () => Promise<NetworkState | null>;
  /** Windows' file picker (for the certificate file). */
  pickFiles?: (title?: string) => Promise<string[]>;
  /** Where local scripts reach Spica now (null: off). Absent: no 开发者 group. */
  localConnect?: () => Promise<LocalConnectInfo | null>;
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
              <span className="settings-hint path-text" title={shown.tokenFile}>
                令牌在 {shown.tokenFile}
              </span>
            ) : null}
          </div>
          {shown ? (
            <div className="row-buttons">
              <button
                type="button"
                className="btn"
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
                {copied ? '已复制' : '复制连接信息'}
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
          <span className="field-label">代理地址</span>
          <input className="input" spellCheck={false} value={proxy} placeholder="http://proxy.example.com:8080" onChange={(e) => setProxy(e.target.value)} aria-describedby="net-proxy-hint" />
          <span className="settings-hint" id="net-proxy-hint">
            留空则使用系统环境变量中的代理。
          </span>
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
          <span className="settings-hint path-text" title={saved.caFile}>
            {saved.caFile || '无'}
          </span>
        </div>
        <div className="row-buttons">
          {pickFiles ? (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void pickFiles('选择证书文件（.pem / .crt）').then((files) => {
                  if (files[0]) save({ caFile: files[0] });
                })
              }
            >
              选择文件
            </button>
          ) : null}
          {saved.caFile ? (
            <button type="button" className="btn" onClick={() => save({ caFile: '' })}>
              移除
            </button>
          ) : null}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">使用 Windows 证书存储</span>
          <span className="settings-hint">信任 Windows 已安装的证书（含企业证书）。</span>
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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UsageLogResult>(null);
  const project = projects.find((p) => p.id === projectId);
  const run = async () => {
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
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
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
            <span className="settings-hint path-text" title={result.file}>
              {result.file}
            </span>
          </div>
          <div className="row-buttons">
            <button type="button" className="btn" onClick={() => showInFolder(result.file)}>
              在文件夹中显示
            </button>
          </div>
        </div>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ id: '', name: '全部项目' }, ...projects].map((p) => ({ label: p.name, onSelect: () => setProjectId(p.id) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function IgnoreRules({ mail, onSave }: { mail: MailPrefs; onSave(ignore: MailPrefs['ignore']): void }) {
  const [from, setFrom, fromDone] = useKeptDraft('mail.ignore.from', mail.ignore.from.join('\n'));
  const [subject, setSubject, subjectDone] = useKeptDraft('mail.ignore.subject', mail.ignore.subject.join('\n'));
  const changed = lines(from).join('\n') !== mail.ignore.from.join('\n') || lines(subject).join('\n') !== mail.ignore.subject.join('\n');
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">忽略规则</h3>
      <div className="rule-grid">
        <label className="form-field">
          <span className="field-label">发件人包含</span>
          <textarea className="input rule-input" rows={4} spellCheck={false} value={from} placeholder="每行一条，支持 /正则/" onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="field-label">主题包含</span>
          <textarea className="input rule-input" rows={4} spellCheck={false} value={subject} placeholder="每行一条，支持 /正则/" onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
            <div className="rule-actions">
        <button type="button" className="btn" disabled={!changed} onClick={() => {
            onSave({ from: lines(from), subject: lines(subject) });
            fromDone();
            subjectDone();
          }}
        >
          保存
        </button>
        {changed ? <span className="provider-unsaved">未保存</span> : null}
      </div>
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
          <button type="button" className="btn" onClick={() => void refresh('open')}>
            打开文件夹
          </button>
          <button type="button" className="btn" onClick={() => void choose()}>
            更改
          </button>
          <button type="button" className="btn" onClick={() => void refresh('reload')}>
            重新读取
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
  const { settings, onChange, mailModel = '' } = props;
  const mail = settings.mail;
  const setMail = (patch: Partial<MailPrefs>) => onChange({ mail: { ...mail, ...patch } });
  const [askingMail, setAskingMail] = useState(false);
  return (
    <section className="settings-section">
      <div className="settings-group">
        <h3 className="settings-subheading">邮件</h3>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">邮件分类</span>
          </div>
          <Switch on={mail.enabled} label="邮件分类" onChange={(enabled) => (enabled ? setAskingMail(true) : setMail({ enabled: false }))} />
        </div>
        <div className="interval-row">
          <span className="field-label">检查间隔</span>
          <div className="segmented" role="radiogroup" aria-label="检查间隔">
            {MAIL_INTERVALS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mail.intervalMinutes === m}
                disabled={!mail.enabled}
                className={mail.intervalMinutes === m ? 'segment is-on' : 'segment'}
                onClick={() => setMail({ intervalMinutes: m })}
              >
                {m < 60 ? `${m} 分钟` : '1 小时'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {askingMail ? (
        <ConfirmDialog
          title="开启邮件分类？"
          detail={`新邮件的发件人、主题和正文开头将发送给${mailModel ? `「${mailModel}」` : '默认模型'}进行分类。`}
          confirmLabel="开启"
          onCancel={() => setAskingMail(false)}
          onConfirm={() => {
            setAskingMail(false);
            setMail({ enabled: true, consentedAt: new Date().toISOString() });
          }}
        />
      ) : null}
      <IgnoreRules key={JSON.stringify(mail.ignore)} mail={mail} onSave={(ignore) => setMail({ ignore })} />
      <Workflows {...props} />
      <Network {...props} />
      <UsageLog {...props} />
      {props.localConnect ? <Developer {...props} /> : null}
    </section>
  );
}
