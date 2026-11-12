// Settings > 账号 (he agreed to a section of its own, 2026-11-12): the account plugins get as the user's
// (SPICA_USER_ACCOUNT, ctx.user.account). The automatic one is worked out in the main process
// (main/user-account.ts); what is typed here replaces it.
import { useState } from 'react';
import { ACCOUNT_MAX, accountValue, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import { Group, Row } from './Group';

export interface AccountProps {
  settings: ShellSettings;
  onChange(patch: SettingsPatch): void;
  /** The account by the company rule (main/user-account.ts); '' or absent: none was found. */
  autoAccount?: string;
}

/**
 * 账号: what plugins get as the user's account. The box shows the automatic one in grey; what is typed replaces
 * it, kept when the box is left or Enter is pressed (not at each key: plugin processes restart with a new one).
 */
export function Account({ settings, onChange, autoAccount = '' }: AccountProps) {
  const [text, setText] = useState(settings.account);
  // changed elsewhere (恢复自动, another window): show it
  const [shown, setShown] = useState(settings.account);
  if (shown !== settings.account) {
    setShown(settings.account);
    setText(settings.account);
  }
  const keep = () => {
    const typed = accountValue(text);
    // typing the automatic one again is the same as none typed
    const account = typed === autoAccount ? '' : typed;
    setText(account);
    if (account !== settings.account) onChange({ account });
  };
  const hint = settings.account
    ? autoAccount
      ? `已手动填写，自动取到的是 ${autoAccount}。`
      : '已手动填写。'
    : autoAccount
      ? '取自 Windows 用户文件夹名，提供给插件。'
      : '没有取到 Windows 用户文件夹名，插件读到的账号为空。可以手动填写。';
  return (
    <section className="settings-section">
      <Group>
        <Row title="账号" hint={hint}>
          <input
            className="input account-field"
            value={text}
            placeholder={autoAccount || '未取到'}
            spellCheck={false}
            autoComplete="off"
            maxLength={ACCOUNT_MAX}
            aria-label="账号"
            onChange={(e) => setText(e.target.value)}
            onBlur={keep}
            onKeyDown={(e) => {
              if (e.key === 'Enter') keep();
            }}
          />
          {settings.account ? (
            <button type="button" className="btn" onClick={() => onChange({ account: '' })}>
              恢复自动
            </button>
          ) : null}
        </Row>
      </Group>
    </section>
  );
}
