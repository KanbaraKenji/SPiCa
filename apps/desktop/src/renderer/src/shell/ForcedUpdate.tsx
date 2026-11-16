// A version that must update, found at start: the window says so over everything while the new version downloads
// (how far, when known), and the app then restarts into it. A download that fails says why, with 重试; 稍后 lets the
// app be used meanwhile (the side bar's card for a must-update version stays, and it installs when the computer is
// left alone).
import { useId, useState } from 'react';
import type { UpdateState } from '../../../shared/updates';
import { t } from '../../../shared/i18n';

export function ForcedUpdate({ update, onRetry }: { update: UpdateState | null; onRetry(): void }) {
  const id = useId();
  const [later, setLater] = useState(false);
  if (!update?.forcing || later) return null;
  const failed = update.status === 'error';
  const pct = update.progress !== undefined ? Math.round(update.progress * 100) : null;
  const version = update.available ?? '';
  return (
    <div className="scrim forced-update">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={id}>
        <p className="dialog-title" id={id}>
          {failed ? t('更新失败') : update.status === 'ready' ? t('正在安装 {version}', { version }) : t('正在更新到 {version}', { version })}
        </p>
        {failed ? (
          <p className="dialog-detail">{update.message}</p>
        ) : (
          <div className="dialog-detail forced-update-progress">
            <span className="plugin-progress-bar" aria-hidden>
              <span style={{ width: `${pct ?? 0}%` }} />
            </span>
            <span className="forced-update-pct">{pct !== null ? `${pct}%` : ''}</span>
          </div>
        )}
        {failed ? (
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setLater(true)}>
              {t('稍后')}
            </button>
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              {t('重试')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
