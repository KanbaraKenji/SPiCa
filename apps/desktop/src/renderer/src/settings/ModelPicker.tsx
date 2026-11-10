// The models of one connection: the catalog's list for the provider, what
// 获取模型列表 returned, and any typed in; the selected ones each carry their
// own 上下文上限 and a short tag saying where it came from.
import { useState } from 'react';
import type { CatalogModelView, CatalogPriceView } from '../../../shared/catalog';
import type { ConnectionModel } from '../../../shared/providers';

export interface ListedModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

export interface ModelPickerProps {
  /** The catalog's models for this provider (none for 中转站 / 公司网关). */
  catalog: readonly CatalogModelView[];
  /** What 获取模型列表 returned (chat models only), or null before asking. */
  fetched: readonly ListedModel[] | null;
  selected: readonly ConnectionModel[];
  /** The catalog model a name was matched to (for 按名称匹配's title). */
  matchedNames: Record<string, string>;
  onToggle(model: ListedModel, on: boolean): void;
  onWindow(id: string, value: number | null): void;
  onAdd(id: string): void;
  onFetch?: (() => void) | undefined;
  fetching: boolean;
  fetchError: string | null;
  error?: string | undefined;
}

const SOURCE: Record<ConnectionModel['contextFrom'], string> = { user: '', catalog: '来自目录', provider: '服务商提供', 'name-match': '按名称匹配' };

/** Official list price per million tokens, in its own currency. */
export function priceText(p: CatalogPriceView): string {
  const c = p.currency === 'CNY' ? '¥' : '$';
  return `输入 ${c}${p.input} / 输出 ${c}${p.output}（每百万 token）`;
}

function parseWindow(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function ModelPicker({ catalog, fetched, selected, matchedNames, onToggle, onWindow, onAdd, onFetch, fetching, fetchError, error }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const byId = new Map<string, { model: ListedModel; price?: CatalogPriceView }>();
  for (const m of catalog) byId.set(m.id, { model: { id: m.id, ...(m.label ? { label: m.label } : {}), contextWindow: m.contextWindow }, ...(m.price ? { price: m.price } : {}) });
  for (const m of fetched ?? []) if (!byId.has(m.id)) byId.set(m.id, { model: m });
  for (const m of selected) if (!byId.has(m.id)) byId.set(m.id, { model: { id: m.id } });
  const all = [...byId.values()];
  const q = query.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.model.id.toLowerCase().includes(q) || r.model.label?.toLowerCase().includes(q)) : all;
  const isOn = (id: string) => selected.find((m) => m.id === id);

  const add = () => {
    const id = typed.trim();
    if (!id) return;
    onAdd(id);
    setTyped('');
  };

  return (
    <div className="model-picker">
      <div className="model-picker-head">
        {all.length > 10 ? <input className="input model-picker-search" value={query} placeholder="搜索模型" aria-label="搜索模型" onChange={(e) => setQuery(e.target.value)} /> : <span className="model-picker-gap" />}
        {onFetch ? (
          <button type="button" className="btn btn-small" disabled={fetching} onClick={onFetch}>
            {fetching ? <span className="spinner" aria-hidden /> : null}
            获取模型列表
          </button>
        ) : null}
      </div>
      {fetchError ? <p className="field-error model-picker-note">{fetchError}</p> : null}
      <ul className="model-picker-list">
        {rows.map(({ model, price }) => {
          const on = isOn(model.id);
          const source = on ? SOURCE[on.contextFrom] : '';
          return (
            <li key={model.id} className={on ? 'model-row is-on' : 'model-row'}>
              <label className="model-row-name">
                <input type="checkbox" checked={Boolean(on)} onChange={(e) => onToggle(model, e.target.checked)} />
                <span className="model-row-text">
                  <span className="model-row-id">{model.label ? `${model.label} · ${model.id}` : model.id}</span>
                  {price ? <span className="model-row-meta">{priceText(price)}</span> : null}
                </span>
              </label>
              {on ? (
                <span className="model-row-window">
                  <span className="model-row-label">上下文上限</span>
                  <input
                    className={on.contextWindow === null ? 'input is-invalid' : 'input'}
                    type="number"
                    value={on.contextWindow === null ? '' : String(on.contextWindow)}
                    placeholder="128000"
                    aria-label={`${model.id} 上下文上限`}
                    onChange={(e) => onWindow(model.id, parseWindow(e.target.value))}
                  />
                  <span className="model-row-unit">token</span>
                  {source ? (
                    <span className="model-row-tag" title={on.contextFrom === 'name-match' && matchedNames[model.id] ? matchedNames[model.id] : undefined}>
                      {source}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="model-picker-add">
        <input
          className="input"
          value={typed}
          placeholder="手动输入模型"
          aria-label="手动输入模型"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn-small" disabled={!typed.trim()} onClick={add}>
          添加
        </button>
      </div>
      {error ? <p className="field-error model-picker-note">{error}</p> : null}
    </div>
  );
}
