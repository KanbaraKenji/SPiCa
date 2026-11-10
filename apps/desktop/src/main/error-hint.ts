// A conversation's error, in words: the core's own hint for it (worded for the connection's kind, so a WSO2
// gateway's says 网关地址), else the words for its code looked up here (older cores send only the code).
import { NET_HINTS } from '@spica/core';

export function withErrorHint<E extends { type: string }>(event: E, hints: Readonly<Record<string, string>> = NET_HINTS): E {
  if (event.type !== 'error') return event;
  const own = (event as { hint?: unknown }).hint;
  if (typeof own === 'string' && own.trim()) return event;
  const code = (event as { code?: unknown }).code;
  const hint = typeof code === 'string' ? hints[code] : undefined;
  return hint ? { ...event, hint } : event;
}
