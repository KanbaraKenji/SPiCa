// Settings > 关于: version, where updates and announcements come from, and
// checking for an update by hand.
import { useState } from 'react';
import type { UpdateState } from '../../../shared/updates';
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
  const [draft, setDraft] = useState(ownSource);
  const deploy = update?.sourceFromDeploy ? update.source : '';
  const busy = update?.status === 'checking' || update?.status === 'downloading';
  const commit = () => {
    if (draft.trim() !== ownSource) onSource(draft.trim());
  };
  return (
    <section className="settings-section">
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">Spica {version}</span>
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
            placeholder={deploy ? `用安装包里的：${deploy}` : '共享盘文件夹或网址'}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
          <button type="button" className="btn" disabled={busy || update?.status === 'off'} onClick={onCheck}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            检查更新
          </button>
        </form>
        <p className="settings-hint about-hint">新版本和管理员发的公告都从这里取；留空就{deploy ? '用安装包里设好的地址' : '不检查'}。</p>
        {update?.message ? (
          <p className={update.status === 'error' ? 'provider-result is-bad plugin-note' : 'provider-result plugin-note'} role="status">
            {update.status === 'latest' || update.status === 'ready' ? <Icon name="check" size={14} /> : null}
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
