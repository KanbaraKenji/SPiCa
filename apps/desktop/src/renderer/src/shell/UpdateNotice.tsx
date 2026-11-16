// Updates in the side bar, above the account row: a downloaded app update (重启并更新; a version that must update
// keeps its card, without 稍后) or plugins that can update (查看). When the side bar is only its column of icons
// (closed, or the window too narrow), the same place holds one icon button, so nothing is lost with the side bar:
// the app's update opens the side bar on its card, the plugins' opens them.
import { useState } from 'react';
import { SpicaStatusIcon } from '@spica/brand/react';
import type { UpdateState } from '../../../shared/updates';
import { Icon } from '../ui/Icon';
import { t } from '../../../shared/i18n';

export interface UpdateNoticeView {
  kind: 'app' | 'plugins';
  text: string;
  /** The version must update: warning colour, no 稍后. */
  required: boolean;
  /** 重启并更新 can be pressed (a portable copy only hears of it). */
  ready: boolean;
  /** How many plugins (kind plugins). */
  count: number;
  /** 稍后; absent when it cannot be closed. */
  close?: () => void;
}

/** What to show now, the app's update before the plugins'; closing is kept here, for the card and the icon alike. */
export function useUpdateNotice(update: UpdateState | null): UpdateNoticeView | null {
  const [appClosed, setAppClosed] = useState<string | null>(null);
  const [pluginsClosed, setPluginsClosed] = useState(0);
  const required = Boolean(update?.required);
  // Downloaded and waiting; a portable copy, which cannot install it, only hears of it.
  const waiting = update?.status === 'ready' || (update?.status === 'manual' && update.portable);
  if (waiting && update?.available && (required || appClosed !== update.available)) {
    const ready = update.status === 'ready';
    const available = update.available;
    return {
      kind: 'app',
      text: ready ? t('新版本 {version} 已下载', { version: available }) : t('新版本 {version}', { version: available }),
      required,
      ready,
      count: 0,
      ...(required ? {} : { close: () => setAppClosed(available) }),
    };
  }
  // Closed: shown again only when the count grows.
  const n = update?.pluginUpdates ?? 0;
  if (n > pluginsClosed) return { kind: 'plugins', text: t('{n} 个插件可更新', { n }), required: false, ready: false, count: n, close: () => setPluginsClosed(n) };
  return null;
}

export interface UpdateNoticeProps {
  notice: UpdateNoticeView;
  onInstall(): void;
  onOpenPlugins(): void;
}

/** The card in the full side bar. */
export function UpdateCard({ notice, onInstall, onOpenPlugins }: UpdateNoticeProps) {
  return (
    <div className={notice.required ? 'update-card is-warning' : 'update-card'} role="status">
      <div className="update-card-head">
        <SpicaStatusIcon name={notice.required ? 'warning' : 'done'} size={15} className="notice-icon" />
        <span className="update-card-text">{notice.text}</span>
        {notice.close ? (
          <button type="button" className="icon-btn notice-close" onClick={notice.close} aria-label={t('稍后')} title={t('稍后')}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>
      {notice.kind === 'app' && notice.ready ? (
        <button type="button" className="btn btn-small btn-primary update-card-action" onClick={onInstall}>
          {t('重启并更新')}
        </button>
      ) : notice.kind === 'plugins' ? (
        <button type="button" className="btn btn-small update-card-action" onClick={onOpenPlugins}>
          {t('查看')}
        </button>
      ) : null}
    </div>
  );
}

/** The icon in the side bar's column of icons: the app's opens the side bar (its card), the plugins' open them. */
export function UpdateRailButton({ notice, onOpenSidebar, onOpenPlugins }: { notice: UpdateNoticeView; onOpenSidebar(): void; onOpenPlugins(): void }) {
  const app = notice.kind === 'app';
  return (
    <button
      type="button"
      className={notice.required ? 'side-action update-rail is-warning' : 'side-action update-rail'}
      onClick={app ? onOpenSidebar : onOpenPlugins}
      aria-label={notice.text}
      title={notice.text}
    >
      <Icon name={app ? 'download' : 'refresh'} />
      {app ? <span className="update-rail-dot" aria-hidden /> : <span className="rail-badge">{notice.count}</span>}
    </button>
  );
}
