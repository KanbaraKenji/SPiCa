// Where a form's 保存 row sits, three ways for him to pick between (TEMP: this constant goes once he has):
//   bar:    a bar at the bottom of the settings pane, apart from the content (a line above it), there however short
//           the form; 「N 项未填」 on its left.
//   head:   in the group's title row (the right end of 设置's line, or the top of the model form), staying at the
//           top while the form scrolls.
//   footer: where it is (the end of the group, staying in sight while it scrolls), drawn as a footer unlike the
//           rows above it (its own ground and a line).
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const SAVE_LAYOUT: 'bar' | 'head' | 'footer' = 'footer';

/** The 保存 row drawn for bar (on the settings pane) or footer (in place); head is placed by the form itself. */
export function SaveRow({ className, children }: { className: string; children: ReactNode }) {
  if (SAVE_LAYOUT === 'bar') {
    const pane = typeof document !== 'undefined' ? document.querySelector('.settings-main') : null;
    const row = <div className={`${className} save-bar`}>{children}</div>;
    return pane ? createPortal(row, pane) : row;
  }
  return <div className={SAVE_LAYOUT === 'footer' ? `${className} save-footer` : `${className} save-head`}>{children}</div>;
}
