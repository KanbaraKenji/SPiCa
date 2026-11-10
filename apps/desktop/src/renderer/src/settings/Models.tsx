// Settings > 模型: the connections the agents use. A connection is one provider
// (picked from the catalog, a company preset, 中转站 or 公司网关（WSO2）), one key,
// and the models selected under it, each with its 上下文上限. 默认模型 and 强模型
// point at a connection's model; they are set at the top of this page only.
import { useEffect, useRef, useState } from 'react';
import type { ProviderList } from '../../../shared/bridge';
import type { CatalogProviderView, ListModelsView, ModelCatalogView, WindowMatch } from '../../../shared/catalog';
import {
  emptyDraft,
  enabledModels,
  kindLabel,
  legacyModelFields,
  PROVIDER_KINDS,
  secretLabel,
  validateDraft,
  WSO2_KEY_LABEL,
  type ConnectionModel,
  type FieldErrors,
  type ModelRef,
  type ProviderDraft,
  type ProviderKind,
  type ProviderView,
  type TestResult,
} from '../../../shared/providers';
import type { PasteResult } from '../../../shared/paste-config';
import { friendlyError } from '../store/agent';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { dropDraft, keepDraft, keptDraft } from './drafts';
import { ModelPicker, type ListedModel } from './ModelPicker';
import { InfoTip } from '../ui/InfoTip';
import { PasteConfig } from './PasteConfig';
import { SpicaStatusIcon } from '@spica/brand/react';

export interface ProvidersApi {
  list(): Promise<ProviderList>;
  save(draft: ProviderDraft): Promise<ProviderList>;
  remove(id: string): Promise<ProviderList>;
  setDefault(id: string): Promise<ProviderList>;
  /** 默认模型 / 强模型; absent in older tests. */
  setPointer?(which: 'default' | 'strong', ref: ModelRef | null): Promise<ProviderList>;
  test(draft: ProviderDraft): Promise<TestResult>;
  /** The providers and models to pick from; absent: no catalog (only 中转站 and 公司网关). */
  catalog?(): Promise<ModelCatalogView | null>;
  /** 获取模型列表 for the form as it is. */
  listModels?(draft: ProviderDraft): Promise<ListModelsView>;
  /** A model name matched to the catalog, for its 上下文上限. */
  matchWindow?(kind: ProviderKind, model: string, catalogId?: string | null): Promise<WindowMatch | null>;
  /** The models changed elsewhere (a connected script); the list is read again. */
  onChanged?(listener: () => void): () => void;
}

const SHELL_KIND: Record<CatalogProviderView['kind'], ProviderKind> = { 'openai-compatible': 'openai', anthropic: 'anthropic', wso2: 'wso2' };
const GROUPS: { group: CatalogProviderView['group']; label: string }[] = [
  { group: 'company', label: '公司预置' },
  { group: 'cn', label: '国内' },
  { group: 'intl', label: '国际' },
  { group: 'local', label: '本机' },
];
/** The two choices that are not in the catalog. */
const WSO2 = '#wso2';
const RELAY = '#relay';

function draftFrom(p: ProviderView): ProviderDraft {
  const { hasSecret: _h, isDefault: _d, readOnly: _r, keyMask: _t, ...fields } = p;
  void _h;
  void _d;
  void _r;
  void _t;
  return { ...fields, models: p.models.map((m) => ({ ...m })) };
}

/** Which 服务商 a draft is: its catalog entry, 公司网关（WSO2）, 中转站, or '' before one is picked. */
function choiceOf(d: ProviderDraft, isNew: boolean): string {
  if (d.catalogId) return d.catalogId;
  if (d.kind === 'wso2') return WSO2;
  // A new draft has no model list until a 服务商 is picked.
  if (isNew && d.models === undefined) return '';
  return RELAY;
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
      <span className="field-label">
        {label}
        {hint ? <InfoTip text={hint} decorative /> : null}
      </span>
      <span className="field-control">
        <input
          className={error ? 'input is-invalid' : 'input'}
          type={type}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          {...(hint ? { 'aria-description': hint } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <span className="field-error">{error}</span> : null}
      </span>
    </label>
  );
}

// Which connection was open and what was typed into each one, kept while you look elsewhere.
const SELECTED = 'models.selected';
const draftKey = (id: string | 'new') => `models.draft:${id}`;

/** A pointer as one <select> value (connection id and model, which ids never contain a tab). */
const refKey = (r: ModelRef | null) => (r ? `${r.connectionId}\t${r.model}` : '');
const parseRefKey = (k: string): ModelRef | null => {
  const i = k.indexOf('\t');
  return i > 0 ? { connectionId: k.slice(0, i), model: k.slice(i + 1) } : null;
};

const numText = (v: number | null) => (v === null ? '' : String(v));
function parseNum(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function Models({ api }: { api: ProvidersApi }) {
  const [list, setList] = useState<ProviderList | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogView | null>(null);
  const [selected, setSelectedState] = useState<string | 'new' | null>(() => keptDraft<string>(SELECTED) ?? null);
  const [draft, setDraft] = useState<ProviderDraft>(() => {
    const sel = keptDraft<string>(SELECTED);
    return (sel ? keptDraft<ProviderDraft>(draftKey(sel)) : undefined) ?? emptyDraft();
  });
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [deleting, setDeleting] = useState<ProviderView | null>(null);
  const [fetched, setFetched] = useState<ListedModel[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [matchedNames, setMatchedNames] = useState<Record<string, string>>({});
  // The form as it is now, for answers that arrive after the user went on.
  const latest = useRef<{ draft: ProviderDraft; selected: string | 'new' | null }>({ draft, selected });

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .list()
        .then((l) => {
          if (!alive) return;
          setList(l);
          // Back on this page with a connection open: its draft if any, else what is saved.
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
    void load();
    void api
      .catalog?.()
      .then((c) => alive && setCatalog(c))
      .catch(() => undefined);
    // Changed by a connected script while this page is open: show the new list (drafts stay).
    const off = api.onChanged?.(() => {
      void api
        .list()
        .then((l) => alive && setList(l))
        .catch(() => undefined);
      void api
        .catalog?.()
        .then((c) => alive && setCatalog(c))
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
  const providers = catalog?.providers ?? [];
  const choice = choiceOf(draft, selected === 'new');
  const provider = providers.find((p) => p.id === draft.catalogId);
  const needsKey = provider ? provider.needsKey : true;

  function setSelected(id: string | 'new' | null) {
    setSelectedState(id);
    if (id === null) dropDraft(SELECTED);
    else keepDraft(SELECTED, id, null);
  }

  const savedDraft = (): ProviderDraft => (current ? draftFrom(current) : emptyDraft());

  const clearErrors = (keys: string[]) =>
    setErrors((e) => {
      if (!keys.some((k) => k in e)) return e;
      const rest = { ...e };
      for (const k of keys) delete rest[k as keyof FieldErrors];
      return rest;
    });

  /** Show `next` and keep it as the draft of the open connection; the first two models stay in step. */
  const commit = (next: ProviderDraft) => {
    const synced = { ...next, ...legacyModelFields(next.models ?? []) };
    setDraft(synced);
    latest.current = { draft: synced, selected };
    if (selected) keepDraft(draftKey(selected), synced, savedDraft());
    setResult(null);
  };

  const set = (patch: Partial<ProviderDraft>) => {
    commit({ ...draft, ...patch });
    clearErrors(Object.keys(patch));
  };

  const open = (p: ProviderView | 'new') => {
    const id = p === 'new' ? 'new' : p.id;
    const next = keptDraft<ProviderDraft>(draftKey(id)) ?? (p === 'new' ? emptyDraft() : draftFrom(p));
    setSelected(id);
    setDraft(next);
    latest.current = { draft: next, selected: id };
    setErrors({});
    setResult(null);
    setAdvanced(false);
    setFetched(null);
    setFetchError(null);
    setMatchedNames({});
  };

  /** A name not used by another connection: 「DeepSeek」, then 「DeepSeek 2」… */
  const freeName = (base: string) => {
    const taken = new Set(items.filter((p) => p.id !== draft.id).map((p) => p.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  };

  const pick = (value: string) => {
    setFetched(null);
    setFetchError(null);
    setMatchedNames({});
    const keep = { ...(draft.id ? { id: draft.id } : {}), ...(draft.secret ? { secret: draft.secret } : {}) };
    if (value === WSO2) return commit({ ...emptyDraft('wso2'), ...keep, models: [] });
    if (value === RELAY) return commit({ ...emptyDraft('openai'), ...keep, models: [] });
    const p = providers.find((x) => x.id === value);
    if (!p) return;
    const first = p.models.find((m) => m.role === 'default') ?? p.models[0];
    commit({
      ...emptyDraft(SHELL_KIND[p.kind]),
      ...keep,
      name: freeName(p.name),
      baseUrl: p.baseUrl,
      tokenUrl: p.tokenUrl ?? '',
      scope: p.scope ?? '',
      catalogId: p.id,
      maxConcurrent: p.maxConcurrent ?? null,
      requestsPerMinute: p.requestsPerMinute ?? null,
      models: first ? [{ id: first.id, contextWindow: first.contextWindow, contextFrom: 'catalog' }] : [],
    });
    clearErrors(['name', 'baseUrl', 'model', 'contextWindow']);
  };

  /** A model's 上下文上限 matched by name in the catalog, filled in unless typed by hand meanwhile. */
  const matchLater = (id: string) => {
    if (!api.matchWindow) return;
    const sel = selected;
    void api
      .matchWindow(draft.kind, id, draft.catalogId)
      .then((m) => {
        const now = latest.current;
        if (!m || now.selected !== sel) return;
        const models = now.draft.models ?? [];
        const target = models.find((x) => x.id === id);
        if (!target || target.contextWindow !== null) return;
        const contextFrom: ConnectionModel['contextFrom'] = m.how === 'exact' ? 'catalog' : 'name-match';
        if (m.how === 'name') setMatchedNames((n) => ({ ...n, [id]: m.matched }));
        const next = { ...now.draft, models: models.map((x) => (x.id === id ? { ...x, contextWindow: m.contextWindow, contextFrom } : x)) };
        const synced = { ...next, ...legacyModelFields(next.models) };
        setDraft(synced);
        latest.current = { draft: synced, selected: sel };
        if (sel) keepDraft(draftKey(sel), synced, savedDraft());
      })
      .catch(() => undefined);
  };

  const toggle = (m: ListedModel, on: boolean) => {
    const models = draft.models ?? [];
    const existing = models.find((x) => x.id === m.id);
    // Unchecking keeps the model in the list, not in use (deleting is its own action).
    if (!on) return existing ? set({ models: models.map((x) => (x.id === m.id ? { ...x, enabled: false } : x)) }) : undefined;
    if (existing) {
      const { enabled: _off, ...back } = existing;
      void _off;
      set({ models: models.map((x) => (x.id === m.id ? back : x)) });
      if (back.contextWindow === null) matchLater(m.id);
      return;
    }
    const fromCatalog = provider?.models.find((x) => x.id === m.id);
    const entry: ConnectionModel = fromCatalog
      ? { id: m.id, contextWindow: fromCatalog.contextWindow, contextFrom: 'catalog' }
      : m.contextWindow
        ? { id: m.id, contextWindow: m.contextWindow, contextFrom: 'provider' }
        : { id: m.id, contextWindow: null, contextFrom: 'user' };
    set({ models: [...models.filter((x) => x.id !== m.id), entry] });
    if (entry.contextWindow === null) matchLater(m.id);
  };

  const setWindow = (id: string, value: number | null) =>
    set({ models: (draft.models ?? []).map((x) => (x.id === id ? { ...x, contextWindow: value, contextFrom: 'user' } : x)) });

  const addTyped = (id: string) => {
    if ((draft.models ?? []).some((x) => x.id === id && x.enabled !== false)) return;
    toggle({ id }, true);
  };

  const fetchModels = async () => {
    if (!api.listModels) return;
    setFetching(true);
    setFetchError(null);
    try {
      const r = await api.listModels(draft);
      if (r.ok) setFetched(r.models.filter((m) => m.chat).map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })));
      else setFetchError(r.hint || '获取模型列表失败，请从列表选择或手动输入模型。');
    } catch (e) {
      setFetchError(friendlyError(e));
    } finally {
      setFetching(false);
    }
  };

  /** 粘贴配置: the provider it names (by address), else 公司网关 / 中转站; then the fields. */
  const applyPaste = (r: PasteResult) => {
    const base = r.fields.baseUrl;
    const host = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return '';
      }
    };
    const known = base ? providers.find((p) => p.baseUrl && host(p.baseUrl) === host(base)) : undefined;
    const kind: ProviderKind = r.kind ?? (known ? SHELL_KIND[known.kind] : draft.kind === 'wso2' ? 'wso2' : 'openai');
    const startFrom: ProviderDraft =
      kind === 'wso2' ? { ...emptyDraft('wso2'), models: [] } : known ? { ...emptyDraft(SHELL_KIND[known.kind]), name: freeName(known.name), baseUrl: known.baseUrl, catalogId: known.id, models: [] } : { ...emptyDraft(kind), models: [] };
    const { model, ...fields } = r.fields;
    const next: ProviderDraft = { ...startFrom, ...(draft.id ? { id: draft.id } : {}), ...fields };
    commit(next);
    if (model) {
      const fromCatalog = known?.models.find((x) => x.id === model);
      const entry: ConnectionModel = fromCatalog ? { id: model, contextWindow: fromCatalog.contextWindow, contextFrom: 'catalog' } : { id: model, contextWindow: null, contextFrom: 'user' };
      const withModel = { ...next, models: [entry] };
      commit(withModel);
      if (!fromCatalog) {
        latest.current = { draft: { ...withModel, ...legacyModelFields(withModel.models) }, selected };
        matchLater(model);
      }
    }
  };

  const check = (forTest = false): boolean => {
    const e = validateDraft({ ...draft, models: draft.models ?? [] }, hasSecret, { forTest, needsKey });
    setErrors(e);
    if ((e.maxConcurrent || e.requestsPerMinute || (e.baseUrl && provider)) && !advanced) setAdvanced(true);
    return Object.keys(e).length === 0;
  };

  const test = async () => {
    if (!check(true)) return;
    setBusy('test');
    try {
      const r = await api.test(draft);
      // Got through only with /v1 added: the form takes that address (saved with it); 更多选项 opens where it sits there.
      if (r.suggestedBaseUrl) {
        commit({ ...latest.current.draft, baseUrl: r.suggestedBaseUrl });
        if (provider) setAdvanced(true);
      }
      setResult(r);
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

  // Every selected model, by connection, for 默认模型 and 强模型.
  const groups = items
    .filter((p) => enabledModels(p.models).length)
    .map((p) => ({
      label: `${p.name}${p.keyMask ? ` · ${p.keyMask}` : ''}`,
      // 「名称 · 模型」 open and closed: two connections of one provider can carry the same model.
      options: enabledModels(p.models).map((m) => ({ key: refKey({ connectionId: p.id, model: m.id }), model: `${p.name} · ${m.id}` })),
    }));

  // Unsaved changes in the open connection (drafts are kept when you look elsewhere).
  const dirty = selected !== null && (selected === 'new' ? choice !== '' : Boolean(keptDraft(draftKey(selected))));
  const discard = () => {
    if (!selected) return;
    dropDraft(draftKey(selected));
    if (selected === 'new') {
      setSelected(null);
      return;
    }
    const back = savedDraft();
    setDraft(back);
    latest.current = { draft: back, selected };
    setErrors({});
    setResult(null);
    setFetched(null);
    setMatchedNames({});
  };
  // A pointer at a model this change takes out of use moves when saved (the store's rule): said before saving.
  const pointerNote = (() => {
    if (!current || !list) return '';
    const on = enabledModels(draft.models ?? []).map((m) => m.id);
    const notes: string[] = [];
    const def = list.default;
    if (def?.connectionId === current.id && !on.includes(def.model)) {
      const other = items.find((p) => p.id !== current.id && enabledModels(p.models).length);
      const to = on[0] ? `${draft.name || current.name} · ${on[0]}` : other ? `${other.name} · ${enabledModels(other.models)[0]!.id}` : '无';
      notes.push(`默认模型将改为「${to}」`);
    }
    const strong = list.strong;
    if (strong?.connectionId === current.id && !on.includes(strong.model)) notes.push(`强模型将改为「${on[0] ? `${draft.name || current.name} · ${on[0]}` : '无'}」`);
    return notes.length ? `保存后，${notes.join('，')}。` : '';
  })();
  const pointerOptions = groups.map((g) => (
    <optgroup key={g.label} label={g.label}>
      {g.options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.model}
        </option>
      ))}
    </optgroup>
  ));
  const point = async (which: 'default' | 'strong', key: string) => {
    if (!api.setPointer) return;
    try {
      setList(await api.setPointer(which, parseRefKey(key)));
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
  const isWso2 = choice === WSO2;
  const isRelay = choice === RELAY;
  const limits = (
    <div className="field-pair">
      <Field label="同时请求" type="number" value={numText(draft.maxConcurrent)} onChange={(v) => set({ maxConcurrent: parseNum(v) })} error={errors.maxConcurrent} placeholder="不限" />
      <Field label="每分钟请求" type="number" value={numText(draft.requestsPerMinute)} onChange={(v) => set({ requestsPerMinute: parseNum(v) })} error={errors.requestsPerMinute} placeholder="不限" />
    </div>
  );

  return (
    <section className="settings-section">
      {list && groups.length ? (
        <div className="model-pointers">
          <label className="model-pointer">
            <span className="field-label">默认模型</span>
            <select className="input" value={refKey(list.default ?? null)} onChange={(e) => void point('default', e.target.value)} aria-label="默认模型">
              {pointerOptions}
            </select>
          </label>
          <label className="model-pointer">
            <span className="field-label">强模型</span>
            <select className="input" value={refKey(list.strong ?? null)} onChange={(e) => void point('strong', e.target.value)} aria-label="强模型">
              <option value="">无</option>
              {pointerOptions}
            </select>
          </label>
        </div>
      ) : null}

      <div className="provider-list" role="list">
        {list && items.length === 0 ? <p className="settings-hint">未配置模型</p> : null}
        {items.map((p) => (
          <div key={p.id} role="listitem" className={selected === p.id ? 'provider-row is-on' : 'provider-row'}>
            <button type="button" className="provider-open" onClick={() => open(p)} aria-current={selected === p.id ? 'true' : undefined}>
              <span className="provider-name">
                {p.name}
                {p.keyMask ? <span className="provider-tail">{p.keyMask}</span> : null}
              </span>
              <span className="provider-sub" title={kindLabel(p.kind)}>
                {enabledModels(p.models).map((m) => m.id).join('、') || '—'}
              </span>
              {list?.problems[p.id] ? (
                <span className="provider-problem status-with-icon">
                  <SpicaStatusIcon name="error" size={14} />
                  {list.problems[p.id]}
                </span>
              ) : null}
              {!p.readOnly && enabledModels(p.models).some((m) => m.contextWindow === null) ? <span className="provider-problem status-with-icon is-warning">
                  <SpicaStatusIcon name="warning" size={14} />
                  缺少上下文上限
                </span> : null}
              {keptDraft(draftKey(p.id)) ? <span className="provider-unsaved">未保存</span> : null}
            </button>
            {p.isDefault ? <span className="provider-default">默认</span> : null}
          </div>
        ))}
        <button type="button" className={selected === 'new' ? 'provider-add is-on' : 'provider-add'} onClick={() => open('new')}>
          <Icon name="plus" size={14} />
          添加服务商
          {keptDraft(draftKey('new')) ? <span className="provider-unsaved">未保存</span> : null}
        </button>
      </div>

      {current?.readOnly ? <p className="settings-hint provider-readonly">此项来自开发配置文件，无法修改。</p> : null}

      {editing ? (
        <form
          className="provider-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field field-stack">
            <span className="field-label">服务商</span>
            <span className="field-control provider-choice">
              <select className="input" value={choice} aria-label="服务商" onChange={(e) => pick(e.target.value)}>
                {choice === '' ? (
                  <option value="" disabled>
                    选择服务商
                  </option>
                ) : null}
                {GROUPS.map((g) => {
                  const ps = providers.filter((p) => p.group === g.group);
                  return ps.length ? (
                    <optgroup key={g.group} label={g.label}>
                      {ps.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
                <optgroup label="其他">
                  <option value={WSO2}>公司网关（WSO2）</option>
                  <option value={RELAY}>中转站</option>
                </optgroup>
              </select>
              <PasteConfig key={selected ?? ''} kind={draft.kind} onApply={applyPaste} />
            </span>
          </div>

          {choice !== '' ? (
            <>
              <Field label="名称" value={draft.name} onChange={(name) => set({ name })} error={errors.name} placeholder="DeepSeek" />

              {isWso2 ? (
                <>
                  <Field label="网关地址" value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} placeholder="https://gateway.example.com/llm/v1" hint="模型接口地址，通常以 /v1 结尾，不含 /chat/completions。" />
                  <Field label="取 token 地址" value={draft.tokenUrl} onChange={(tokenUrl) => set({ tokenUrl })} error={errors.tokenUrl} placeholder="https://gateway.example.com/oauth2/token" hint="通常以 /token 或 /oauth2/token 结尾。" />
                  <Field label={WSO2_KEY_LABEL} value={draft.clientId} onChange={(clientId) => set({ clientId })} error={errors.clientId} hint="即 Client ID，位于 WSO2 开发者门户中应用的 Production Keys。" />
                </>
              ) : null}

              {isRelay ? (
                <>
                  <Field label="接口地址" value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} placeholder="https://relay.example.com/v1" />
                  <div className="field field-stack">
                    <span className="field-label">协议</span>
                    <div className="segmented" role="radiogroup" aria-label="协议">
                      {PROVIDER_KINDS.filter((k) => k.kind !== 'wso2').map((k) => (
                        <button key={k.kind} type="button" role="radio" aria-checked={draft.kind === k.kind} className={draft.kind === k.kind ? 'segment is-on' : 'segment'} onClick={() => set({ kind: k.kind })}>
                          {k.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              {needsKey ? (
                <label className="field field-stack">
                  <span className="field-label">
                    {secretLabel(draft.kind)}
                    {isWso2 ? <InfoTip text="即 Client Secret，与 Consumer Key 位于同一位置。" decorative /> : null}
                  </span>
                  <span className="field-control">
                    <input
                      className={errors.secret ? 'input is-invalid' : 'input'}
                      type="password"
                      value={draft.secret ?? ''}
                      placeholder={hasSecret ? '已保存（留空不修改）' : ''}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={errors.secret ? true : undefined}
                      {...(isWso2 ? { 'aria-description': '即 Client Secret，与 Consumer Key 位于同一位置。' } : {})}
                      onChange={(e) => set({ secret: e.target.value })}
                    />
                    {errors.secret ? <span className="field-error">{errors.secret}</span> : null}
                    {provider?.docsUrl ? (
                      <a className="field-link" href={provider.docsUrl} target="_blank" rel="noreferrer">
                        API 文档
                      </a>
                    ) : null}
                  </span>
                </label>
              ) : null}

              {isWso2 ? <Field label="Scope" value={draft.scope} onChange={(scope) => set({ scope })} hint="可选" /> : null}

              <div className="field field-stack">
                <span className="field-label">
                  模型
                  {isWso2 ? <InfoTip text="区分大小写，可包含斜杠。" label="模型名称的写法" /> : null}
                </span>
                <span className="field-control">
                  <ModelPicker
                    catalog={provider?.models ?? []}
                    fetched={fetched}
                    selected={draft.models ?? []}
                    matchedNames={matchedNames}
                    onToggle={toggle}
                    onRemove={(id) => set({ models: (draft.models ?? []).filter((x) => x.id !== id) })}
                    onWindow={setWindow}
                    onAdd={addTyped}
                    onFetch={api.listModels ? () => void fetchModels() : undefined}
                    fetching={fetching}
                    fetchError={fetchError}
                    error={errors.model ?? errors.contextWindow}
                  />
                </span>
              </div>

              <div className="provider-more">
                <button type="button" className="fold-head" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
                  <span className="fold-label">更多选项</span>
                  <Icon name="chevronRight" size={14} className="fold-chevron" />
                </button>
              </div>
              {advanced ? (
                <>
                  {provider ? (
                    <>
                      <div className="field field-stack">
                        <span className="field-label">类型</span>
                        <div className="segmented" role="radiogroup" aria-label="类型">
                          {PROVIDER_KINDS.map((k) => (
                            <button key={k.kind} type="button" role="radio" aria-checked={draft.kind === k.kind} className={draft.kind === k.kind ? 'segment is-on' : 'segment'} onClick={() => set({ kind: k.kind })}>
                              {k.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Field label="接口地址" value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} />
                    </>
                  ) : null}
                  {limits}
                </>
              ) : null}
            </>
          ) : null}

          {pointerNote ? (
            <p className="provider-pointer-note status-with-icon" role="status">
              <SpicaStatusIcon name="info" size={14} />
              {pointerNote}
            </p>
          ) : null}
          <div className="provider-actions">
            {current ? (
              <button type="button" className="btn btn-quiet-danger btn-square" onClick={() => setDeleting(current)} aria-label="删除" title="删除">
                <Icon name="trash" size={15} />
              </button>
            ) : null}
            <span className="provider-actions-gap" />
            {result ? (
              <span className={result.ok ? 'provider-result is-ok' : 'provider-result is-bad'} role="status">
                <SpicaStatusIcon name={result.ok ? 'done' : 'error'} size={15} />
                {result.message}
              </span>
            ) : null}
            {/* Saved or not, beside 保存, where the change is made. */}
            {dirty ? <span className="provider-unsaved">未保存</span> : null}
            {dirty ? (
              <button type="button" className="btn" onClick={discard} disabled={busy !== null}>
                取消
              </button>
            ) : null}
            {choice !== '' ? (
              <>
                <button type="button" className="btn" onClick={() => void test()} disabled={busy !== null}>
                  {busy === 'test' ? <span className="spinner" aria-hidden /> : null}
                  测试连接
                </button>
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                  保存
                </button>
              </>
            ) : null}
          </div>
        </form>
      ) : null}

      {deleting ? <ConfirmDialog title={`删除服务商「${deleting.name}」？`} confirmLabel="删除" danger onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} /> : null}
    </section>
  );
}
