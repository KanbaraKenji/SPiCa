// The sidebar's open / close button (Ctrl+B). Collapsed, the lists (对话, 项目)
// are not on the icon column, so what is new in them shows as a dot here.
import { Icon } from '../ui/Icon';
import { NewDot } from '../ui/NewDot';

export function SidebarToggle({ shown, news, onToggle }: { shown: boolean; news: string; onToggle(): void }) {
  return (
    <button type="button" data-panel-toggle className={shown ? 'icon-btn is-on' : 'icon-btn'} onClick={onToggle} aria-label={shown ? '收起侧栏' : '展开侧栏'} aria-pressed={shown} title="侧栏（Ctrl+B）">
      <Icon name="sidebar" />
      {!shown && news ? <NewDot text={news} /> : null}
    </button>
  );
}
