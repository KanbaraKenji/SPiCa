// Settings > 模型: 认证方式 (the API Key, or a gateway that takes its key in its own request header such as
// X-API-Key) with the header rows, and, under 更多选项 of 公司网关（WSO2）, 凭据位置 (where the Consumer Key and
// Secret go when a token is fetched). Header values are treated as secrets: a saved one is never sent back,
// only masked, and an empty value keeps it.
import { CREDENTIALS_IN, headerCellErrors, type AuthBy, type CredentialsIn, type HeaderDraft, type HeaderView } from '../../../shared/providers';
import { Icon } from '../ui/Icon';
import { FormRow } from './FormRow';
import { N_, t } from '../../../shared/i18n';

/** The rows the form starts from for a saved connection. */
export function headerRows(saved: readonly HeaderView[] | undefined): HeaderDraft[] {
  return (saved ?? []).map((h) => ({ name: h.name, saved: true }));
}

const AUTH_CHOICES: readonly { value: AuthBy; label: string }[] = [
  { value: 'key', label: 'API Key' },
  { value: 'header', label: N_('请求头') },
];

export function AuthByField({ value, onChange }: { value: AuthBy; onChange(v: AuthBy): void }) {
  return (
    <FormRow title={t('认证方式')}>
      <div className="segmented" role="radiogroup" aria-label={t('认证方式')}>
        {AUTH_CHOICES.map((c) => (
          <button key={c.value} type="button" role="radio" aria-checked={value === c.value} className={value === c.value ? 'segment is-on' : 'segment'} onClick={() => onChange(c.value)}>
            {t(c.label)}
          </button>
        ))}
      </div>
    </FormRow>
  );
}

/**
 * 认证方式 请求头: one row per header, 名称 and 值 side by side, both needed. `showErrors` (after 保存 or
 * 测试连接 found a problem): each cell that is wrong is marked, its message under it.
 */
export function HeadersField({ rows, saved, onChange, showErrors }: { rows: readonly HeaderDraft[]; saved: readonly HeaderView[] | undefined; onChange(rows: HeaderDraft[]): void; showErrors: boolean }) {
  const list: readonly HeaderDraft[] = rows.length ? rows : [{ name: '' }];
  const cells = showErrors ? headerCellErrors(list) : [];
  const maskOf = (h: HeaderDraft) => (h.saved ? saved?.find((s) => s.name.toLowerCase() === h.name.trim().toLowerCase())?.mask : undefined);
  const edit = (i: number, patch: Partial<HeaderDraft>) =>
    onChange(
      list.map((h, j) => {
        if (j !== i) return h;
        const next = { ...h, ...patch };
        // a saved row given another name no longer stands for the saved value
        if (patch.name !== undefined && h.saved && patch.name.trim().toLowerCase() !== h.name.trim().toLowerCase()) delete next.saved;
        return next;
      }),
    );
  return (
    <FormRow stack title={t('请求头')}>
        <span className="header-rows">
          {list.map((h, i) => {
            const mask = maskOf(h);
            const err = cells[i] ?? {};
            return (
              <span key={i} className="header-row">
                <span className={err.name ? 'header-cell header-name has-problem-in-box' : 'header-cell header-name'}>
                  <input
                    className={err.name ? 'input is-invalid' : 'input'}
                    value={h.name}
                    placeholder="X-API-Key"
                    aria-label={t('请求头名称')}
                    aria-invalid={err.name ? true : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => edit(i, { name: e.target.value })}
                  />
                  {err.name ? <span className="field-error problem-in-box">{err.name}</span> : null}
                </span>
                <span className={err.value ? 'header-cell header-value has-problem-in-box' : 'header-cell header-value'}>
                  <input
                    className={err.value ? 'input is-invalid' : 'input'}
                    type="password"
                    value={h.value ?? ''}
                    placeholder={mask ? t('{mask}（留空不修改）', { mask }) : t('值')}
                    aria-label={t('{name} 的值', { name: h.name.trim() || t('请求头') })}
                    aria-invalid={err.value ? true : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => edit(i, { value: e.target.value })}
                  />
                  {err.value ? <span className="field-error problem-in-box">{err.value}</span> : null}
                </span>
                {list.length > 1 ? (
                  <button type="button" className="icon-btn" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label={t('删除 {name}', { name: h.name.trim() || t('请求头') })} title={t('删除')}>
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </span>
            );
          })}
        </span>
        <span className="model-pills">
          <button type="button" className="model-pill is-action" onClick={() => onChange([...list, { name: '' }])}>
            <Icon name="plus" size={12} />
            {t('添加')}
          </button>
        </span>
    </FormRow>
  );
}

export function CredentialsInField({ value, onChange }: { value: CredentialsIn | null; onChange(v: CredentialsIn | null): void }) {
  return (
    <FormRow title={t('凭据位置')}>
      <div className="segmented" role="radiogroup" aria-label={t('凭据位置')}>
        {CREDENTIALS_IN.map((c) => (
          <button key={c.label} type="button" role="radio" aria-checked={value === c.value} className={value === c.value ? 'segment is-on' : 'segment'} onClick={() => onChange(c.value)}>
            {t(c.label)}
          </button>
        ))}
      </div>
    </FormRow>
  );
}
