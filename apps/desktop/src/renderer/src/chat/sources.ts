// The web pages an answer rests on: every page web_fetch opened, and the search results the answer links to
// (a search result the model never cited is not a source of the answer). Each page once, by address.
import type { SourceCardMeta, SourceRow } from '@spica/protocol';
import type { Block } from '../store/transcript';

/** The site a page is on, shown when it has no title (and beside the title). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Addresses linked in an answer's text (Markdown links and bare https addresses), without a trailing slash or #part. */
function linked(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)<>\]"']+/g)) out.add(norm(m[0]));
  return out;
}

const norm = (url: string): string => url.replace(/#.*$/, '').replace(/[.,;:!?。，；：！？]+$/, '').replace(/\/$/, '');

export function answerSources(blocks: readonly Block[], cards: Record<string, SourceCardMeta> = {}): SourceRow[] {
  const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const cited = linked(text);
  const seen = new Map<string, SourceRow>();
  for (const b of blocks) {
    if (b.type !== 'tool' || b.state === 'error') continue;
    const card = cards[b.callId];
    if (!card) continue;
    for (const row of card.sources) {
      const key = norm(row.url);
      if (seen.has(key)) continue;
      if (card.tool === 'web_fetch' || cited.has(key)) seen.set(key, row);
    }
  }
  return [...seen.values()];
}
