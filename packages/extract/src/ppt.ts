// PowerPoint 97-2003 (.ppt): the text of each slide in show order, and its speaker notes ([MS-PPT]).
// The file is an OLE container; its "PowerPoint Document" stream is a list of records. A save may only append the
// changed records (a fast save), so the live slides are found the way PowerPoint finds them: "Current User" points at
// the newest edit (UserEditAtom), each edit has a persist directory (object id -> offset) and the edits chain back to
// the first save; the newest offset of an id wins. The slide list (SlideListWithText) gives the show order and the
// placeholder text; text boxes of their own are in each slide's drawing (ClientTextbox).
import CFB from 'cfb';
import { renderSlides } from './pptx.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';

const WHAT = 'PowerPoint 97-2003 presentation';

const RT = {
  document: 0x03e8,
  slide: 0x03ee,
  slideAtom: 0x03ef,
  notes: 0x03f0,
  slidePersist: 0x03f3,
  outlineTextRef: 0x0f9e,
  textHeader: 0x0f9f,
  textChars: 0x0fa0,
  textBytes: 0x0fa8,
  slideList: 0x0ff0,
  userEdit: 0x0ff5,
  currentUser: 0x0ff6,
  persistDirectory: 0x1772,
  clientTextbox: 0xf00d,
} as const;

/** A record: header fields, where its body starts and how long it is. */
interface Rec {
  ver: number;
  instance: number;
  type: number;
  start: number;
  len: number;
}

function header(buf: Buffer, at: number): Rec | undefined {
  if (at < 0 || at + 8 > buf.length) return undefined;
  const v = buf.readUInt16LE(at);
  const len = buf.readUInt32LE(at + 4);
  if (at + 8 + len > buf.length) return undefined;
  return { ver: v & 0xf, instance: v >> 4, type: buf.readUInt16LE(at + 2), start: at + 8, len };
}

/** The records directly inside `buf[from, to)`. */
function children(buf: Buffer, from: number, to: number): Rec[] {
  const out: Rec[] = [];
  let at = from;
  while (at + 8 <= to) {
    const r = header(buf, at);
    if (!r || r.start + r.len > to) break;
    out.push(r);
    at = r.start + r.len;
  }
  return out;
}

function fail(why: string): never {
  throw new ExtractError(`Not a readable ${WHAT} (${why}).`);
}

const OLD = 'This is a PowerPoint 95 or older presentation, which is not read here; open it in PowerPoint and save it as .pptx.';
const LOCKED = 'This presentation is password protected; it cannot be read without the password.';

/** Object id -> offset of the record in the stream, from the newest edit back to the first save. */
function persistDirectory(buf: Buffer, firstEdit: number): { offsets: Map<number, number>; documentId: number } {
  const offsets = new Map<number, number>();
  let documentId = 0;
  const seen = new Set<number>();
  for (let at = firstEdit; ; ) {
    if (seen.has(at)) break; // a loop in a damaged chain
    seen.add(at);
    const edit = header(buf, at);
    if (!edit || edit.type !== RT.userEdit || edit.len < 0x1c) fail('an edit record is missing');
    const b = edit.start;
    if (seen.size === 1) documentId = buf.readUInt32LE(b + 16);
    if (edit.len >= 0x20 && buf.readUInt32LE(b + 0x1c) !== 0) throw new ExtractError(LOCKED);
    const dir = header(buf, buf.readUInt32LE(b + 12));
    if (!dir || dir.type !== RT.persistDirectory) fail('an object directory is missing');
    for (let p = dir.start; p + 4 <= dir.start + dir.len; ) {
      const head = buf.readUInt32LE(p);
      const first = head & 0xfffff;
      const count = head >>> 20;
      p += 4;
      for (let i = 0; i < count && p + 4 <= dir.start + dir.len; i++, p += 4) {
        if (!offsets.has(first + i)) offsets.set(first + i, buf.readUInt32LE(p));
      }
    }
    const prev = buf.readUInt32LE(b + 8);
    if (prev === 0) break;
    // a damaged link (pointing at itself, ahead, or at no edit): the edit saved just before this one
    const linked = prev < at ? header(buf, prev) : undefined;
    at = linked?.type === RT.userEdit ? prev : (edits(buf).filter((e) => e < at).at(-1) ?? 0);
    if (at === 0) break;
  }
  return { offsets, documentId };
}

/** Where the edit records are in the stream, in order (for damaged links). */
function edits(buf: Buffer): number[] {
  return children(buf, 0, buf.length)
    .filter((r) => r.type === RT.userEdit)
    .map((r) => r.start - 8);
}

/** The newest edit: where "Current User" says, else (a damaged pointer) the last edit record in the stream. */
function newestEdit(buf: Buffer, pointed: number): number {
  const r = header(buf, pointed);
  if (r && r.type === RT.userEdit) return pointed;
  const last = edits(buf).at(-1);
  if (last === undefined) fail('no edit record');
  return last;
}

/** Text atom to paragraphs: \r ends a paragraph, \v is a line break; other control characters are dropped. */
function textOf(buf: Buffer, r: Rec): string {
  const raw = r.type === RT.textChars ? buf.toString('utf16le', r.start, r.start + (r.len & ~1)) : buf.toString('latin1', r.start, r.start + r.len);
  return raw
    .replace(/\r/g, '\n')
    .replace(/\v/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f]/g, '');
}

function paragraphs(text: string): string[] {
  return text
    .split('\n')
    .map((p) => p.trim())
    // "*" is where PowerPoint puts a slide number or date field
    .filter((p) => p && p !== '*');
}

/** The texts listed for each slide (or notes page) in a SlideListWithText, by the object id of the slide. */
function listTexts(buf: Buffer, list: Rec): { order: number[]; texts: Map<number, string[]>; bySlideId: Map<number, number> } {
  const order: number[] = [];
  const texts = new Map<number, string[]>();
  // the slide (or notes page) identifier other records use (SlideAtom.notesIdRef) -> its object id
  const bySlideId = new Map<number, number>();
  let current: string[] | undefined;
  for (const r of children(buf, list.start, list.start + list.len)) {
    if (r.type === RT.slidePersist && r.len >= 4) {
      const id = buf.readUInt32LE(r.start);
      if (r.len >= 16) bySlideId.set(buf.readUInt32LE(r.start + 12), id);
      order.push(id);
      current = [];
      texts.set(id, current);
    } else if ((r.type === RT.textChars || r.type === RT.textBytes) && current) current.push(textOf(buf, r));
  }
  return { order, texts, bySlideId };
}

/** Text of a slide or notes page in drawing order: its own text boxes, and its placeholders' text from the list. */
function pageText(buf: Buffer, page: Rec, listed: string[]): string[] {
  const out: string[] = [];
  const used = new Set<number>();
  const walk = (from: number, to: number) => {
    for (const r of children(buf, from, to)) {
      if (r.type === RT.clientTextbox) {
        for (const t of children(buf, r.start, r.start + r.len)) {
          if (t.type === RT.textChars || t.type === RT.textBytes) out.push(...paragraphs(textOf(buf, t)));
          else if (t.type === RT.outlineTextRef && t.len >= 4) {
            const i = buf.readInt32LE(t.start);
            if (listed[i] !== undefined && !used.has(i)) {
              used.add(i);
              out.push(...paragraphs(listed[i]!));
            }
          }
        }
      } else if (r.ver === 0xf) walk(r.start, r.start + r.len);
    }
  };
  walk(page.start, page.start + page.len);
  // placeholder text the drawing does not point at (older writers)
  listed.forEach((t, i) => {
    if (!used.has(i)) out.push(...paragraphs(t));
  });
  return out;
}

export async function extractPpt(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  let doc: CFB.CFB$Container;
  try {
    doc = CFB.read(Buffer.from(src.bytes), { type: 'buffer' });
  } catch {
    fail('the Office container cannot be read');
  }
  if (CFB.find(doc, '/PP40')) throw new ExtractError(OLD);
  if (CFB.find(doc, '/EncryptedSummary')) throw new ExtractError(LOCKED);
  const main = CFB.find(doc, '/PowerPoint Document');
  const user = CFB.find(doc, '/Current User');
  if (!main?.content) fail('no "PowerPoint Document" stream');
  const buf = Buffer.from(main.content as Uint8Array);
  let pointed = -1;
  if (user?.content) {
    const cu = Buffer.from(user.content as Uint8Array);
    const r = header(cu, 0);
    // PowerPoint 95 writes a short "Current User" of another layout
    if (!r || r.type !== RT.currentUser || r.len < 0x14) throw new ExtractError(OLD);
    const token = cu.readUInt32LE(r.start + 4);
    if (token === 0xf3d1c4df) throw new ExtractError(LOCKED);
    if (cu.readUInt16LE(r.start + 14) !== 0x03f4) throw new ExtractError(OLD);
    pointed = cu.readUInt32LE(r.start + 8);
  }
  const { offsets, documentId } = persistDirectory(buf, newestEdit(buf, pointed));
  const docRec = header(buf, offsets.get(documentId) ?? -1);
  if (!docRec || docRec.type !== RT.document) fail('the document record is missing');

  const none = { order: [], texts: new Map(), bySlideId: new Map() };
  let slides: ReturnType<typeof listTexts> = none;
  let notes: ReturnType<typeof listTexts> = none;
  for (const r of children(buf, docRec.start, docRec.start + docRec.len)) {
    if (r.type !== RT.slideList) continue;
    if (r.instance === 0) slides = listTexts(buf, r);
    else if (r.instance === 2) notes = listTexts(buf, r);
  }
  let skipped = 0;
  const live = slides.order.filter((id) => {
    const r = header(buf, offsets.get(id) ?? -1);
    if (r?.type === RT.slide) return true;
    skipped++;
    return false;
  });

  const slide = (n: number) => {
    const id = live[n - 1]!;
    const rec = header(buf, offsets.get(id)!)!;
    const paras = pageText(buf, rec, slides.texts.get(id) ?? []);
    let noteParas: string[] = [];
    const atom = children(buf, rec.start, rec.start + rec.len).find((c) => c.type === RT.slideAtom && c.len >= 16);
    // SlideAtom.notesIdRef is the notes page's identifier in the notes list, not its object id
    const notesId = atom ? notes.bySlideId.get(buf.readUInt32LE(atom.start + 16)) : undefined;
    const notesRec = notesId ? header(buf, offsets.get(notesId) ?? -1) : undefined;
    if (notesId && notesRec?.type === RT.notes) noteParas = pageText(buf, notesRec, notes.texts.get(notesId) ?? []).filter((p) => !/^\d+$/.test(p));
    return { paras, notes: noteParas };
  };
  const note = skipped > 0 ? `[${skipped} slide${skipped === 1 ? '' : 's'} listed in the file could not be found and ${skipped === 1 ? 'is' : 'are'} left out.]` : undefined;
  return renderSlides(live.length, slide, src.metaBase('pptx'), req, maxChars, signal, note);
}
