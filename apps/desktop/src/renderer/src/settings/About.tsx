// Settings > 关于: version, where updates and announcements come from, and
// checking for an update by hand.
import { useKeptDraft } from './drafts';
import type { UpdateState } from '../../../shared/updates';
import { APP_NAME } from '../../../shared/app-identity';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';

export interface AboutProps {
  version: string;
  update: UpdateState | null;
  /** The source the user typed (empty when the installer's default is used). */
  ownSource: string;
  onSource(source: string): void;
  onCheck(): void;
  onInstall(): void;
}

export function About({ version, update, ownSource, onSource, onCheck, onInstall }: AboutProps) {
  const [draft, setDraft, draftDone] = useKeptDraft('about.updateSource', ownSource);
  const deploy = update?.sourceFromDeploy ? update.source : '';
  const busy = update?.status === 'checking' || update?.status === 'downloading';
  // Nothing to check against until a source is given (here or by the installer).
  const noSource = update?.status === 'off';
  const commit = () => {
    if (draft.trim() !== ownSource) onSource(draft.trim());
    draftDone();
  };
  return (
    <section className="settings-section">
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">
              {APP_NAME} {version}
            </span>
            {update?.portable ? <span className="settings-hint">便携版</span> : null}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h3 className="settings-subheading">更新与公告</h3>
        <form
          className="install-row"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            className="input"
            value={draft}
            spellCheck={false}
            aria-label="更新源"
            placeholder={deploy ? `默认：${deploy}` : '共享盘文件夹或网址'}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
          {/* No source yet: shown greyed (not disabled, so hovering still says why). */}
          <button
            type="button"
            className="btn btn-square"
            disabled={busy}
            aria-disabled={noSource || undefined}
            onClick={() => !noSource && onCheck()}
            aria-label="检查更新"
            title={noSource ? '先填更新源' : '检查更新'}
          >
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
          </button>
        </form>
        {update?.status === 'checking' ? (
          <p className="provider-result plugin-note" role="status">
            正在检查更新…
          </p>
        ) : update?.message && !noSource ? (
          <p className={update.status === 'error' ? 'provider-result is-bad plugin-note' : 'provider-result plugin-note'} role="status">
            {update.status === 'latest' || update.status === 'ready' ? <SpicaStatusIcon name="done" size={15} /> : update.status === 'error' ? <SpicaStatusIcon name="error" size={15} /> : null}
            {update.message}
          </p>
        ) : null}
        {update?.status === 'ready' ? (
          <button type="button" className="btn btn-primary about-install" onClick={onInstall}>
            重启并更新
          </button>
        ) : null}
      </div>
    </section>
  );
}
