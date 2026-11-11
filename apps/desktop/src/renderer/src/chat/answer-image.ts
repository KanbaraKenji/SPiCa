// Where a picture in an answer (Markdown ![…](…)) comes from, and whether it may be shown. A local file shows
// through the app's own file scheme; a picture on the web loads from its site (or only after a click); a network
// path (\\host\share\…, file://host/…) never loads: reaching that host would make Windows send the user's sign-in.

/**
 * How pictures on the web show in answers: as the answer comes ('auto', his choice), or only after a click
 * ('click'). The one place to switch (he may want 'click' for answers that read outside content).
 */
export const WEB_IMAGES: 'auto' | 'click' = 'auto';

export type ImageSource =
  | { kind: 'local'; path: string }
  | { kind: 'web'; url: string; host: string }
  | { kind: 'data'; url: string }
  | { kind: 'blocked' };

export function imageSource(src: string | undefined, cwd?: string): ImageSource {
  const raw = (src ?? '').trim();
  if (/^https:\/\//i.test(raw)) {
    try {
      return { kind: 'web', url: raw, host: new URL(raw).host };
    } catch {
      return { kind: 'blocked' };
    }
  }
  // Markdown hands the address over percent-encoded (D:%5C%E5%B7%A5…): read it as written.
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // not encoded
  }
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(raw)) return { kind: 'data', url: raw };
  // file:///D:/a.png is a local file; file://host/… is a network path.
  const file = /^file:\/\/\/([A-Za-z]:[\\/].*)$/i.exec(s);
  if (file) return local(file[1]!.replace(/\//g, '\\'));
  if (/^[A-Za-z]:[\\/]/.test(s)) return local(s);
  if (/^[\\/]{2}|^file:/i.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return { kind: 'blocked' };
  // A relative path: in the conversation's working folder, when it has a local one.
  if (s && cwd && /^[A-Za-z]:[\\/]/.test(cwd)) return local(`${cwd.replace(/[\\/]+$/, '')}\\${s.replace(/\//g, '\\')}`);
  return { kind: 'blocked' };
}

function local(path: string): ImageSource {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path) ? { kind: 'local', path } : { kind: 'blocked' };
}
