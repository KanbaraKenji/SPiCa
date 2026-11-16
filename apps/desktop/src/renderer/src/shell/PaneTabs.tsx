// The right panel's tab row (the preview's place): files and web pages side by side, + for an empty page, and the
// panel's own 最大化 and 关闭 at the end. Each tab closes with its own ×.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';
import { MaxButton, type MaxState } from '../ui/MaxButton';
import { t } from '../../../shared/i18n';
import { tabName, type PaneTab } from './pane-tabs';

export interface PaneTabsProps {
  tabs: PaneTab[];
  active: string | null;
  onPick(id: string): void;
  onClose(id: string): void;
  /** + : an empty page to type an address in. */
  onNew(): void;
  max?: MaxState;
  /** Closes the panel (its tabs stay; the title bar's button opens it again). */
  onClosePanel(): void;
}

function TabIcon({ tab }: { tab: PaneTab }): ReactNode {
  if (tab.kind === 'file') return <FileGlyph name={tabName(tab)} />;
  return <Icon name="link" size={13} />;
}

export function PaneTabs({ tabs, active, onPick, onClose, onNew, max, onClosePanel }: PaneTabsProps) {
  // More tabs than fit: they keep a readable width and the row scrolls sideways (the wheel too); the tab shown is
  // brought into view whenever it changes. + stays outside the scrolling part, always there.
  const list = useRef<HTMLDivElement>(null);
  // Which ends hide tabs: that end fades out, so it shows there are more.
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  };
  useEffect(() => {
    list.current?.querySelector('.pane-tab.is-on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [active, tabs.length]);
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <header className="panel-head pane-tabs">
      <div
        ref={list}
        className={`pane-tab-list${more.left ? ' is-more-left' : ''}${more.right ? ' is-more-right' : ''}`}
        onScroll={measure}
        role="tablist"
        aria-label={t('预览')}
        onWheel={(e) => {
          if (e.deltaY && !e.deltaX && list.current) list.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const name = tabName(tab);
          const on = tab.id === active;
          const shown = name || t('新标签页');
          return (
            <div key={tab.id} className={on ? 'pane-tab is-on' : 'pane-tab'}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="pane-tab-main"
                onClick={() => onPick(tab.id)}
                // middle click closes, as in a browser
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(tab.id);
                }}
                title={tab.kind === 'file' ? tab.req.path || shown : tab.url || shown}
              >
                <TabIcon tab={tab} />
                <span className="pane-tab-name">{shown}</span>
              </button>
              <button type="button" className="pane-tab-close" onClick={() => onClose(tab.id)} aria-label={t('关闭 {name}', { name: shown })} title={t('关闭')}>
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-btn pane-tab-new" onClick={onNew} aria-label={t('新标签页')} title={t('新标签页')}>
        <Icon name="plus" size={14} />
      </button>
      <span className="pane-tabs-gap" />
      {max ? <MaxButton max={max} /> : null}
      <button type="button" className="icon-btn" onClick={onClosePanel} aria-label={t('关闭预览')} title={t('关闭预览')}>
        <Icon name="close" size={14} />
      </button>
    </header>
  );
}
