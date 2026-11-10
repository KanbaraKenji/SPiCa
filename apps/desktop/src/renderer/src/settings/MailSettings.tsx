// Mail sorting (on / off, how often, what to ignore), shown with the plugin
// that provides the mail: inside its card, or once above 已安装 when two or
// more plugins provide mail. The values are the shell's settings (sent to the
// core), the same whichever plugin shows them.
import { useState } from 'react';
import { MAIL_INTERVALS, type MailPrefs } from '../../../shared/settings';
import { ConfirmDialog } from '../ui/Dialog';
import { useKeptDraft } from './drafts';
import { Switch } from './Switch';

export interface MailSettingsProps {
  prefs: MailPrefs;
  onChange(patch: Partial<MailPrefs>): void;
  /** The model mail goes to for sorting, in words (e.g. 「DeepSeek · deepseek-chat」); empty when none is set. */
  model?: string;
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function IgnoreRules({ prefs, onSave }: { prefs: MailPrefs; onSave(ignore: MailPrefs['ignore']): void }) {
  const [from, setFrom, fromDone] = useKeptDraft('mail.ignore.from', prefs.ignore.from.join('\n'));
  const [subject, setSubject, subjectDone] = useKeptDraft('mail.ignore.subject', prefs.ignore.subject.join('\n'));
  const changed = lines(from).join('\n') !== prefs.ignore.from.join('\n') || lines(subject).join('\n') !== prefs.ignore.subject.join('\n');
  return (
    <div className="mail-rules">
      <span className="field-label">忽略规则</span>
      <div className="rule-grid">
        <label className="form-field">
          <span className="field-label">发件人包含</span>
          <textarea className="input rule-input" rows={3} spellCheck={false} value={from} placeholder="每行一条，支持 /正则/" onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="field-label">主题包含</span>
          <textarea className="input rule-input" rows={3} spellCheck={false} value={subject} placeholder="每行一条，支持 /正则/" onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <div className="rule-actions">
        {changed ? <span className="provider-unsaved">未保存</span> : null}
        <button
          type="button"
          className="btn btn-small"
          disabled={!changed}
          onClick={() => {
            onSave({ from: lines(from), subject: lines(subject) });
            fromDone();
            subjectDone();
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

export function MailSettings({ prefs, onChange, model = '' }: MailSettingsProps) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="mail-settings">
      <div className="mail-row">
        <span className="mail-title">邮件分类</span>
        <Switch on={prefs.enabled} label="邮件分类" onChange={(enabled) => (enabled ? setAsking(true) : onChange({ enabled: false }))} />
      </div>
      <div className="interval-row">
        <span className="field-label">检查间隔</span>
        <div className="segmented" role="radiogroup" aria-label="检查间隔">
          {MAIL_INTERVALS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={prefs.intervalMinutes === m}
              disabled={!prefs.enabled}
              className={prefs.intervalMinutes === m ? 'segment is-on' : 'segment'}
              onClick={() => onChange({ intervalMinutes: m })}
            >
              {m < 60 ? `${m} 分钟` : '1 小时'}
            </button>
          ))}
        </div>
      </div>
      <IgnoreRules key={JSON.stringify(prefs.ignore)} prefs={prefs} onSave={(ignore) => onChange({ ignore })} />
      {asking ? (
        <ConfirmDialog
          title="开启邮件分类？"
          detail={`新邮件的发件人、主题和正文开头将发送给${model ? `「${model}」` : '默认模型'}进行分类。`}
          confirmLabel="开启"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onChange({ enabled: true, consentedAt: new Date().toISOString() });
          }}
        />
      ) : null}
    </div>
  );
}
