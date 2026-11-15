// Settings > 插件 > a plugin > 详情: the settings form the app draws from the plugin's user_config, the first
// group of the detail, shown whether the plugin is on or off (it may have to be filled in before it can run).
// Rows as everywhere in 设置: the field's title, the control on the right, what is wrong in the grey line.
// A password is never sent back: its box stays empty with 「已保存（留空不修改）」. A field the packaging set and
// locked shows its value, read-only, with 由管理员设置. One 保存 for the whole form; 未保存 beside it while what
// is typed differs from what is saved, and it stays (in memory) when you look elsewhere.
import { useState } from 'react';
import { checkConfigValue } from '@spica/plugins/user-config';
import type { PluginConfigFieldView, PluginConfigValues, PluginView } from '../../../shared/plugins';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { InfoTip } from '../ui/InfoTip';
import { Select } from '../ui/Select';
import { useKeptDraft } from './drafts';
import { Group, Row } from './Group';
import { Switch } from './Switch';

/** What a field's control holds: text for every box (numbers too, as typed), on / off for a switch. */
type FormValue = string | boolean;
type Form = Record<string, FormValue>;

/** The form as saved: stored values, else the defaults; passwords always empty. */
export function savedForm(fields: readonly PluginConfigFieldView[]): Form {
  const out: Form = {};
  for (const f of fields) {
    const v = f.value ?? f.default ?? null;
    if (f.type === 'toggle') out[f.key] = v === true;
    else if (f.type === 'password') out[f.key] = '';
    else out[f.key] = v === null ? '' : String(v);
  }
  return out;
}

/** The DOM id of a field's control (「N 项未填」 goes to the first one). */
export const configFieldId = (plugin: string, key: string) => `plugin-config-${plugin}-${key}`;

export interface PluginConfigProps {
  p: PluginView;
  busy: boolean;
  /** Save: what the form sends; resolves with what is wrong by key (empty: saved). */
  save(values: PluginConfigValues): Promise<Record<string, string>>;
  /** The system's picker for a folder or a file field. */
  pickPath?: ((kind: 'folder' | 'file', title: string) => Promise<string | null>) | undefined;
}

export function PluginConfig({ p, busy, save, pickPath }: PluginConfigProps) {
  const fields = p.config?.fields ?? [];
  const saved = savedForm(fields);
  const [form, setForm, done] = useKeptDraft<Form>(`plugin.config:${p.name}`, saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<'saved' | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  if (!fields.length) return null;

  const set = (key: string, v: FormValue) => {
    setForm({ ...form, [key]: v });
    setResult(null);
    if (errors[key]) {
      const rest = { ...errors };
      delete rest[key];
      setErrors(rest);
    }
  };

  const submit = async () => {
    // the same checks the app makes when it stores them, said under each field before anything is sent
    const found: Record<string, string> = {};
    const values: PluginConfigValues = {};
    for (const f of fields) {
      if (f.locked) continue;
      const v = form[f.key];
      if (f.type === 'password') {
        if (typeof v === 'string' && v) values[f.key] = v;
        continue;
      }
      const c = checkConfigValue(f, typeof v === 'string' && v.trim() === '' ? null : v);
      if (!c.ok) found[f.key] = c.message;
      else values[f.key] = c.value;
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    const back = await save(values);
    setErrors(back);
    if (!Object.keys(back).length) {
      // a saved password is not shown again: its box goes back to empty (已保存（留空不修改）)
      setForm(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, fields.find((f) => f.key === k)?.type === 'password' ? '' : v])));
      done();
      setResult('saved');
    }
  };

  return (
    <Group title="设置" className="plugin-config">
      {fields.map((f) => (
        <ConfigRow key={f.key} plugin={p.name} f={f} value={form[f.key] ?? ''} error={errors[f.key]} disabled={busy} onChange={(v) => set(f.key, v)} pickPath={pickPath} />
      ))}
      <div className="plugin-config-actions">
        {result === 'saved' && !dirty ? (
          <span className="provider-result is-ok" role="status">
            <SpicaStatusIcon name="done" size={15} />
            已保存
          </span>
        ) : null}
        {dirty ? <span className="provider-unsaved">未保存</span> : null}
        <button type="button" className="btn btn-small btn-primary" disabled={busy || !dirty} onClick={() => void submit()}>
          保存
        </button>
      </div>
    </Group>
  );
}

function ConfigRow({
  plugin,
  f,
  value,
  error,
  disabled,
  onChange,
  pickPath,
}: {
  plugin: string;
  f: PluginConfigFieldView;
  value: FormValue;
  error: string | undefined;
  disabled: boolean;
  onChange(v: FormValue): void;
  pickPath: PluginConfigProps['pickPath'];
}) {
  const id = configFieldId(plugin, f.key);
  const title = (
    <>
      {f.title}
      {f.required ? <span className="config-required" aria-label="必填"> *</span> : null}
      {f.description ? <InfoTip text={f.description} decorative /> : null}
    </>
  );
  // what is wrong in red where the grey line goes; a locked field says who set it, a locked one gone bad who to ask
  const hint = error ? <span className="field-error">{error}</span> : f.locked ? (f.set ? '由管理员设置' : <span className="field-error">请联系管理员</span>) : undefined;
  const text = typeof value === 'string' ? value : '';
  let control;
  if (f.type === 'toggle') {
    control = <Switch on={value === true} label={f.title} disabled={disabled || !!f.locked} onChange={(on) => onChange(on)} />;
  } else if (f.type === 'select') {
    control = (
      <Select
        className="config-select"
        value={text}
        label={f.title}
        placeholder="选择"
        disabled={disabled || !!f.locked}
        options={[...(f.required || f.default !== undefined ? [] : [{ value: '', label: '—' }]), ...(f.options ?? []).map((o) => ({ value: o, label: o }))]}
        onChange={(v) => onChange(v)}
      />
    );
  } else if (f.type === 'folder' || f.type === 'file') {
    control = (
      <span className="config-path">
        <span className="config-path-text" id={id} title={text || undefined} data-tip-clipped="">
          {text || '—'}
        </span>
        {f.locked ? null : (
          <>
            <button
              type="button"
              className="btn btn-square"
              disabled={disabled || !pickPath}
              aria-label={`选择${f.title}`}
              title="选择"
              onClick={() => void pickPath?.(f.type === 'folder' ? 'folder' : 'file', f.title).then((path) => path && onChange(path))}
            >
              <Icon name="pencil" size={16} />
            </button>
            {text && !f.required ? (
              <button type="button" className="btn btn-square" disabled={disabled} aria-label={`清除${f.title}`} title="清除" onClick={() => onChange('')}>
                <Icon name="close" size={14} />
              </button>
            ) : null}
          </>
        )}
      </span>
    );
  } else if (f.locked) {
    // set by the packaging: its value as text, nothing that looks like it can be typed into
    control = (
      <span className="config-locked" id={id} title={text || undefined} data-tip-clipped="">
        {f.type === 'password' ? (f.set ? '••••••' : '—') : text || '—'}
      </span>
    );
  } else {
    control = (
      <input
        id={id}
        className={error ? 'input config-input is-invalid' : 'input config-input'}
        type={f.type === 'password' ? 'password' : 'text'}
        inputMode={f.type === 'number' ? 'decimal' : f.type === 'url' ? 'url' : undefined}
        value={text}
        placeholder={f.type === 'password' && f.set ? '已保存（留空不修改）' : (f.placeholder ?? '')}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label={f.title}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Row title={title} hint={hint} className={f.locked ? 'config-row is-locked' : 'config-row'}>
      {control}
    </Row>
  );
}
