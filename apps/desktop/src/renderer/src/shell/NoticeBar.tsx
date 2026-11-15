// One line at the top of the main pane: a downloaded update waiting for a
// restart, plugins that can update, or an administrator's announcement. It floats over the content
// (nothing below moves when it appears or goes away) and can be closed.
import { useEffect, useState } from 'react';
import type { BackendState, DesktopBridge } from '../../../shared/bridge';
import type { AgentStore } from '../store/agent';
import { activeNotices, type Notice, type UpdateState } from '../../../shared/updates';
import type { ShellSettings } from '../../../shared/settings';
import { Icon } from '../ui/Icon';
import { SpicaStatusIcon } from '@spica/brand/react';

export function useUpdateState(bridge: DesktopBridge): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.updates
      .run('state')
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    const off = bridge.updates.onChanged(setState);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);
  return state;
}

/** The core's process; after it comes back from a crash, sessions are reloaded. */
export function useBackendState(bridge: DesktopBridge, agent: AgentStore): BackendState | null {
  const [state, setState] = useState<BackendState | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.backend
      .status()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    const offStatus = bridge.backend.onStatus(setState);
    const offRestart = bridge.backend.onRestarted(() => void agent.reloadAll());
    return () => {
      alive = false;
      offStatus();
      offRestart();
    };
  }, [bridge, agent]);
  return state;
}

export interface NoticeBarProps {
  backend?: BackendState | null;
  onRetryBackend?: () => void;
  update: UpdateState | null;
  settings: ShellSettings;
  onInstall(): void;
  /** 设置 › 插件, where the plugins that can update are. */
  onOpenPlugins?: () => void;
  onDismissNotice(id: string): void;
}

export function NoticeBar({ backend, onRetryBackend, update, settings, onInstall, onOpenPlugins, onDismissNotice }: NoticeBarProps) {
  const [updateClosed, setUpdateClosed] = useState<string | null>(null);
  const [pluginsClosed, setPluginsClosed] = useState(0);
  // A version that must update keeps its line until it is updated (no 稍后).
  const required = Boolean(update?.required);
  // Downloaded and waiting; a portable copy, which cannot install it, only hears of it.
  const waiting = update?.status === 'ready' || (update?.status === 'manual' && update.portable);
  const showUpdate = waiting && update?.available && (required || updateClosed !== update.available);
  // Closed: shown again only when the count grows.
  const pluginUpdates = update?.pluginUpdates ?? 0;
  const showPlugins = pluginUpdates > pluginsClosed;
  const notice: Notice | undefined = activeNotices(settings.noticesCache, settings.dismissedNotices)[0];

  if (backend?.state === 'recovering') {
    return (
      <div className="notice-bar is-warning" role="status">
        <SpicaStatusIcon name="running" size={15} className="notice-icon" />
        <span className="notice-text">后台正在恢复…</span>
      </div>
    );
  }
  if (backend?.state === 'failed') {
    return (
      <div className="notice-bar is-warning" role="alert">
        <SpicaStatusIcon name="error" size={15} className="notice-icon" />
        <span className="notice-text">{backend.message}</span>
        <button type="button" className="btn btn-small" onClick={onRetryBackend}>
          重试
        </button>
      </div>
    );
  }
  if (showUpdate && update?.available) {
    const ready = update.status === 'ready';
    return (
      <div className={required ? 'notice-bar is-warning' : 'notice-bar'} role="status">
        <SpicaStatusIcon name={required ? 'warning' : 'done'} size={15} className="notice-icon" />
        <span className="notice-text">{ready ? `新版本 ${update.available} 已下载` : `新版本 ${update.available}`}</span>
        {ready ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onInstall}>
            重启并更新
          </button>
        ) : null}
        {required ? null : (
          <button type="button" className="icon-btn notice-close" onClick={() => setUpdateClosed(update.available ?? null)} aria-label="稍后" title="稍后">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
    );
  }
  if (showPlugins) {
    return (
      <div className="notice-bar" role="status">
        <SpicaStatusIcon name="done" size={15} className="notice-icon" />
        <span className="notice-text">{pluginUpdates} 个插件可更新</span>
        {onOpenPlugins ? (
          <button type="button" className="btn btn-small" onClick={onOpenPlugins}>
            查看
          </button>
        ) : null}
        <button type="button" className="icon-btn notice-close" onClick={() => setPluginsClosed(pluginUpdates)} aria-label="稍后" title="稍后">
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <div className={notice.level === 'warning' ? 'notice-bar is-warning' : 'notice-bar'} role="status">
      <span className="notice-text" title={notice.text} data-tip-clipped="">
        {notice.text}
      </span>
      {notice.link ? (
        <a className="notice-link" href={notice.link} target="_blank" rel="noreferrer">
          查看
        </a>
      ) : null}
      <button type="button" className="icon-btn notice-close" onClick={() => onDismissNotice(notice.id)} aria-label="关闭公告" title="关闭">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
