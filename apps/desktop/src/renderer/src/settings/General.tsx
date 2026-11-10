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
          <span className="settings-hint">打开后，这台电脑上的脚本（比如插件的安装脚本）可以连上正在运行的 {APP_NAME}。只对本机开放，要带上令牌才能连。不用时请关掉。</span>
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
      <p className="settings-hint">公司网络要经代理上网、或者会检查加密连接时，在这里填。改了下一次请求就生效，不用重启。</p>
      <div className="net-grid">
        <label className="form-field">
          <span className="field-label">代理地址</span>
          <input className="input" spellCheck={false} value={proxy} onChange={(e) => setProxy(e.target.value)} aria-describedby="net-proxy-hint" />
          <span className="settings-hint" id="net-proxy-hint">
            比如 http://proxy.example.com:8080。留空就用电脑上已有的代理设置（环境变量）。
          </span>
        </label>
        <label className="form-field">
          <span className="field-label">不走代理的地址</span>
          <input className="input" spellCheck={false} value={noProxy} onChange={(e) => setNoProxy(e.target.value)} aria-describedby="net-noproxy-hint" />
          <span className="settings-hint" id="net-noproxy-hint">
            用逗号隔开，比如 localhost, 10.0.0.0/8, .corp.example.com
          </span>
        </label>
      </div>
      <div className="rule-actions">
        <button type="button" className="btn" disabled={!changed} onClick={() => {
            save({ proxy: proxy.trim(), noProxy: noProxy.trim() });
            proxyDone();
            noProxyDone();
          }}
        >
          保存代理
        </button>
      </div>
      <div className="setting-row net-ca">
        <div className="setting-text">
          <span className="setting-title">额外信任的证书</span>
          <span className="settings-hint path-text" title={saved.caFile}>
            {saved.caFile || '没有'}
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
              不用了
            </button>
          ) : null}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-title">使用 Windows 的证书</span>
          <span className="settings-hint">公司的证书一般已经装在 Windows 里，打开它就能连上。</span>
        </div>
        <Switch on={saved.useSystemCa} label="使用 Windows 的证书" onChange={(useSystemCa) => save({ useSystemCa })} />
      </div>
      {state ? (
        <p className="settings-hint net-now">
          现在：{state.proxy ? `经代理 ${state.proxy}` : '不经代理'}
          {state.noProxy.length ? ` · ${state.noProxy.length} 个地址不走代理` : ''}
          {state.caFile ? ' · 加了证书文件' : ''}
          {state.useSystemCa ? ' · 用 Windows 的证书' : ''}
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
      setResult({ error: '没有导出成功，请稍后再试。' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-group">
      <h3 className="settings-subheading">使用日志</h3>
      <p className="settings-hint">对话、工具调用、项目动态和来信的完整记录，存成一个文件（.jsonl）。模型密钥和接口地址不会写进去。</p>
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
            <span className="setting-title">{result.records ? `已导出 ${result.records.toLocaleString('zh-CN')} 条记录` : '这段时间没有记录，文件里只有表头'}</span>
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
          <textarea className="input rule-input" rows={4} spellCheck={false} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="field-label">主题包含</span>
          <textarea className="input rule-input" rows={4} spellCheck={false} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <p className="settings-hint rule-hint">一行一条。符合的来信直接忽略，不交给模型分。也可以写成 /规则/（正则表达式）。</p>
      <div className="rule-actions">
        <button type="button" className="btn" disabled={!changed} onClick={() => {
            onSave({ from: lines(from), subject: lines(subject) });
            fromDone();
            subjectDone();
          }}
        >
          保存规则
        </button>
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
                ? `读到 ${state.names.length} 个：${state.names.join('、')}`
                : '这个文件夹里还没有工作流文件（.json）。'}
          </span>
        </div>
        <div className="row-buttons">
          <button type="button" className="btn" onClick={() => void refresh('open')}>
            打开文件夹
          </button>
          <button type="button" className="btn" onClick={() => void choose()}>
            换一个
          </button>
          <button type="button" className="btn" onClick={() => void refresh('reload')}>
            重新读取
          </button>
          {settings.workflowsDir ? (
            <button type="button" className="btn" onClick={() => onChange({ workflowsDir: '' })}>
              用默认的
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
      <p className="settings-hint rule-hint">每个工作流是一个文件，写着项目分哪几个阶段。改了文件点「重新读取」。</p>
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
            <span className="setting-title">把来信分到项目</span>
            <span className="settings-hint">邮件插件拿到的新来信，按项目分好交给项目经理，在「收件箱」里确认。只给建议，不会替你发信。</span>
          </div>
          <Switch on={mail.enabled} label="把来信分到项目" onChange={(enabled) => (enabled ? setAskingMail(true) : setMail({ enabled: false }))} />
        </div>
        <div className="interval-row">
          <span className="field-label">多久查一次</span>
          <div className="segmented" role="radiogroup" aria-label="多久查一次">
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
          title="把来信交给模型分拣？"
          detail={`打开后，邮件插件读到的新来信（发件人、主题和正文开头）会发给${mailModel ? `「${mailModel}」` : '当前设置的模型'}分拣；归到项目的信，项目经理会用它自己对话的模型去读。用公司邮箱时，请确认这个模型可以处理公司邮件。${APP_NAME} 只给建议，不会替你发信。`}
          confirmLabel="打开"
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
