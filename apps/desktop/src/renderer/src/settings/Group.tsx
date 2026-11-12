// The one way every settings page lays out its items (他 2026-11-12 picked 「一组一个框」):
// a group title (with the group's own buttons at its right end), one rounded box, rows in it
// split by thin lines. A row: the name and a grey line under it on the left, the control on
// the right. Styles: .settings-group / .group-head / .group-box / .setting-row in styles.css.
//
// The awkward cases, decided once:
// - A long grey line wraps under the name; the control keeps its width.
// - A control too wide for the row (three segments, a field with buttons) drops under the
//   name when the window is narrow, by itself (the row wraps).
// - A field you type into (an address, rules) sits under the name, full width: `stack`.
// - A path as the name or the grey line stays on one line, cut at the end, whole on hover: `path`.
// - Something that is not a row (the skin tiles, the code previews, a list) goes in the box as
//   a <Pane>, split from the rows by the same thin line.
import type { ReactNode } from 'react';

export interface GroupProps {
  /** The group's title; none for a group the page opens with. */
  title?: ReactNode;
  /** Buttons at the right end of the title line (添加, 立即整理, 导出…). */
  actions?: ReactNode;
  /** Under the box: a status line or a problem that belongs to the whole group. */
  after?: ReactNode;
  className?: string;
  /** Folded: only the title line shows (its title is then the fold button, see 市场 › 插件来源). */
  folded?: boolean;
  children: ReactNode;
}

export function Group({ title, actions, after, className, folded, children }: GroupProps) {
  return (
    <div className={className ? `settings-group ${className}` : 'settings-group'}>
      {title || actions ? (
        <div className="group-head">
          {title ? <h3 className="settings-subheading">{title}</h3> : <span />}
          {actions ? <div className="group-actions">{actions}</div> : null}
        </div>
      ) : null}
      {folded ? null : <div className="group-box">{children}</div>}
      {folded ? null : after}
    </div>
  );
}

export interface RowProps {
  title: ReactNode;
  /** The grey line under the name. */
  hint?: ReactNode;
  /** The switch, buttons, segments or field. */
  children?: ReactNode;
  /** The control under the name, full width (fields you type into). */
  stack?: boolean;
  /** The name / grey line is a path: one line, cut at the end, whole on hover. */
  path?: { title?: string; hint?: string };
  className?: string;
}

export function Row({ title, hint, children, stack, path, className }: RowProps) {
  const cls = ['setting-row', stack ? 'is-stack' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className="setting-text">
        {path?.title !== undefined ? (
          <span className="setting-title path-text" title={path.title} data-tip-clipped="">
            {title}
          </span>
        ) : (
          <span className="setting-title">{title}</span>
        )}
        {hint === undefined || hint === null || hint === '' ? null : path?.hint !== undefined ? (
          <span className="settings-hint path-text" title={path.hint} data-tip-clipped="">
            {hint}
          </span>
        ) : (
          <span className="settings-hint">{hint}</span>
        )}
      </div>
      {children ? <div className="setting-control">{children}</div> : null}
    </div>
  );
}

/** A block in a group's box that is not a name-and-control row. */
export function Pane({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className ? `group-pane ${className}` : 'group-pane'}>{children}</div>;
}
