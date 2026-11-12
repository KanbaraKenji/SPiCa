// The models of one connection: the catalog's list for the provider, what
// 获取模型列表 returned, and any typed in. In use (已启用) on top, one row each
// with its 上下文上限; the rest (未启用) folded into a line of small buttons
// that turn one on, with 获取模型列表 and 手动输入模型 at its end.
import { useState } from 'react';
import type { CatalogModelView, CatalogPriceView } from '../../../shared/catalog';
import type { ConnectionModel } from '../../../shared/providers';
import { Icon } from '../ui/Icon';
import { InfoTip } from '../ui/InfoTip';
import { SpicaStatusIcon } from '@spica/brand/react';
import { ImageMark } from '../ui/ImageMark';

export interface ListedModel {
  id: string;
  label?: string;
  contextWindow?: number;
  /** Most output tokens, when the provider's model list says it (kept with the model, used for each answer). */
  maxOutput?: number;
}

export interface ModelPickerProps {
  /** The catalog's models for this provider (none for 中转站 / 公司网关). */
  catalog: readonly CatalogModelView[];
  /** What 获取模型列表 returned (chat models only), or null before asking. */
  fetched: readonly ListedModel[] | null;
  selected: readonly ConnectionModel[];
  /** The catalog model a name was matched to (for 按名称匹配's title). */
  matchedNames: Record<string, string>;
  /** Checked: in use; unchecked: kept in the list, not in use. */
  onToggle(model: ListedModel, on: boolean): void;
  /** Takes a model out of the list (fetched or typed ones; the catalog's always come back). */
  onRemove?: (id: string) => void;
  onWindow(id: string, value: number | null): void;
  onAdd(id: string): void;
  onFetch?: (() => void) | undefined;
  fetching: boolean;
  fetchError: string | null;
  /** What the last fetch found (「已获取 N 个模型，新增 M 个」), shown beside the button. */
  fetchNote?: string | null;
  error?: string | undefined;
}

const SOURCE: Record<ConnectionModel['contextFrom'], string> = { user: '', catalog: '来自目录', provider: '服务商提供', 'name-match': '按名称匹配' };

/** Official list price per million tokens, in its own currency. */
export function priceText(p: CatalogPriceView): string {
  const c = p.currency === 'CNY' ? '¥' : '$';
  return `输入 ${c}${p.input} / 输出 ${c}${p.output}（每百万 token）`;
}

/** A context window in short: the same abbreviation as the ring and the context card (chat/tokens). */
export { tokenText as windowText } from '../chat/tokens';
import { tokenText as windowText } from '../chat/tokens';

function parseWindow(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function ModelPicker({ catalog, fetched, selected, matchedNames, onToggle, onRemove, onWindow, onAdd, onFetch, fetching, fetchError, fetchNote, error }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [typing, setTyping] = useState(false);
  // The 上下文上限 being edited (a known one shows as 「128k」 until clicked).
  const [editing, setEditing] = useState<string | null>(null);
  const byId = new Map<string, { model: ListedModel; price?: CatalogPriceView; vision?: boolean }>();
  for (const m of catalog) byId.set(m.id, { model: { id: m.id, ...(m.label ? { label: m.label } : {}), contextWindow: m.contextWindow }, ...(m.price ? { price: m.price } : {}), ...(m.vision !== undefined ? { vision: m.vision } : {}) });
  // fetched: a model the catalog has too keeps the catalog's row, with the most output the provider's list gives
  for (const m of fetched ?? []) {
    const known = byId.get(m.id);
    if (!known) byId.set(m.id, { model: m });
    else if (m.maxOutput) known.model = { ...known.model, maxOutput: m.maxOutput };
  }
  for (const m of selected) if (!byId.has(m.id)) byId.set(m.id, { model: { id: m.id } });
  const all = [...byId.values()];
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((r) => r.model.id.toLowerCase().includes(q) || r.model.label?.toLowerCase().includes(q)) : all;
  // In the list and in use (unchecked ones stay in the list).
  const isOn = (id: string) => selected.find((m) => m.id === id && m.enabled !== false);
  const inList = (id: string) => selected.some((m) => m.id === id);
  const fromCatalog = new Set(catalog.map((m) => m.id));
  const removable = (id: string) => Boolean(onRemove) && inList(id) && !fromCatalog.has(id);
  const onRows = shown.filter((r) => isOn(r.model.id));
  const offRows = shown.filter((r) => !isOn(r.model.id));
  const name = (m: ListedModel) => (m.label ? `${m.label} · ${m.id}` : m.id);

  const add = () => {
    const id = typed.trim();
    if (!id) return;
    onAdd(id);
    setTyped('');
    setTyping(false);
  };

  return (
    <div className="model-picker">
      {all.length > 10 ? <input className="input model-picker-search" value={query} placeholder="搜索模型" aria-label="搜索模型" onChange={(e) => setQuery(e.target.value)} /> : null}
      {fetchError ? <p className="field-error model-picker-note">{fetchError}</p> : null}
      <span className="model-picker-sect">已启用</span>
      <ul className="model-picker-list">
        {onRows.map(({ model, price, vision }) => {
          const on = isOn(model.id)!;
          const source = SOURCE[on.contextFrom];
          const matched = on.contextFrom === 'name-match' ? matchedNames[model.id] : undefined;
          const missing = on.contextWindow === null || Number.isNaN(on.contextWindow);
          const edit = missing || editing === model.id;
          return (
            <li key={model.id} className="model-row">
              <label className="model-row-name">
                <input type="checkbox" checked onChange={() => onToggle(model, false)} />
                <span className="model-row-id">{name(model)}</span>
                {vision ? <ImageMark /> : null}
              </label>
              {price ? <InfoTip text={priceText(price)} label={`${model.id} 官方价`} /> : null}
              {edit ? (
                <span className="model-row-window">
                  {on.contextWindow === null ? (
                    <span className="model-row-warn">
                      <SpicaStatusIcon name="warning" size={13} />
                      缺少上下文上限
                    </span>
                  ) : null}
                  <input
                    className={missing ? 'input is-invalid' : 'input'}
                    type="number"
                    value={on.contextWindow === null || Number.isNaN(on.contextWindow) ? '' : String(on.contextWindow)}
                    placeholder="上下文上限"
                    aria-label={`${model.id} 上下文上限`}
                    title="上下文上限（token）"
                    autoFocus={editing === model.id}
                    onChange={(e) => onWindow(model.id, parseWindow(e.target.value))}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setEditing(null);
                    }}
                  />
                </span>
              ) : (
                <button
                  type="button"
                  className="model-row-size"
                  aria-label={`${model.id} 上下文上限`}
                  title={`上下文上限 ${on.contextWindow!.toLocaleString('en-US')} token${source ? `（${source}${matched ? `：${matched}` : ''}）` : ''}`}
                  onClick={() => setEditing(model.id)}
                >
                  {windowText(on.contextWindow!)}
                </button>
              )}
              {removable(model.id) ? (
                <button type="button" className="icon-btn model-row-remove" onClick={() => onRemove!(model.id)} aria-label={`删除 ${model.id}`} title="删除">
                  <Icon name="trash" size={14} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <span className="model-picker-sect">未启用</span>
      <div className="model-pills">
        {offRows.map(({ model, price, vision }) => (
          <span key={model.id} className="model-pill">
            <button type="button" className="model-pill-on" onClick={() => onToggle(model, true)} aria-label={`启用 ${model.id}`} title={price ? `启用 · ${priceText(price)}` : '启用'}>
              <span className="model-pill-text">{name(model)}</span>
              {vision ? <ImageMark size={12} /> : null}
              <Icon name="plus" size={12} />
            </button>
            {removable(model.id) ? (
              <button type="button" className="model-pill-remove" onClick={() => onRemove!(model.id)} aria-label={`删除 ${model.id}`} title="删除">
                <Icon name="trash" size={12} />
              </button>
            ) : null}
          </span>
        ))}
        {onFetch ? (
          <button type="button" className="model-pill is-action" disabled={fetching} onClick={onFetch}>
            {fetching ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={12} />}
            获取模型列表
          </button>
        ) : null}
        {typing ? (
          <span className="model-pill-add">
            <input
              className="input"
              value={typed}
              placeholder="模型名称"
              aria-label="手动输入模型"
              spellCheck={false}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => {
                if (!typed.trim()) setTyping(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                } else if (e.key === 'Escape') {
                  setTyped('');
                  setTyping(false);
                }
              }}
            />
            <button type="button" className="btn btn-small" disabled={!typed.trim()} onClick={add}>
              添加
            </button>
          </span>
        ) : (
          <button type="button" className="model-pill is-action" onClick={() => setTyping(true)}>
            <Icon name="plus" size={12} />
            手动输入模型
          </button>
        )}
        {onFetch && fetchNote ? (
          <span className="provider-result is-ok" role="status">
            <SpicaStatusIcon name="done" size={15} />
            {fetchNote}
          </span>
        ) : null}
      </div>
      {error ? <p className="field-error model-picker-note">{error}</p> : null}
    </div>
  );
}
