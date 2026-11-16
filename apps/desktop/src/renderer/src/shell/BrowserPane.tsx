// Web pages in the right panel: a <webview> per page (its own process and storage; the main process locks every one,
// main/browser/session.ts), all kept while the panel is open so a page stays as it was when another tab is shown.
// Above the page shown: 后退, 前进, 刷新, its address (type another and press Enter), 用系统浏览器打开.
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Icon } from '../ui/Icon';
import { t } from '../../../shared/i18n';
import { addressOf, type PaneTab } from './pane-tabs';

type WebTab = Extract<PaneTab, { kind: 'web' }>;

/** The allowpopups attribute as a string: React drops a boolean true on an attribute it does not know. */
const POPUPS = { allowpopups: 'true' } as object;

/** The parts of Electron's <webview> element used here. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

export interface BrowserPaneProps {
  /** Every web tab of the panel. */
  tabs: WebTab[];
  /** The web tab shown; null: a file is shown (the pages stay, out of sight). */
  active: string | null;
  /** The tab row, above the address row (only while a page is shown). */
  strip?: ReactNode;
  /** A page went somewhere or got its title. */
  onChange(id: string, patch: { url?: string; title?: string }): void;
  onOpenExternal(url: string): void;
}

interface PageState {
  back: boolean;
  forward: boolean;
  loading: boolean;
}

/** One page: mounted once with its first address, then driven through the element (a new src would reload it). */
function Page({ tab, shown, onChange, onState, register }: { tab: WebTab; shown: boolean; onChange: BrowserPaneProps['onChange']; onState(s: PageState): void; register(el: WebviewElement | null): void }) {
  const ref = useRef<WebviewElement | null>(null);
  const [first] = useState(tab.url || 'about:blank');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    register(el);
    let ready = false;
    const state = (loading: boolean) => {
      if (ready) onState({ back: el.canGoBack(), forward: el.canGoForward(), loading });
    };
    const onReady = () => {
      ready = true;
      state(false);
    };
    const onNav = (e: Event) => {
      const url = (e as Event & { url: string; isMainFrame?: boolean }).url;
      if ((e as { isMainFrame?: boolean }).isMainFrame === false) return;
      onChange(tab.id, { url: url === 'about:blank' ? '' : url });
      state(false);
    };
    const onTitle = (e: Event) => onChange(tab.id, { title: (e as Event & { title: string }).title });
    const onStart = () => state(true);
    const onStop = () => state(false);
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    return () => {
      register(null);
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
    };
    // the element lives as long as the tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  // Out of sight, not display:none (a hidden <webview> loses its size and does not paint when shown again).
  // allowpopups: a page's new windows reach the main process's window-open handler, which opens a tab instead of a
  // window (main/browser/session.ts); without it they are dropped before that.
  return <webview ref={ref as unknown as Ref<HTMLWebViewElement>} src={first} {...POPUPS} className={shown ? 'browser-page' : 'browser-page is-hidden'} data-tab={tab.id} />;
}

export function BrowserPane({ tabs, active, strip, onChange, onOpenExternal }: BrowserPaneProps) {
  const pages = useRef(new Map<string, WebviewElement>());
  const [states, setStates] = useState<Record<string, PageState>>({});
  const tab = tabs.find((x) => x.id === active);
  const [typed, setTyped] = useState<{ id: string; text: string } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const page = () => (tab ? pages.current.get(tab.id) : undefined);
  const st = tab ? states[tab.id] : undefined;
  // An empty page: the address box ready to type in.
  useEffect(() => {
    if (tab && !tab.url) input.current?.focus();
  }, [tab?.id, tab?.url, tab]);
  const go = () => {
    const url = addressOf(typed?.text ?? '');
    if (!url) return;
    setTyped(null);
    void page()?.loadURL(url).catch(() => undefined);
  };
  const address = typed && tab && typed.id === tab.id ? typed.text : (tab?.url ?? '');
  return (
    <section className={tab ? 'preview browser' : 'preview browser is-hidden'} aria-label={tab ? t('网页') : undefined} aria-hidden={tab ? undefined : true}>
      {tab ? strip : null}
      {tab ? (
        <header className="panel-head browser-bar">
          <button type="button" className="icon-btn" disabled={!st?.back} onClick={() => page()?.goBack()} aria-label={t('后退')} title={t('后退')}>
            <Icon name="arrowLeft" size={15} />
          </button>
          <button type="button" className="icon-btn" disabled={!st?.forward} onClick={() => page()?.goForward()} aria-label={t('前进')} title={t('前进')}>
            <Icon name="arrowRight" size={15} />
          </button>
          <button type="button" className="icon-btn" disabled={!tab.url} onClick={() => page()?.reload()} aria-label={t('刷新')} title={t('刷新')}>
            <Icon name="refresh" size={15} />
          </button>
          <form
            className="browser-address-form"
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
          >
            <input
              ref={input}
              className="input browser-address"
              value={address}
              spellCheck={false}
              aria-label={t('地址')}
              placeholder={t('输入网址')}
              onChange={(e) => setTyped({ id: tab.id, text: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && typed) {
                  e.stopPropagation();
                  setTyped(null);
                }
              }}
            />
          </form>
          <button type="button" className="icon-btn" disabled={!tab.url} onClick={() => tab.url && onOpenExternal(tab.url)} aria-label={t('用系统浏览器打开')} title={t('用系统浏览器打开')}>
            <Icon name="external" size={15} />
          </button>
        </header>
      ) : null}
      <div className="browser-pages">
        {tabs.map((x) => (
          <Page
            key={x.id}
            tab={x}
            shown={x.id === active}
            onChange={onChange}
            onState={(s) => setStates((m) => ({ ...m, [x.id]: s }))}
            register={(el) => {
              if (el) pages.current.set(x.id, el);
              else pages.current.delete(x.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}
