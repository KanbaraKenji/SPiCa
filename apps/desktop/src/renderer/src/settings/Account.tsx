// Settings > 账号, laid out like Claude's Profile: one box, the avatar row first, then a row per field with
// the name on the left and the box on the right (all boxes the same width, so they line up).
//   头像  the account on the left, and the round letter badge the sidebar's bottom row shows (ui/badge); a row
//        as tall as the two under it.
//   账号  what plugins get as the user's account (SPICA_USER_ACCOUNT, ctx.user.account). The automatic one is
//        worked out in the main process (main/user-account.ts); what is typed here replaces it.
//   昵称  what the new conversation's greeting calls the user (下午好，Alex). From the account unless typed;
//        only shown in the window, never given to plugins.
// Labels only: what is used when nothing is typed shows in grey in the box; 恢复… sits beside the box.
import { useContext, useState } from 'react';
import { ACCOUNT_MAX, accountValue, CALL_NAME_MAX, callNameValue, defaultCallName, effectiveAccount, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import { letterBadge } from '../ui/badge';
import { Group, Row, SettingsSearchContext } from './Group';

export interface AccountProps {
  settings: ShellSettings;
  onChange(patch: SettingsPatch): void;
  /** The account by the company rule (main/user-account.ts); '' or absent: none was found. */
  autoAccount?: string;
}

/**
 * A row with a box: the value used when nothing is typed shows in grey; what is typed is kept when the box is
 * left or Enter is pressed (not at each key: a new account restarts plugin processes). Typing the grey value
 * again is the same as typing nothing. `back` (恢复…, before the box so the boxes line up) clears what was typed;
 * its tip says what comes back.
 */
function TypedRow(p: { title: string; saved: string; fallback: string; empty: string; max: number; clean(v: string): string; back: string; onSave(v: string): void }) {
  const [text, setText] = useState(p.saved);
  // changed elsewhere (the 恢复 button, another window): show it
  const [shown, setShown] = useState(p.saved);
  if (shown !== p.saved) {
    setShown(p.saved);
    setText(p.saved);
  }
  const keep = () => {
    const typed = p.clean(text);
    const v = typed === p.fallback ? '' : typed;
    setText(v);
    if (v !== p.saved) p.onSave(v);
  };
  return (
    <Row title={p.title}>
      {p.saved ? (
        <button type="button" className="btn" title={p.fallback ? `恢复为 ${p.fallback}` : undefined} onClick={() => p.onSave('')}>
          {p.back}
        </button>
      ) : null}
      <input
        className="input account-field"
        value={text}
        placeholder={p.fallback || p.empty}
        spellCheck={false}
        autoComplete="off"
        maxLength={p.max}
        aria-label={p.title}
        onChange={(e) => setText(e.target.value)}
        onBlur={keep}
        onKeyDown={(e) => {
          if (e.key === 'Enter') keep();
        }}
      />
    </Row>
  );
}

export function Account({ settings, onChange, autoAccount = '' }: AccountProps) {
  const account = effectiveAccount(settings, autoAccount);
  const fromAccount = defaultCallName(account);
  const me = account ? letterBadge(account, account) : null;
  const searching = !!useContext(SettingsSearchContext)?.query;
  return (
    <section className="settings-section">
      <Group>
        {searching ? null : (
          // laid out as a row, but not a setting: 搜索设置 does not list it
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-title">{account || '未取到账号'}</span>
            </div>
            {me ? (
              <span className="plugin-badge account-avatar" style={{ background: me.colour }} aria-hidden>
                {me.letter}
              </span>
            ) : null}
          </div>
        )}
        <TypedRow
          title="账号"
          saved={settings.account}
          fallback={autoAccount}
          empty="未取到"
          max={ACCOUNT_MAX}
          clean={accountValue}
          back="恢复自动"
          onSave={(account) => onChange({ account })}
        />
        <TypedRow
          title="昵称"
          saved={settings.callName}
          fallback={fromAccount}
          empty="不带昵称"
          max={CALL_NAME_MAX}
          clean={callNameValue}
          back="恢复默认"
          onSave={(callName) => onChange({ callName })}
        />
      </Group>
    </section>
  );
}
