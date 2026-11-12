// The one way every settings page lays out its items:
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
//
// 搜索设置 finds rows here: while the settings search, every section is rendered out of sight and each
// Row that matches (its name, its grey line, its group's title, its section's name) puts one result into
// its section's list (a portal), so there is no second list of the settings to keep in step.
import { Children, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** What a section rendered for 搜索设置 is told: the words, where its results go, how to go to one. */
export interface SettingsSearch {
  query: string;
  /** The section's own result list. */
  results: HTMLElement | null;
  /** The section's name matches: every row of it is a result. */
  sectionHit: boolean;
  /** Go to the row with this name in the section (the search is cleared). */
  jump(title: string): void;
  /** 插件: go to this plugin under 已安装. */
  jumpPlugin?(name: string): void;
}

export const SettingsSearchContext = createContext<SettingsSearch | null>(null);
const GroupTitle = createContext('');

/** The words in a piece of the page (a name with a mark beside it, a hint with a path), for matching. */
export function textOf(n: ReactNode): string {
  if (n === null || n === undefined || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement(n)) return Children.toArray((n as ReactElement<{ children?: ReactNode }>).props.children).map(textOf).join('');
  return '';
}

/** Whether these words hold the search (any case, the spaces at the ends left out). */
export function matches(query: string, ...texts: string[]): boolean {
  const q = query.trim().toLowerCase();
  return q !== '' && texts.some((t) => t.toLowerCase().includes(q));
}

/** One result of 搜索设置: where it is (group › name) and its grey line; pressing it goes there. */
export function SearchHit({ title, hint, onGo }: { title: string; hint?: string; onGo(): void }) {
  const s = useContext(SettingsSearchContext);
  if (!s?.results) return null;
  return createPortal(
    <button type="button" className="search-hit" onClick={onGo}>
      <span className="search-hit-title">{title}</span>
      {hint ? <span className="settings-hint">{hint}</span> : null}
    </button>,
    s.results,
  );
}

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
    <GroupTitle.Provider value={textOf(title)}>
    <div className={className ? `settings-group ${className}` : 'settings-group'}>
      {title || actions ? (
        <div className="group-head">
          {title ? <h3 className="settings-subheading">{title}</h3> : <span />}
          {actions ? <div className="group-actions">{actions}</div> : null}
        </div>
      ) : null}
      {/* Searching: a folded group's rows are still results. */}
      {folded ? <div hidden>{children}</div> : <div className="group-box">{children}</div>}
      {folded ? null : after}
    </div>
    </GroupTitle.Provider>
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
  const search = useContext(SettingsSearchContext);
  const group = useContext(GroupTitle);
  const cls = ['setting-row', stack ? 'is-stack' : '', className ?? ''].filter(Boolean).join(' ');
  if (search?.query) {
    const name = textOf(title);
    const grey = textOf(hint);
    if (!search.sectionHit && !matches(search.query, name, grey, group)) return null;
    return <SearchHit title={group && group !== name ? `${group} › ${name}` : name} hint={grey} onGo={() => search.jump(name)} />;
  }
  return (
    <div className={cls} data-setting={textOf(title)}>
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
