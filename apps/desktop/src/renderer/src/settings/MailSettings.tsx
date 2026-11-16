// Mail sorting (on / off, how often, what to ignore), shown with the plugin
// that provides the mail: inside its card, or once above 已安装 when two or
// more plugins provide mail. The values are the shell's settings (sent to the
// core), the same whichever plugin shows them.
import { useState, type ReactNode } from 'react';
import { MAIL_INTERVALS, type MailPrefs } from '../../../shared/settings';
import { ConfirmDialog } from '../ui/Dialog';
import { useKeptDraft } from './drafts';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Switch } from './Switch';
import { Row } from './Group';
import { t } from '../../../shared/i18n';

export interface MailSettingsProps {
  prefs: MailPrefs;
  onChange(patch: Partial<MailPrefs>): void;
  /** The model mail goes to for sorting, in words (e.g. 「DeepSeek · deepseek-chat」); empty when none is set. */
  model?: string;
  /** A last row in the same box (来源, when shown once for several plugins). */
  extra?: ReactNode;
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function IgnoreRules({ prefs, onSave, saved, onEdit }: { prefs: MailPrefs; onSave(ignore: MailPrefs['ignore']): void; saved: boolean; onEdit(): void }) {
  const [from, setFrom, fromDone] = useKeptDraft('mail.ignore.from', prefs.ignore.from.join('\n'));
  const [subject, setSubject, subjectDone] = useKeptDraft('mail.ignore.subject', prefs.ignore.subject.join('\n'));
  const changed = lines(from).join('\n') !== prefs.ignore.from.join('\n') || lines(subject).join('\n') !== prefs.ignore.subject.join('\n');
  const editFrom = (v: string) => {
    setFrom(v);
    onEdit();
  };
  const editSubject = (v: string) => {
    setSubject(v);
    onEdit();
  };
  return (
    <Row title={t('忽略规则')} stack className="mail-rules">
      <div className="rule-grid">
        <label className="form-field">
          <span className="field-label">{t('发件人包含')}</span>
          <textarea className="input rule-input" rows={3} spellCheck={false} value={from} placeholder={t('每行一条，支持 /正则/')} onChange={(e) => editFrom(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="field-label">{t('主题包含')}</span>
          <textarea className="input rule-input" rows={3} spellCheck={false} value={subject} placeholder={t('每行一条，支持 /正则/')} onChange={(e) => editSubject(e.target.value)} />
        </label>
      </div>
      <div className="rule-actions">
        {saved && !changed ? (
          <span className="provider-result is-ok" role="status">
            <SpicaStatusIcon name="done" size={15} />
            {t('已保存')}
          </span>
        ) : null}
        {changed ? <span className="provider-unsaved">{t('未保存')}</span> : null}
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
          {t('保存')}
        </button>
      </div>
    </Row>
  );
}

export function MailSettings({ prefs, onChange, model = '', extra }: MailSettingsProps) {
  const [asking, setAsking] = useState(false);
  // 已保存 after 保存, like the model form, until the rules are edited again.
  const [rulesSaved, setRulesSaved] = useState(false);
  return (
    <>
    <div className="group-box mail-settings">
      <Row title={t('邮件分类')}>
        <Switch on={prefs.enabled} label={t('邮件分类')} onChange={(enabled) => (enabled ? setAsking(true) : onChange({ enabled: false }))} />
      </Row>
      <Row title={t('检查间隔')}>
        <div className="segmented" role="radiogroup" aria-label={t('检查间隔')}>
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
              {m < 60 ? t('{n} 分钟', { n: m }) : t('1 小时')}
            </button>
          ))}
        </div>
      </Row>
      <IgnoreRules
        key={JSON.stringify(prefs.ignore)}
        prefs={prefs}
        saved={rulesSaved}
        onEdit={() => setRulesSaved(false)}
        onSave={(ignore) => {
          onChange({ ignore });
          setRulesSaved(true);
        }}
      />
      {extra}
    </div>
      {asking ? (
        <ConfirmDialog
          title={t('开启邮件分类？')}
          detail={model ? t('新邮件的发件人、主题和正文开头将发送给「{model}」进行分类。', { model }) : t('新邮件的发件人、主题和正文开头将发送给默认模型进行分类。')}
          confirmLabel={t('开启')}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onChange({ enabled: true, consentedAt: new Date().toISOString() });
          }}
        />
      ) : null}
    </>
  );
}
