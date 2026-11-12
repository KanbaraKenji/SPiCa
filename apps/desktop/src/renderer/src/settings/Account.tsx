// Settings > 账号 (he agreed to a section of its own, 2026-11-12):
//   账号  what plugins get as the user's account (SPICA_USER_ACCOUNT, ctx.user.account). The automatic one is
//        worked out in the main process (main/user-account.ts); what is typed here replaces it.
//   称呼  what the new conversation's greeting calls the user (下午好，Alex). From the account unless typed;
//        only shown in the window, never given to plugins.
import { useState } from 'react';
import { ACCOUNT_MAX, accountValue, CALL_NAME_MAX, callNameValue, defaultCallName, effectiveAccount, type SettingsPatch, type ShellSettings } from '../../../shared/settings';
import { Group, Row } from './Group';

export interface AccountProps {
  settings: ShellSettings;
  onChange(patch: SettingsPatch): void;
  /** The account by the company rule (main/user-account.ts); '' or absent: none was found. */
  autoAccount?: string;
}

/**
 * A row with a box: the value used when nothing is typed shows in grey; what is typed is kept when the box is
 * left or Enter is pressed (not at each key: a new account restarts plugin processes). Typing the grey value
 * again is the same as typing nothing. `back` (恢复…) clears what was typed.
 */
function TypedRow(p: { title: string; hint: string; saved: string; fallback: string; empty: string; max: number; clean(v: string): string; back: string; onSave(v: string): void }) {
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
    <Row title={p.title} hint={p.hint}>
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
      {p.saved ? (
        <button type="button" className="btn" onClick={() => p.onSave('')}>
          {p.back}
        </button>
      ) : null}
    </Row>
  );
}

export function Account({ settings, onChange, autoAccount = '' }: AccountProps) {
  const fromAccount = defaultCallName(effectiveAccount(settings, autoAccount));
  const accountHint = settings.account
    ? autoAccount
      ? `已手动填写，自动取到的是 ${autoAccount}。`
      : '已手动填写。'
    : autoAccount
      ? '取自 Windows 用户文件夹名，提供给插件。'
      : '没有取到 Windows 用户文件夹名，插件读到的账号为空。可以手动填写。';
  const nameHint = settings.callName
    ? fromAccount
      ? `新对话页问候你时用。不填就用账号里的 ${fromAccount}。`
      : '新对话页问候你时用。'
    : fromAccount
      ? '新对话页问候你时用，取自账号。只在界面上显示，不提供给插件。'
      : '新对话页问候你时用。没有账号时不带称呼。';
  return (
    <section className="settings-section">
      <Group>
        <TypedRow
          title="账号"
          hint={accountHint}
          saved={settings.account}
          fallback={autoAccount}
          empty="未取到"
          max={ACCOUNT_MAX}
          clean={accountValue}
          back="恢复自动"
          onSave={(account) => onChange({ account })}
        />
        <TypedRow
          title="称呼"
          hint={nameHint}
          saved={settings.callName}
          fallback={fromAccount}
          empty="不带称呼"
          max={CALL_NAME_MAX}
          clean={callNameValue}
          back="恢复默认"
          onSave={(callName) => onChange({ callName })}
        />
      </Group>
    </section>
  );
}
