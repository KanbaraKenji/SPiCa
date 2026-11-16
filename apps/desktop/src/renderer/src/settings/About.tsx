// Settings > 关于: the version with its update state and button on the same row (he picked B: 「状态和按钮在版本号同一行
// 右边」), and the 自动更新 switch. Nine clicks on the version switch the 监控台 on (its title bar button shows), nine
// more switch it off; the version does not look clickable and nothing points at it.
import { useRef, useState } from 'react';
import type { UpdateState } from '../../../shared/updates';
import { APP_NAME } from '../../../shared/app-identity';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { Group, Pane, Row } from './Group';
import { Switch } from './Switch';
import { t } from '../../../shared/i18n';

export interface AboutProps {
  version: string;
  update: UpdateState | null;
  onCheck(): void;
  onInstall(): void;
  /** 自动更新: a downloaded update installs itself when the computer is left alone. */
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
  const ready = update?.status === 'ready';
  const failed = update?.status === 'error';
  // The state in a few words, next to the button; the version is on the left already, so it is not said again.
  const state =
    update?.status === 'checking'
      ? t('正在检查更新…')
      : ready && update?.available
        ? t('新版本 {version} 已下载', { version: update.available })
        : update?.status === 'latest'
          ? t('已是最新版本')
          : noSource
            ? t('这个版本不检查更新')
            : (update?.message ?? '');
  return (
    <section className="settings-section">
      <Group>
        <Row
          className="about-row"
          title={
            <span className="about-version" onClick={tap}>
              {`${APP_NAME} ${version}`}
            </span>
          }
          hint={update?.portable ? t('便携版') : undefined}
        >
          <span className="about-inline">
            {/* What went wrong is a sentence: on a line of its own under the row, red. */}
            {state && !failed ? (
              <span className="about-state" role="status">
                {update?.status === 'latest' ? <SpicaStatusIcon name="done" size={15} /> : null}
                {state}
              </span>
            ) : null}
            {ready ? (
              <button type="button" className="btn btn-primary" onClick={onInstall}>
                {t('立即更新')}
              </button>
            ) : (
              /* A build that checks for nothing: shown greyed (not disabled, so hovering still says why). */
              <button
                type="button"
                className="btn btn-square"
                disabled={busy}
                aria-disabled={noSource || undefined}
                onClick={() => !noSource && onCheck()}
                aria-label={t('检查更新')}
                title={noSource ? t('这个版本不检查更新') : t('检查更新')}
              >
                {busy ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
              </button>
            )}
          </span>
        </Row>
        {failed && state ? (
          <Pane>
            <p className="provider-result is-bad" role="status">
              <SpicaStatusIcon name="error" size={15} />
              {state}
            </p>
          </Pane>
        ) : null}
        {switched !== null ? (
          <Pane>
            <p className="provider-result" role="status">
              <SpicaStatusIcon name="done" size={15} />
              {switched ? t('监控台已开启') : t('监控台已关闭')}
            </p>
          </Pane>
        ) : null}
      </Group>

      {/* A portable copy cannot replace itself, and a build that checks for nothing gets nothing: no switch. */}
      {update?.portable || noSource ? null : (
        <Group title={t('更新与公告')}>
          {/* Where updates come from is the build's (deploy.json, the official channel): not shown, not set here. */}
          <Row title={t('自动更新')}>
            <Switch on={whenIdle} label={t('自动更新')} onChange={onWhenIdle} />
          </Row>
        </Group>
      )}
    </section>
  );
}
