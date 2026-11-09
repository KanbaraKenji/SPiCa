// Shared reader for Office Open XML packages (docx / xlsx / pptx): unzip with fflate,
// walk XML with saxes. Both are pure JS.
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { ExtractError } from './types.ts';

/** Refuse packages whose XML parts would inflate beyond this (zip bombs). */
const MAX_INFLATED = 512 * 1024 * 1024;

export type ZipParts = Record<string, Uint8Array>;

export function openPackage(bytes: Uint8Array, what: string): ZipParts {
  let inflated = 0;
  let parts: ZipParts;
  try {
    parts = unzipSync(bytes, {
      filter: (f) => {
        if (!/\.(xml|rels)$/i.test(f.name)) return false;
        inflated += f.originalSize;
        if (inflated > MAX_INFLATED) throw new ExtractError(`${what} expands to more than 512 MB of XML; refusing to read it.`);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(`Not a readable ${what} (the file may be damaged, encrypted, or not really a ${what}).`);
  }
  if (!parts['[Content_Types].xml']) {
    throw new ExtractError(`Not a readable ${what} (the package has no [Content_Types].xml).`);
  }
  return parts;
}

const utf8 = new TextDecoder('utf-8');

export function partText(parts: ZipParts, name: string): string | undefined {
  const p = parts[name];
  return p ? utf8.decode(p) : undefined;
}

export interface XmlHandlers {
  open?(name: string, attrs: Record<string, string>): void;
  close?(name: string): void;
  text?(text: string): void;
}

/** Stream through an XML string. Names keep their prefix (w:p, a:t, ...). */
export function walkXml(xml: string, h: XmlHandlers, what: string): void {
  const parser = new SaxesParser();
  let failure: Error | undefined;
  parser.on('error', (e) => {
    failure ??= e;
  });
  if (h.open) {
    const open = h.open;
    parser.on('opentag', (node) => open(node.name, node.attributes as Record<string, string>));
  }
  if (h.close) {
    const close = h.close;
    parser.on('closetag', (node) => close(node.name));
  }
  if (h.text) {
    parser.on('text', h.text);
    parser.on('cdata', h.text);
  }
  try {
    parser.write(xml).close();
  } catch (e) {
    failure ??= e as Error;
  }
  if (failure) throw new ExtractError(`Damaged XML inside the ${what}: ${failure.message.split('\n')[0]}`);
}

/** Relationship id -> absolute part path, for the part at `partPath` (e.g. "word/document.xml"). */
export function relationships(parts: ZipParts, partPath: string, what: string): Map<string, string> {
  const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/')) : '';
  const file = partPath.slice(dir.length ? dir.length + 1 : 0);
  const relsXml = partText(parts, `${dir ? `${dir}/` : ''}_rels/${file}.rels`);
  const map = new Map<string, string>();
  if (!relsXml) return map;
  walkXml(
    relsXml,
    {
      open(name, a) {
        if (name !== 'Relationship' || !a.Id || !a.Target || a.TargetMode === 'External') return;
        map.set(a.Id, resolvePart(dir, a.Target));
      },
    },
    what,
  );
  return map;
}

function resolvePart(dir: string, target: string): string {
  const segs = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const s of target.replace(/^\//, '').split('/')) {
    if (s === '..') segs.pop();
    else if (s && s !== '.') segs.push(s);
  }
  return segs.join('/');
}
