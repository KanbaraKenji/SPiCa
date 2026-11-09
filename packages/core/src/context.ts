// Context assembly by segment.
//
// A request is built from four segments, in order:
//   system prompt → history → input → working
// and each of the first three has a "before" and "after" slot where plugins
// can inject content (the six relative positions):
//   system:before  system  system:after
//   history:before history history:after
//   input:before   input   input:after
//   working (the assistant / tool exchanges of the current run, steers, relays)
import type { Message } from './types.ts';
import { isoNow } from './events.ts';

export type InjectionPosition =
  | 'system:before'
  | 'system:after'
  | 'history:before'
  | 'history:after'
  | 'input:before'
  | 'input:after';

export const INJECTION_POSITIONS: readonly InjectionPosition[] = [
  'system:before',
  'system:after',
  'history:before',
  'history:after',
  'input:before',
  'input:after',
];

export interface Injection {
  position: InjectionPosition;
  text: string;
  /** Who injected it (plugin id). Filled in by the hook registry. */
  source?: string;
  /** Lower runs first within the same position. Default 100. */
  priority?: number;
}

export interface ContextSegments {
  system: { before: Injection[]; base: string; after: Injection[] };
  history: { before: Injection[]; messages: Message[]; after: Injection[] };
  input: { before: Injection[]; messages: Message[]; after: Injection[] };
  /** Current run after the input: assistant turns, tool results, steers, relays. */
  working: Message[];
}

/**
 * Split stored messages into history / input / working.
 * The input is the last message written by the user or the parent (kind
 * `user`), together with any user-side messages directly after it.
 */
export function splitMessages(messages: Message[]): Pick<ContextSegments, 'history' | 'input' | 'working'> {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === 'user') {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return {
      history: { before: [], messages: [], after: [] },
      input: { before: [], messages: [], after: [] },
      working: [...messages],
    };
  }
  let end = start + 1;
  while (end < messages.length && messages[end]!.role === 'user' && messages[end]!.kind !== 'tool_results') end++;
  return {
    history: { before: [], messages: messages.slice(0, start), after: [] },
    input: { before: [], messages: messages.slice(start, end), after: [] },
    working: messages.slice(end),
  };
}

export function buildSegments(system: string, messages: Message[], injections: Injection[]): ContextSegments {
  const split = splitMessages(messages);
  const seg: ContextSegments = {
    system: { before: [], base: system, after: [] },
    ...split,
  };
  const sorted = [...injections].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  for (const inj of sorted) {
    const [part, slot] = inj.position.split(':') as ['system' | 'history' | 'input', 'before' | 'after'];
    seg[part][slot].push(inj);
  }
  return seg;
}

/** Flatten segments into the system string and message list a provider sends. */
export function flattenSegments(seg: ContextSegments, sessionId: string): { system: string; messages: Message[] } {
  const system = [
    ...seg.system.before.map((i) => i.text),
    seg.system.base,
    ...seg.system.after.map((i) => i.text),
  ]
    .filter((s) => s.trim() !== '')
    .join('\n\n');
  const note = (inj: Injection, n: number): Message => ({
    id: `inj_${inj.position}_${n}`,
    sessionId,
    seq: -1,
    role: 'user',
    kind: 'note',
    content: [{ type: 'text', text: `<context source="${inj.source ?? 'unknown'}">\n${inj.text}\n</context>` }],
    createdAt: isoNow(),
    meta: { injection: true, position: inj.position },
  });
  let n = 0;
  const messages: Message[] = [
    ...seg.history.before.map((i) => note(i, n++)),
    ...seg.history.messages,
    ...seg.history.after.map((i) => note(i, n++)),
    ...seg.input.before.map((i) => note(i, n++)),
    ...seg.input.messages,
    ...seg.input.after.map((i) => note(i, n++)),
    ...seg.working,
  ];
  return { system, messages };
}
