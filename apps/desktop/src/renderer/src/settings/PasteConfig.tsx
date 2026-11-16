// 「粘贴配置」 at the top of the model form: paste the whole block,
// the fields it recognises are filled in, the rest is listed to place by hand.
// The pasted text lives only in this component's state (window memory).
import { useState } from 'react';
import { parsePastedConfig, type PasteResult, type PastedField } from '../../../shared/paste-config';
import type { ProviderKind } from '../../../shared/providers';
import { secretLabel, WSO2_KEY_LABEL } from '../../../shared/providers';
import { Icon } from '../ui/Icon';
import { t, tc } from '../../../shared/i18n';

const ORDER: PastedField[] = ['baseUrl', 'tokenUrl', 'clientId', 'secret', 'scope', 'model'];

export function fieldName(f: PastedField, kind: ProviderKind): string {
  switch (f) {
    case 'baseUrl':
      return kind === 'wso2' ? t('网关地址') : t('接口地址');
    case 'tokenUrl':
      return t('取 token 地址');
    case 'clientId':
      return WSO2_KEY_LABEL;
    case 'secret':
      return secretLabel(kind);
    case 'scope':
      return 'Scope';
    case 'model':
      return tc('field', '模型');
  }
}

export function PasteConfig({ kind, onApply }: { kind: ProviderKind; onApply(r: PasteResult): void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // What was filled as fields (named when shown, so a change of language renames them); notes are keys.
  const [done, setDone] = useState<{ filled: PastedField[]; kind: ProviderKind; unknown: string[]; notes: string[] } | null>(null);

  const apply = () => {
    const r = parsePastedConfig(text);
    onApply(r);
    setDone({ filled: ORDER.filter((f) => r.fields[f] !== undefined), kind: r.kind ?? kind, unknown: r.unknown, notes: r.notes });
    setText('');
    setOpen(false);
  };

  return (
    <div className="paste-config">
      {open ? (
        <div className="paste-config-box">
          <textarea
            className="input paste-config-input"
            rows={6}
            spellCheck={false}
            autoFocus
            value={text}
            aria-label={t('配置文本')}
            placeholder={t('KEY=VALUE，每行一项')}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="paste-config-actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              {t('取消')}
            </button>
            <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={apply}>
              {t('识别并填入')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-small btn-square" onClick={() => setOpen(true)} aria-label={t('粘贴配置')} title={t('粘贴配置')}>
          <Icon name="paste" size={15} />
        </button>
      )}
      {done && !open ? (
        <div className="paste-config-result" role="status">
          <p className={done.filled.length ? 'paste-config-line' : 'paste-config-line is-none'}>
            {done.filled.length ? t('已填入 {n} 项：{fields}', { n: done.filled.length, fields: done.filled.map((f) => fieldName(f, done.kind)).join(t('、')) }) : t('未识别到可填入的项。')}
            {done.notes.length ? ' ' + t('{notes}。', { notes: done.notes.map((n) => t(n)).join(t('；')) }) : ''}
          </p>
          {done.unknown.length ? (
            <>
              <p className="paste-config-line">{t('未识别：')}</p>
              <ul className="paste-config-unknown">
                {done.unknown.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
