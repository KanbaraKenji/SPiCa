// Where a form's 保存 row sits (he picked it from three): a bar at the bottom of the settings pane, apart from the
// content by a line, there however short the form; 「N 项未填」 on its left. The plugin settings form and the model
// form both use it. Outside the settings pane (tests) it stays in place.
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function SaveRow({ className, children }: { className: string; children: ReactNode }) {
  const pane = typeof document !== 'undefined' ? document.querySelector('.settings-main') : null;
  const row = <div className={`${className} save-bar`}>{children}</div>;
  return pane ? createPortal(row, pane) : row;
}
