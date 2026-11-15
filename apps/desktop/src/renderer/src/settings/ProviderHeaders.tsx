// Settings > 模型 > 更多选项: 自定义请求头 (a gateway that takes its key in its own header, such as X-API-Key) and,
// for 公司网关（WSO2）, 凭据位置 (where the Consumer Key and Secret go when a token is fetched). Values are
// treated as secrets: a saved one is never sent back, only masked, and an empty value keeps it.
import { CREDENTIALS_IN, type CredentialsIn, type HeaderDraft, type HeaderView } from '../../../shared/providers';
import { Icon } from '../ui/Icon';

/** The rows the form starts from for a saved connection. */
export function headerRows(saved: readonly HeaderView[] | undefined): HeaderDraft[] {
  return (saved ?? []).map((h) => ({ name: h.name, saved: true }));
}

export function HeadersField({ rows, saved, onChange, error }: { rows: readonly HeaderDraft[]; saved: readonly HeaderView[] | undefined; onChange(rows: HeaderDraft[]): void; error?: string | undefined }) {
  const maskOf = (h: HeaderDraft) => (h.saved ? saved?.find((s) => s.name.toLowerCase() === h.name.trim().toLowerCase())?.mask : undefined);
  const edit = (i: number, patch: Partial<HeaderDraft>) =>
    onChange(
      rows.map((h, j) => {
        if (j !== i) return h;
        const next = { ...h, ...patch };
        // a saved row given another name no longer stands for the saved value
        if (patch.name !== undefined && h.saved && patch.name.trim().toLowerCase() !== h.name.trim().toLowerCase()) delete next.saved;
        return next;
      }),
    );
  return (
    <div className="field field-stack">
      <span className="field-label">自定义请求头</span>
      <span className="field-control">
        {rows.length ? (
          <span className="header-rows">
            {rows.map((h, i) => {
              const mask = maskOf(h);
              return (
                <span key={i} className="header-row">
                  <input className="input header-name" value={h.name} placeholder="X-API-Key" aria-label="请求头名称" spellCheck={false} autoComplete="off" onChange={(e) => edit(i, { name: e.target.value })} />
                  <input
                    className="input header-value"
                    type="password"
                    value={h.value ?? ''}
                    placeholder={mask ? `${mask}（留空不修改）` : '值'}
                    aria-label={`${h.name.trim() || '请求头'} 的值`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => edit(i, { value: e.target.value })}
                  />
                  <button type="button" className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`删除 ${h.name.trim() || '请求头'}`} title="删除">
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              );
            })}
          </span>
        ) : null}
        <span className="model-pills">
          <button type="button" className="model-pill is-action" onClick={() => onChange([...rows, { name: '' }])}>
            <Icon name="plus" size={12} />
            添加请求头
          </button>
        </span>
        {error ? <span className="field-error">{error}</span> : null}
      </span>
    </div>
  );
}

export function CredentialsInField({ value, onChange }: { value: CredentialsIn | null; onChange(v: CredentialsIn | null): void }) {
  return (
    <div className="field field-stack">
      <span className="field-label">凭据位置</span>
      <div className="segmented" role="radiogroup" aria-label="凭据位置">
        {CREDENTIALS_IN.map((c) => (
          <button key={c.label} type="button" role="radio" aria-checked={value === c.value} className={value === c.value ? 'segment is-on' : 'segment'} onClick={() => onChange(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
