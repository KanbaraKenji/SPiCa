// The card that opens from the context ring: what the conversation's context
// is made of. Header: 实测 / 预估 and how full it is; a bar of the parts; the
// rows below when opened (「>」 closed, down when open), each part that has
// parts of its own opens the same way. Kept free for the answer and what is
// left come last, in grey.
import { useState } from 'react';
import type { ContextBreakdown } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { tokenText } from './tokens';

const NAMES: Record<string, string> = {
  system: '系统提示',
  'system.base': '角色提示',
  'system.rules': '规则',
  tools: '工具',
  messages: '对话',
  'messages.user': '你的消息',
  'messages.assistant': '回答',
  'messages.tool_results': '工具结果',
  'messages.notes': '备注',
  'messages.images': '图片',
};

/** One decimal of the window: 「17.6%」. */
export function shareText(tokens: number, window: number): string {
  return `${((tokens / window) * 100).toFixed(1)}%`;
}

/** The colour of a part: its category's colour, a step lighter for each part after the first. */
const swatch = (category: string, step = 0) => ({ ['--ctx-c' as string]: `var(--ctx-${category})`, ['--ctx-k' as string]: `${100 - step * 16}%` });

// Opened or closed stays as it was left, for the next time the card opens.
let openBefore = false;
const rowsOpenBefore = new Set<string>();

export function ContextCard({ data }: { data: ContextBreakdown }) {
  const [open, setOpen] = useState(openBefore);
  const [rowsOpen, setRowsOpen] = useState<Set<string>>(() => new Set(rowsOpenBefore));
  const w = data.window;
  const parts = data.parts.filter((p) => p.tokens > 0);
  const toggle = () => {
    openBefore = !open;
    setOpen(!open);
  };
  const toggleRow = (key: string) => {
    if (rowsOpenBefore.has(key)) rowsOpenBefore.delete(key);
    else rowsOpenBefore.add(key);
    setRowsOpen(new Set(rowsOpenBefore));
  };
  // Without a window the bar is the parts against each other.
  const scale = w ?? data.total;
  const segments = parts.flatMap((p) => {
    const kids = (p.children ?? []).filter((c) => c.tokens > 0);
    return kids.length ? kids.map((c, i) => ({ key: c.key, tokens: c.tokens, style: swatch(p.key, i) })) : [{ key: p.key, tokens: p.tokens, style: swatch(p.key) }];
  });
  const num = (n: number) => (
    <>
      <span className="ctx-n">{tokenText(n)}</span>
      {w ? <span className="ctx-p">{shareText(n, w)}</span> : null}
    </>
  );
  return (
    <div className="ctx-card" role="dialog" aria-label="上下文占用">
      <button type="button" className="ctx-head" aria-expanded={open} onClick={toggle}>
        <span className="ctx-title">上下文占用</span>
        <span className="ctx-sum">
          <span className="ctx-tag">{data.measured ? '实测' : '预估'}</span>
          {w ? `${tokenText(data.total)} / ${tokenText(w)} (${shareText(data.total, w)})` : tokenText(data.total)}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </span>
      </button>
      <div className="ctx-bar" aria-hidden>
        {segments.map((s) => (
          <span key={s.key} className="ctx-seg" style={{ ...s.style, width: `${(s.tokens / scale) * 100}%` }} />
        ))}
        {w && data.outputReserve ? <span className="ctx-seg ctx-reserve" style={{ width: `${(data.outputReserve / w) * 100}%` }} /> : null}
      </div>
      {open ? (
        <div className="ctx-rows" role="list">
          {parts.map((p) => {
            const kids = (p.children ?? []).filter((c) => c.tokens > 0);
            const rowOpen = rowsOpen.has(p.key);
            return (
              <div key={p.key} role="listitem">
                {kids.length ? (
                  <button type="button" className="ctx-row" aria-expanded={rowOpen} onClick={() => toggleRow(p.key)}>
                    <span className="ctx-name">
                      <span className="ctx-sw" style={swatch(p.key)} />
                      {NAMES[p.key] ?? p.key}
                      <Icon name={rowOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                    </span>
                    {num(p.tokens)}
                  </button>
                ) : (
                  <div className="ctx-row">
                    <span className="ctx-name">
                      <span className="ctx-sw" style={swatch(p.key)} />
                      {NAMES[p.key] ?? p.key}
                    </span>
                    {num(p.tokens)}
                  </div>
                )}
                {rowOpen
                  ? kids.map((c, i) => (
                      <div key={c.key} className="ctx-row is-child">
                        <span className="ctx-name">
                          <span className="ctx-sw" style={swatch(p.key, i)} />
                          {NAMES[c.key] ?? c.key}
                        </span>
                        {num(c.tokens)}
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
          {w ? (
            <>
              <div className="ctx-row is-dim" role="listitem">
                <span className="ctx-name">
                  <span className="ctx-sw ctx-reserve" />
                  输出预留
                </span>
                {num(data.outputReserve)}
              </div>
              {data.free !== null ? (
                <div className="ctx-row is-dim" role="listitem">
                  <span className="ctx-name">
                    <span className="ctx-sw ctx-free" />
                    空余
                  </span>
                  {num(data.free)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
