// Web addresses clicked anywhere in the app window (an answer's links, a setting's help link): where they open.
// 设置 › 常规 › 浏览器 › 打开网址 decides: 每次询问 (default) asks with the shared choice question — 应用内 (the right panel) or 系统浏览器,
// and 记住我的选择, which sets that setting — 应用内 opens a tab in the right panel, 系统浏览器 hands it to Windows.
// Ctrl+click always goes to the system's browser. A right click on a link offers both, whatever the setting.
// Pages inside the built-in browser are other documents: their links never come here.
import { useEffect, useState } from 'react';
import type { LinkOpen } from '../../../shared/settings';
import { ChoiceDialog } from '../ui/ChoiceDialog';
import { ContextMenu } from '../ui/ContextMenu';
import { t } from '../../../shared/i18n';

/** The web address a click or right click landed on (an <a> with an http/https address), or null. */
export function linkAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const a = target.closest('a[href]');
  if (!(a instanceof HTMLAnchorElement)) return null;
  return /^https?:\/\//i.test(a.href) ? a.href : null;
}

export type LinkPlace = Exclude<LinkOpen, 'ask'>;

/** Where a plain click goes: the setting, or the system's browser with Ctrl (⌘) or Shift held; null: ask. */
export function placeFor(setting: LinkOpen, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): LinkPlace | null {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return 'system';
  return setting === 'ask' ? null : setting;
}

export interface LinkRouterProps {
  setting: LinkOpen;
  open(url: string, place: LinkPlace): void;
  /** 记住我的选择 ticked: the answer becomes the setting. */
  remember(place: LinkPlace): void;
  /** Addresses that come from elsewhere (a local page going to the web): routed as a plain click is. */
  incoming?: (listener: (url: string) => void) => () => void;
}

/** Mounted once in the app: takes link clicks and right clicks, and asks when the setting says to. */
export function LinkRouter({ setting, open, remember, incoming }: LinkRouterProps) {
  const [asking, setAsking] = useState<{ n: number; url: string } | null>(null);
  const [menu, setMenu] = useState<{ n: number; x: number; y: number; url: string } | null>(null);
  useEffect(() => {
    if (!incoming) return;
    return incoming((url) => {
      if (!/^https?:\/\//i.test(url)) return;
      const place = placeFor(setting, { ctrlKey: false, metaKey: false, shiftKey: false });
      if (place) open(url, place);
      else setAsking((a) => ({ n: (a?.n ?? 0) + 1, url }));
    });
  }, [incoming, setting, open]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const url = linkAt(e.target);
      if (!url) return;
      e.preventDefault();
      const place = placeFor(setting, e);
      if (place) open(url, place);
      else setAsking((a) => ({ n: (a?.n ?? 0) + 1, url }));
    };
    // Before the words menu (ui/TextMenu.tsx), which leaves a right click someone has taken.
    const onMenu = (e: MouseEvent) => {
      const url = linkAt(e.target);
      if (!url) return;
      e.preventDefault();
      setMenu((m) => ({ n: (m?.n ?? 0) + 1, x: e.clientX, y: e.clientY, url }));
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onMenu, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('contextmenu', onMenu, true);
    };
  }, [setting, open]);
  return (
    <>
      {asking ? (
        <ChoiceDialog<LinkPlace>
          key={asking.n}
          title={t('在哪里打开网址？')}
          detail={asking.url}
          choices={[
            ['panel', t('应用内')],
            ['system', t('系统浏览器')],
          ]}
          rememberLabel={t('记住我的选择')}
          onAnswer={({ choice, remember: keep }) => {
            const url = asking.url;
            setAsking(null);
            if (!choice) return;
            if (keep) remember(choice);
            open(url, choice);
          }}
        />
      ) : null}
      {menu ? (
        <div className="text-menu-layer">
          <ContextMenu
            key={menu.n}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              { label: t('在应用内打开'), onSelect: () => open(menu.url, 'panel') },
              { label: t('用系统浏览器打开'), onSelect: () => open(menu.url, 'system') },
            ]}
          />
        </div>
      ) : null}
    </>
  );
}
