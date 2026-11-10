// Settings > 模型: the model connections the agents use. Three kinds of form
// (OpenAI compatible, Anthropic, WSO2 gateway), "测试连接", default choice.
import { useEffect, useState } from 'react';
import type { ProviderList } from '../../../shared/bridge';
import {
  emptyDraft,
  kindLabel,
  PROVIDER_KINDS,
  secretLabel,
  validateDraft,
  type FieldErrors,
  type ProviderDraft,
  type ProviderKind,
  type ProviderView,
  type TestResult,
} from '../../../shared/providers';
import { friendlyError } from '../store/agent';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { dropDraft, keepDraft, keptDraft } from './drafts';

export interface ProvidersApi {
  list(): Promise<ProviderList>;
  save(draft: ProviderDraft): Promise<ProviderList>;
  remove(id: string): Promise<ProviderList>;
  setDefault(id: string): Promise<ProviderList>;
  test(draft: ProviderDraft): Promise<TestResult>;
}

function draftFrom(p: ProviderView): ProviderDraft {
  const { hasSecret: _h, isDefault: _d, readOnly: _r, ...fields } = p;
  void _h;
  void _d;
  void _r;
  return fields;
}

interface FieldProps {
  label: string;
  value: string;
  onChange(v: string): void;
  error?: string | undefined;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
  hint?: string;
}

function Field({ label, value, onChange, error, placeholder, type = 'text', hint }: FieldProps) {
  return (
    <label className="field field-stack">
      <span className="field-label">{label}</span>
      <span className="field-control">
        <input
          className={error ? 'input is-invalid' : 'input'}
          type={type}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

// Which model was open and what was typed into each one, kept while you look elsewhere.
const SELECTED = 'models.selected';
const draftKey = (id: string | 'new') => `models.draft:${id}`;

/** 强模型 and the two limits: first-time setup does not need them. */
const MORE_FIELDS = ['strongModel', 'maxConcurrent', 'requestsPerMinute'] as const;

function numText(v: number | null): string {
  return v === null ? '' : String(v);
}

function parseNum(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function Models({ api }: { api: ProvidersApi }) {
  const [list, setList] = useState<ProviderList | null>(null);
  const [selected, setSelectedState] = useState<string | 'new' | null>(() => keptDraft<string>(SELECTED) ?? null);
  const [draft, setDraft] = useState<ProviderDraft>(() => {
    const sel = keptDraft<string>(SELECTED);
    return (sel ? keptDraft<ProviderDraft>(draftKey(sel)) : undefined) ?? emptyDraft();
  });
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [deleting, setDeleting] = useState<ProviderView | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .list()
      .then((l) => {
        if (!alive) return;
        setList(l);
        // Back on this page with a model open: its draft if any, else what is saved.
        const sel = keptDraft<string>(SELECTED);
        if (!sel || sel === 'new') return;
        const p = l.items.find((x) => x.id === sel);
        if (!p) {
          dropDraft(draftKey(sel));
          dropDraft(SELECTED);
          setSelectedState(null);
        } else if (!keptDraft(draftKey(sel))) setDraft(draftFrom(p));
      })
      .catch((e: unknown) => alive && setResult({ ok: false, message: friendlyError(e) }));
    return () => {
      alive = false;
    };
  }, [api]);

  const items = list?.items ?? [];
  const current = selected && selected !== 'new' ? items.find((p) => p.id === selected) : undefined;
  const hasSecret = Boolean(current?.hasSecret);

  function setSelected(id: string | 'new' | null) {
    setSelectedState(id);
    if (id === null) dropDraft(SELECTED);
    else keepDraft(SELECTED, id, null);
  }

  /** What the open model looks like saved (a blank form for a new one). */
  const savedDraft = (): ProviderDraft => (current ? draftFrom(current) : emptyDraft());

  const open = (p: ProviderView | 'new') => {
    const id = p === 'new' ? 'new' : p.id;
    setSelected(id);
    setDraft(keptDraft<ProviderDraft>(draftKey(id)) ?? (p === 'new' ? emptyDraft() : draftFrom(p)));
    setErrors({});
    setResult(null);
    setMore(false);
  };

  const set = (patch: Partial<ProviderDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (selected) keepDraft(draftKey(selected), next, savedDraft());
    setResult(null);
  };

  const changeKind = (kind: ProviderKind) => {
    const blank = emptyDraft(kind);
    set({ kind, baseUrl: draft.baseUrl && draft.kind !== 'anthropic' ? draft.baseUrl : blank.baseUrl });
  };

  const check = (): boolean => {
    const e = validateDraft(draft, hasSecret);
    setErrors(e);
    if (MORE_FIELDS.some((f) => f in e)) setMore(true);
    return Object.keys(e).length === 0;
  };

  const test = async () => {
    if (!check()) return;
    setBusy('test');
    try {
      setResult(await api.test(draft));
    } catch (e) {
      setResult({ ok: false, message: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!check()) return;
    setBusy('save');
    try {
      const next = await api.save(draft);
      setList(next);
      if (selected) dropDraft(draftKey(selected));
      const saved = draft.id ? next.items.find((p) => p.id === draft.id) : next.items.find((p) => !items.some((o) => o.id === p.id));
      if (saved) {
        setSelected(saved.id);
        setDraft(draftFrom(saved));
      }
      setResult({ ok: true, message: '已保存' });
    } catch (e) {
      setResult({ ok: false, message: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async (id: string) => {
    try {
      setList(await api.setDefault(id));
    } catch (e) {
      setResult({ ok: false, message: friendlyError(e) });
    }
  };

  const remove = async (p: ProviderView) => {
    setDeleting(null);
    try {
      setList(await api.remove(p.id));
      dropDraft(draftKey(p.id));
      setSelected(null);
    } catch (e) {
      setResult({ ok: false, message: friendlyError(e) });
    }
  };

  const editing = selected !== null && !current?.readOnly;

  return (
    <section className="settings-section">

      <div className="provider-list" role="list">
        {list && items.length === 0 ? <p className="settings-hint">还没有配置模型</p> : null}
        {items.map((p) => (
          <div key={p.id} role="listitem" className={selected === p.id ? 'provider-row is-on' : 'provider-row'}>
            <button type="button" className="provider-open" onClick={() => open(p)} aria-current={selected === p.id ? 'true' : undefined}>
              <span className="provider-name">{p.name}</span>
              <span className="provider-sub">
                {kindLabel(p.kind)} · {p.model}
              </span>
              {list?.problems[p.id] ? <span className="provider-problem">{list.problems[p.id]}</span> : null}
              {keptDraft(draftKey(p.id)) ? <span className="provider-unsaved">改了还没保存</span> : null}
            </button>
            {p.isDefault ? (
              <span className="provider-default">默认</span>
            ) : (
              <button type="button" className="btn btn-small" onClick={() => void makeDefault(p.id)}>
                设为默认
              </button>
            )}
          </div>
        ))}
        <button type="button" className={selected === 'new' ? 'provider-add is-on' : 'provider-add'} onClick={() => open('new')}>
          <Icon name="plus" size={14} />
          添加模型
          {keptDraft(draftKey('new')) ? <span className="provider-unsaved">填了一半，还没保存</span> : null}
        </button>
      </div>

      {current?.readOnly ? <p className="settings-hint provider-readonly">这一项来自开发配置文件，在这里改不了。</p> : null}

      {editing ? (
        <form
          className="provider-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field field-stack">
            <span className="field-label">类型</span>
            <div className="segmented" role="radiogroup" aria-label="类型">
              {PROVIDER_KINDS.map((k) => (
                <button key={k.kind} type="button" role="radio" aria-checked={draft.kind === k.kind} className={draft.kind === k.kind ? 'segment is-on' : 'segment'} onClick={() => changeKind(k.kind)}>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <Field label="名称" value={draft.name} onChange={(name) => set({ name })} error={errors.name} placeholder="比如：公司网关、DeepSeek" />
          {draft.kind === 'anthropic' ? (
            <Field label="接口地址" value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} hint="用官方接口就保持默认" />
          ) : (
            <Field
              label={draft.kind === 'wso2' ? '网关地址' : '接口地址'}
              value={draft.baseUrl}
              onChange={(baseUrl) => set({ baseUrl })}
              error={errors.baseUrl}
              placeholder={draft.kind === 'wso2' ? 'https://网关地址/模型路径/v1' : 'https://api.example.com/v1'}
            />
          )}
          {draft.kind === 'wso2' ? (
            <>
              <Field label="取 token 地址" value={draft.tokenUrl} onChange={(tokenUrl) => set({ tokenUrl })} error={errors.tokenUrl} placeholder="https://网关地址/oauth2/token" />
              <Field label="Client ID" value={draft.clientId} onChange={(clientId) => set({ clientId })} error={errors.clientId} />
            </>
          ) : null}
          <Field
            label={secretLabel(draft.kind)}
            type="password"
            value={draft.secret ?? ''}
            onChange={(secret) => set({ secret })}
            error={errors.secret}
            placeholder={hasSecret ? '已保存；不改就留空' : ''}
          />
          {draft.kind === 'wso2' ? <Field label="Scope" value={draft.scope} onChange={(scope) => set({ scope })} hint="网关没要求就留空" /> : null}
          <Field label="模型" value={draft.model} onChange={(model) => set({ model })} error={errors.model} placeholder="平时用的模型名" />
          <div className="provider-more">
            <button type="button" className="fold-head" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              <span className="fold-label">更多选项</span>
              <Icon name="chevronRight" size={14} className="fold-chevron" />
            </button>
          </div>
          {more ? (
            <>
              <Field label="强模型" value={draft.strongModel} onChange={(strongModel) => set({ strongModel })} hint="重活用的模型，可留空" />
              <div className="field-pair">
                <Field label="同时请求" type="number" value={numText(draft.maxConcurrent)} onChange={(v) => set({ maxConcurrent: parseNum(v) })} error={errors.maxConcurrent} hint="留空表示不限" />
                <Field label="每分钟请求" type="number" value={numText(draft.requestsPerMinute)} onChange={(v) => set({ requestsPerMinute: parseNum(v) })} error={errors.requestsPerMinute} hint="留空表示不限" />
              </div>
            </>
          ) : null}

          <div className="provider-actions">
            {current ? (
              <button type="button" className="btn btn-quiet-danger" onClick={() => setDeleting(current)}>
                <Icon name="trash" size={14} />
                删除
              </button>
            ) : null}
            <span className="provider-actions-gap" />
            {result ? (
              <span className={result.ok ? 'provider-result is-ok' : 'provider-result is-bad'} role="status">
                {result.ok ? <Icon name="check" size={14} /> : null}
                {result.message}
              </span>
            ) : null}
            <button type="button" className="btn" onClick={() => void test()} disabled={busy !== null}>
              {busy === 'test' ? <span className="spinner" aria-hidden /> : null}
              测试连接
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              保存
            </button>
          </div>
        </form>
      ) : null}

      {deleting ? <ConfirmDialog title={`删除模型「${deleting.name}」？`} confirmLabel="删除" danger onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} /> : null}
    </section>
  );
}
