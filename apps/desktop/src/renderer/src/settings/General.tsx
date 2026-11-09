// Settings > 常规: mail sorting (on / off, how often, what to ignore) and the
// folder workflow files are read from.
import { useCallback, useEffect, useState } from 'react';
import { MAIL_INTERVALS, type MailPrefs, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import type { WorkflowsState } from '../../../shared/bridge';
import { Switch } from './Plugins';

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
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function IgnoreRules({ mail, onSave }: { mail: MailPrefs; onSave(ignore: MailPrefs['ignore']): void }) {
  const [from, setFrom] = useState(mail.ignore.from.join('\n'));
  const [subject, setSubject] = useState(mail.ignore.subject.join('\n'));
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
        <button type="button" className="btn" disabled={!changed} onClick={() => onSave({ from: lines(from), subject: lines(subject) })}>
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
  const { settings, onChange } = props;
  const mail = settings.mail;
  const setMail = (patch: Partial<MailPrefs>) => onChange({ mail: { ...mail, ...patch } });
  return (
    <section className="settings-section">
      <div className="settings-group">
        <h3 className="settings-subheading">邮件</h3>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">把来信分到项目</span>
            <span className="settings-hint">邮件插件拿到的新来信，按项目分好交给项目经理，在「收件箱」里确认。只给建议，不会替你发信。</span>
          </div>
          <Switch on={mail.enabled} label="把来信分到项目" onChange={(enabled) => setMail({ enabled })} />
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
      <IgnoreRules key={JSON.stringify(mail.ignore)} mail={mail} onSave={(ignore) => setMail({ ignore })} />
      <Workflows {...props} />
    </section>
  );
}
