// Settings > 关于: version, where updates and announcements come from, and
// checking for an update by hand. Nine clicks on the version switch the 监控台 on (its title bar button shows), nine
// more switch it off; the version does not look clickable and nothing points at it.
import { useRef, useState } from 'react';
import type { UpdateState } from '../../../shared/updates';
import { APP_NAME } from '../../../shared/app-identity';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { Group, Pane, Row } from './Group';
import { Switch } from './Switch';

export interface AboutProps {
  version: string;
  update: UpdateState | null;
  onCheck(): void;
  onInstall(): void;
  /** 空闲时更新: a downloaded update installs itself when the computer is left alone. */
  whenIdle: boolean;
  onWhenIdle(on: boolean): void;
  /** The 监控台's switch (nine clicks on the version). */
  monitor?: { on: boolean; onToggle(): void };
}

/** Clicks on the version that switch the 监控台 on or off. */
export const MONITOR_CLICKS = 9;
/** A longer pause between two clicks starts the count again. */
export const MONITOR_CLICK_GAP_MS = 1500;

export function About({ version, update, onCheck, onInstall, whenIdle, onWhenIdle, monitor }: AboutProps) {
  // the clicks so far (and when the last one was); leaving the page starts again
  const taps = useRef({ n: 0, at: 0 });
  const [switched, setSwitched] = useState<boolean | null>(null);
  const tap = () => {
    if (!monitor) return;
    const now = Date.now();
    taps.current = { n: now - taps.current.at > MONITOR_CLICK_GAP_MS ? 1 : taps.current.n + 1, at: now };
    if (taps.current.n < MONITOR_CLICKS) return;
    taps.current = { n: 0, at: 0 };
    setSwitched(!monitor.on);
    monitor.onToggle();
  };
  const busy = update?.status === 'checking' || update?.status === 'downloading';
  // This build checks for no updates (a renamed build with no source in its deploy.json, or deploy.json said "").
  const noSource = update?.status === 'off';
  return (
    <section className="settings-section">
      <Group>
        <Row
          title={
            <span className="about-version" onClick={tap}>
              {`${APP_NAME} ${version}`}
            </span>
          }
          hint={update?.portable ? '便携版' : undefined}
        >
          {update?.status === 'ready' ? (
            <button type="button" className="btn btn-primary" onClick={onInstall}>
              重启并更新
            </button>
          ) : null}
        </Row>
        {switched !== null ? (
          <Pane>
            <p className="provider-result" role="status">
              <SpicaStatusIcon name="done" size={15} />
              {switched ? '监控台已开启' : '监控台已关闭'}
            </p>
          </Pane>
        ) : null}
      </Group>

      <Group title="更新与公告">
        {/* Where updates come from is the build's (deploy.json, the official channel): not shown, not set here. */}
        <Row title="检查更新">
          {/* A build that checks for nothing: shown greyed (not disabled, so hovering still says why). */}
          <button
            type="button"
            className="btn btn-square"
            disabled={busy}
            aria-disabled={noSource || undefined}
            onClick={() => !noSource && onCheck()}
            aria-label="检查更新"
            title={noSource ? '这个版本不检查更新' : '检查更新'}
          >
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
          </button>
        </Row>
        {/* A portable copy cannot replace itself: nothing to switch on. */}
        {update?.portable ? null : (
          <Row title="空闲时更新">
            <Switch on={whenIdle} label="空闲时更新" onChange={onWhenIdle} />
          </Row>
        )}
        {update?.status === 'checking' ? (
          <Pane>
            <p className="provider-result" role="status">
              正在检查更新…
            </p>
          </Pane>
        ) : update?.message ? (
          <Pane>
            <p className={update.status === 'error' ? 'provider-result is-bad' : 'provider-result'} role="status">
              {update.status === 'latest' || update.status === 'ready' ? <SpicaStatusIcon name="done" size={15} /> : update.status === 'error' ? <SpicaStatusIcon name="error" size={15} /> : null}
              {update.message}
            </p>
          </Pane>
        ) : null}
      </Group>
    </section>
  );
}
