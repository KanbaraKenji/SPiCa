// Settings > 模型: the model connections the agents use. Three kinds of form
// (OpenAI compatible, Anthropic, WSO2 gateway), "测试连接", default choice.
import { useEffect, useRef, useState } from 'react';
import type { ProviderList } from '../../../shared/bridge';
import {
  emptyDraft,
  kindLabel,
  PROVIDER_KINDS,
  secretLabel,
  validateDraft,
  WSO2_KEY_LABEL,
  type FieldErrors,
  type ProviderDraft,
  type ProviderKind,
  type ProviderView,
  type TestResult,
} from '../../../shared/providers';
import { friendlyError } from '../store/agent';
import { tokenText } from '../chat/Composer';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { APP_NAME } from '../../../shared/app-identity';
import { dropDraft, keepDraft, keptDraft } from './drafts';

export interface ProvidersApi {
  list(): Promise<ProviderList>;
  save(draft: ProviderDraft): Promise<ProviderList>;
  remove(id: string): Promise<ProviderList>;
  setDefault(id: string): Promise<ProviderList>;
  test(draft: ProviderDraft): Promise<TestResult>;
  /** The context window Spica knows for a model (pre-fills the form), or null. */
  knownWindow?(kind: ProviderKind, model: string): Promise<number | null>;
  /** The models changed elsewhere (a connected script); the list is read again. */
  onChanged?(listener: () => void): () => void;
}

const WINDOW_HINT = '这个模型一次最多能装多少 token（上下文窗口）。不知道就查服务商的模型说明。';

/** What to say under 上下文上限: filled in by Spica, how big that is, or what to put there. */
function windowHint(value: number | null, prefilled: number | null): string {
  if (value !== null && value === prefilled) return `${APP_NAME} 认识这个型号，已经填上（${tokenText(value)}），可以改。`;
  if (value !== null && Number.isInteger(value) && value > 0) return `${tokenText(value)} token。${WINDOW_HINT}`;
  return WINDOW_HINT;
}

function draftFrom(p: ProviderView): ProviderDraft {
  const { hasSecret: _h, isDefault: _d, readOnly: _r, ...fields } = p;
  void _h;
  void _d;
  void _r;
  // An older main process (dev hot reload) does not send contextWindow yet.
  return { ...fields, contextWindow: fields.contextWindow ?? null };
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
        {error ? <span className="field-error">{error}</span> : null}
        {hint ? <span className="field-hint">{hint}</span> : null}
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
  // 上下文上限 Spica filled in by itself (so a later model change may replace it, and the hint says so).
  const [prefilled, setPrefilledState] = useState<number | null>(null);
  const prefilledRef = useRef<number | null>(null);
  // The form as it is now, for answers that arrive after the user typed on.
  const latest = useRef<{ draft: ProviderDraft; selected: string | 'new' | null }>({ draft, selected });
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    },
    [],
  );

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
        } else if (!keptDraft(draftKey(sel))) {
          setDraft(draftFrom(p));
          latest.current = { draft: draftFrom(p), selected: sel };
        }
      })
      .catch((e: unknown) => alive && setResult({ ok: false, message: friendlyError(e) }));
    // Changed by a connected script while this page is open: show the new list (drafts stay).
    const off = api.onChanged?.(() => {
      void api
        .list()
        .then((l) => alive && setList(l))
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      off?.();
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

  const setPrefilled = (n: number | null) => {
    prefilledRef.current = n;
    setPrefilledState(n);
  };

  /** A field the user changed no longer shows its old complaint (checked again on 保存 / 测试连接). */
  const clearErrors = (keys: string[]) =>
    setErrors((e) => {
      if (!keys.some((k) => k in e)) return e;
      const rest = { ...e };
      for (const k of keys) delete rest[k as keyof FieldErrors];
      return rest;
    });

  /** Show `next` and keep it as the draft of `sel` (compared with `base`, what is saved). */
  const commit = (next: ProviderDraft, sel: string | 'new' | null, base: ProviderDraft) => {
    setDraft(next);
    latest.current = { draft: next, selected: sel };
    if (sel) keepDraft(draftKey(sel), next, base);
  };

  /** Ask what Spica knows of this model's window; fill it in unless the user typed one. */
  const lookUp = (d: ProviderDraft, sel: string | 'new' | null, base: ProviderDraft) => {
    const known = api.knownWindow;
    const model = d.model.trim();
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (!known || !model) return;
    lookupTimer.current = setTimeout(() => {
      void known(d.kind, model)
        .then((n) => {
          const now = latest.current;
          if (now.selected !== sel || now.draft.kind !== d.kind || now.draft.model.trim() !== model) return;
          const typedByHand = now.draft.contextWindow !== null && now.draft.contextWindow !== prefilledRef.current;
          if (typedByHand) return;
          if (n) {
            setPrefilled(n);
            commit({ ...now.draft, contextWindow: n }, sel, base);
            clearErrors(['contextWindow']);
          } else if (prefilledRef.current !== null) {
            // The earlier model was known, this one is not: do not leave its number behind.
            setPrefilled(null);
            commit({ ...now.draft, contextWindow: null }, sel, base);
          }
        })
        .catch(() => undefined);
    }, 300);
  };

  const open = (p: ProviderView | 'new') => {
    const id = p === 'new' ? 'new' : p.id;
    const next = keptDraft<ProviderDraft>(draftKey(id)) ?? (p === 'new' ? emptyDraft() : draftFrom(p));
    setSelected(id);
    setDraft(next);
    latest.current = { draft: next, selected: id };
    setPrefilled(null);
    setErrors({});
    setResult(null);
    setMore(false);
    // Saved before 上下文上限 existed: fill it in if Spica knows the model.
    if (next.contextWindow === null) lookUp(next, id, p === 'new' ? emptyDraft() : draftFrom(p));
  };

  const set = (patch: Partial<ProviderDraft>) => {
    const next = { ...draft, ...patch };
    commit(next, selected, savedDraft());
    setResult(null);
    clearErrors(Object.keys(patch));
    if ('contextWindow' in patch) setPrefilled(null);
    if ('model' in patch || 'kind' in patch) lookUp(next, selected, savedDraft());
  };

  const changeKind = (kind: ProviderKind) => {
    const blank = emptyDraft(kind);
    set({ kind, baseUrl: draft.baseUrl && draft.kind !== 'anthropic' ? draft.baseUrl : blank.baseUrl });
  };

  const check = (forTest = false): boolean => {
    const e = validateDraft(draft, hasSecret, { forTest });
    setErrors(e);
    if (MORE_FIELDS.some((f) => f in e)) setMore(true);
    return Object.keys(e).length === 0;
  };

  const test = async () => {
    if (!check(true)) return;
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
        latest.current = { draft: draftFrom(saved), selected: saved.id };
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
              {!p.readOnly && p.contextWindow === null ? <span className="provider-problem">还没填上下文上限，点开补上</span> : null}
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
              hint={
                draft.kind === 'wso2'
                  ? '管理员给的模型接口地址，一般以 /v1 结尾，不带 /chat/completions'
                  : '服务商说明里的接口地址，一般以 /v1 结尾，不带 /chat/completions'
              }
            />
          )}
          {draft.kind === 'wso2' ? (
            <>
              <Field
                label="取 token 地址"
                value={draft.tokenUrl}
                onChange={(tokenUrl) => set({ tokenUrl })}
                error={errors.tokenUrl}
                placeholder="https://网关地址/oauth2/token"
                hint="一般以 /token 或 /oauth2/token 结尾"
              />
              <Field
                label={WSO2_KEY_LABEL}
                value={draft.clientId}
                onChange={(clientId) => set({ clientId })}
                error={errors.clientId}
                hint="也叫 Client ID。在 WSO2 开发者门户里，你的应用的 Production Keys 下面"
              />
            </>
          ) : null}
          <Field
            label={secretLabel(draft.kind)}
            type="password"
            value={draft.secret ?? ''}
            onChange={(secret) => set({ secret })}
            error={errors.secret}
            placeholder={hasSecret ? '已保存；不改就留空' : ''}
            {...(draft.kind === 'wso2' ? { hint: '也叫 Client Secret。和 Consumer Key 在同一处（Production Keys）' } : {})}
          />
          {draft.kind === 'wso2' ? <Field label="Scope" value={draft.scope} onChange={(scope) => set({ scope })} hint="网关没要求就留空" /> : null}
          <Field
            label="模型"
            value={draft.model}
            onChange={(model) => set({ model })}
            error={errors.model}
            placeholder="平时用的模型名"
            hint={draft.kind === 'wso2' ? '照管理员给的原样填，区分大小写，可以带斜杠' : '照服务商说明里的模型名原样填，区分大小写'}
          />
          <Field
            label="上下文上限"
            type="number"
            value={numText(draft.contextWindow)}
            onChange={(v) => set({ contextWindow: parseNum(v) })}
            error={errors.contextWindow}
            placeholder="比如 128000"
            hint={windowHint(draft.contextWindow, prefilled)}
          />
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
