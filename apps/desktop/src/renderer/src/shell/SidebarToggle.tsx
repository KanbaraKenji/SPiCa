// The sidebar's open / close button (Ctrl+B), and the rows it sits in.
import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';

export function SidebarToggle({ shown, onToggle }: { shown: boolean; onToggle(): void }) {
  return (
    <button type="button" data-panel-toggle className={shown ? 'icon-btn is-on' : 'icon-btn'} onClick={onToggle} aria-label={shown ? '收起侧栏' : '展开侧栏'} aria-pressed={shown} title="侧栏（Ctrl+B）">
      <Icon name="sidebar" />
    </button>
  );
}

/** The sidebar's top row. Slid out by resting on the icon column (not opened on purpose): only the
 *  toggle, where the column has it, and no brand. Opened with the toggle: the brand, then the toggle at the end. */
export function SidebarHead({ peek, toggle, brand }: { peek: boolean; toggle: ReactNode; brand: ReactNode }) {
  return peek ? (
    <div className="sidebar-head is-over-rail">{toggle}</div>
  ) : (
    <div className="sidebar-head">
      {brand}
      {toggle}
    </div>
  );
}

/** The top of the icon column: the toggle. Resting the pointer on the toggle (nowhere else on the column) is what slides the sidebar out. */
export function RailHead({ toggle, onRest, onLeave }: { toggle: ReactNode; onRest(): void; onLeave(): void }) {
  return (
    <div className="rail-head">
      <span className="rail-toggle" onMouseOver={onRest} onMouseLeave={onLeave}>
        {toggle}
      </span>
    </div>
  );
}
