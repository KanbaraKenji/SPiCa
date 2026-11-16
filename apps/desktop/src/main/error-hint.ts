// A conversation's error, in words: the core's own hint for it (worded for the connection's kind, so a WSO2
// gateway's says 网关地址), else the words for its code looked up here (older cores send only the code). Either
// one in the interface's language now (shared/errors.ts netWords: by code; words the shell does not know as sent).
import { NET_HINTS } from '@spica/core';
import { netWords } from '../shared/errors';

export function withErrorHint<E extends { type: string }>(event: E, hints: Readonly<Record<string, string>> = NET_HINTS): E {
  if (event.type !== 'error') return event;
  const code = (event as { code?: unknown }).code;
  const own = (event as { hint?: unknown }).hint;
  const sent = typeof own === 'string' && own.trim() ? own : typeof code === 'string' ? hints[code] : undefined;
  if (!sent) return event;
  const hint = netWords(typeof code === 'string' ? code : undefined, sent) ?? sent;
  return hint === own ? event : { ...event, hint };
}
