// spica-flow://app/…: the flowchart frame's files (renderer/flow.html and the built assets) for the installed app,
// which runs its page from files. The frame is sandboxed (an opaque origin), and its script is an ES module, which
// a page like that may only load over CORS; this scheme answers with it. Nothing outside the renderer folder.
import { posix } from 'node:path';

export const FLOW_SCHEME = 'spica-flow';

/** The renderer file a spica-flow URL asks for (relative, forward slashes), or null when it is not one it serves. */
export function flowFile(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${FLOW_SCHEME}:` || u.host !== 'app') return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const norm = posix.normalize(rel);
  if (norm !== rel || norm.startsWith('..')) return null;
  return norm === 'flow.html' || /^assets\/[\w.-]+\.(js|css)$/.test(norm) ? norm : null;
}
