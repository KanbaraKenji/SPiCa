// Sample files for tests and the smoke script. All content is fictional and generic.
// DOCX via `docx`, XLSX via `write-excel-file`, PDF via `pdf-lib`; PPTX is assembled by hand (fflate)
// because the only maintained PPTX writer pulls in a dependency with open advisories.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import writeXlsxFile, { type CellObject, type SheetData } from 'write-excel-file/node';
import { strToU8, zipSync } from 'fflate';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, beginText, endText, moveText, setFontAndSize, showText, type PDFPage, type PDFRef } from 'pdf-lib';

// ---------------------------------------------------------------- PDF

/**
 * A Type0 font with Identity-H encoding and a ToUnicode map, not embedded: glyph
 * codes are the Unicode code points, so any BMP text (Chinese included) has a real
 * text layer without shipping a font file.
 */
function unicodeFont(doc: PDFDocument, text: string): PDFRef {
  const ctx = doc.context;
  const chars = [...new Set([...text])].filter((c) => c.codePointAt(0)! <= 0xffff).sort();
  const hex = (c: string) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 100) {
    const part = chars.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map((c) => `<${hex(c)}> <${hex(c)}>`).join('\n')}\nendbfchar`);
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const toUnicode = ctx.register(ctx.stream(cmap));
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'SampleSans',
      Flags: 4,
      FontBBox: [0, -200, 1000, 900],
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -120,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const cid = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'SampleSans',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
    }),
  );
  return ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'SampleSans', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUnicode }),
  );
}

function drawLines(page: PDFPage, font: PDFRef, lines: string[]): void {
  page.node.setFontDictionary(PDFName.of('U1'), font);
  let y = 780;
  for (const line of lines) {
    const hex = [...line].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('');
    page.pushOperators(beginText(), setFontAndSize('U1', 12), moveText(50, y), showText(PDFHexString.of(hex)), endText());
    y -= 20;
  }
}

/** Pages of text lines; returns PDF bytes. */
export async function makePdf(pages: string[][], opts: { outline?: { title: string; page: number }[] } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = unicodeFont(doc, pages.flat().join(''));
  const refs: PDFRef[] = [];
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    drawLines(page, font, lines);
    refs.push(page.ref);
  }
  if (opts.outline?.length) {
    const ctx = doc.context;
    const outlineRef = ctx.nextRef();
    const itemRefs = opts.outline.map(() => ctx.nextRef());
    opts.outline.forEach((o, i) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(o.title),
        Parent: outlineRef,
        Dest: [refs[o.page - 1]!, 'Fit'],
        ...(i > 0 ? { Prev: itemRefs[i - 1]! } : {}),
        ...(i < itemRefs.length - 1 ? { Next: itemRefs[i + 1]! } : {}),
      });
      ctx.assign(itemRefs[i]!, dict);
    });
    ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: itemRefs[0]!, Last: itemRefs.at(-1)!, Count: PDFNumber.of(itemRefs.length) }));
    doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  }
  return doc.save();
}

/** A small grey PNG: a "scan" with no text layer. */
function greyPng(w = 8, h = 8): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x99);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // filter byte
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

export async function makeScannedPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(greyPng());
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save();
}

// ---------------------------------------------------------------- DOCX

export interface DocxSpec {
  title: string;
  sections: { heading: string; paragraphs: string[]; bullets?: string[]; table?: string[][] }[];
}

export async function makeDocx(spec: DocxSpec): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: spec.title, heading: HeadingLevel.HEADING_1 })];
  for (const s of spec.sections) {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_2 }));
    for (const p of s.paragraphs) children.push(new Paragraph({ children: [new TextRun(p)] }));
    for (const b of s.bullets ?? []) children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
    if (s.table) {
      children.push(
        new Table({
          rows: s.table.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
        }),
      );
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// ---------------------------------------------------------------- XLSX

export async function makeInventoryXlsx(extraRows = 0): Promise<Uint8Array> {
  const date = (v: Date, format = 'yyyy-mm-dd'): CellObject => ({ value: v, type: Date, format });
  const pct = (v: number): CellObject => ({ value: v, type: Number, format: '0%' });
  const inv: SheetData = [['品名', '规格', '数量', '单价（元）', '入库日期', '占比']];
  const items: [string, string, number, number, Date, number][] = [
    ['便携显示器', '15.6 英寸', 20, 899, new Date(Date.UTC(2026, 9, 12)), 0.25],
    ['无线键盘', '静音款', 150, 129, new Date(Date.UTC(2026, 9, 15)), 0.3],
    ['USB-C 扩展坞', '七合一', 60, 239, new Date(Date.UTC(2026, 9, 20)), 0.15],
    ['降噪耳机', '头戴式', 35, 459, new Date(Date.UTC(2026, 10, 2)), 0.2],
    ['桌面支架', '铝合金', 80, 89.5, new Date(Date.UTC(2026, 10, 5)), 0.1],
  ];
  for (const [a, b, c, d, e, f] of items) inv.push([a, b, c, d, date(e), pct(f)]);
  for (let i = 0; i < extraRows; i++) {
    inv.push([`配件 ${i + 1}`, `型号 S-${1000 + i}`, (i * 7) % 300, 10 + (i % 90), date(new Date(Date.UTC(2026, 0, 1 + (i % 300)))), pct((i % 100) / 100)]);
  }
  inv.push(['合计', null, items.reduce((a, r) => a + r[2], 0)]);
  const log: SheetData = [
    ['日期', '供应商', '品名', '数量'],
    [date(new Date(Date.UTC(2026, 9, 12, 14, 30)), 'yyyy-mm-dd hh:mm'), '示例供应商甲', '便携显示器', 20],
    [date(new Date(Date.UTC(2026, 9, 15, 9, 0)), 'yyyy-mm-dd hh:mm'), '示例供应商乙', '无线键盘', 150],
  ];
  const note: SheetData = [['本表为虚构示例数据，仅用于测试。'], [], [null, true]];
  const buf = await writeXlsxFile([
    { sheet: '库存', data: inv },
    { sheet: '进货记录', data: log },
    { sheet: '空白页', data: [[null]] },
    { sheet: '说明', data: note },
  ]).toBuffer();
  return new Uint8Array(buf);
}

/** Several sheets of many rows, for the chunking tests. */
export async function makeBigXlsx(sheets: number, rows: number): Promise<Uint8Array> {
  const all = Array.from({ length: sheets }, (_, k) => {
    const s = k + 1;
    const data: SheetData = [['编号', '品名', '数量', '备注']];
    for (let i = 1; i <= rows; i++) data.push([i, `示例商品 ${s}-${i}`, (i * 13) % 500, `第 ${s} 表第 ${i} 行的备注文字`]);
    return { sheet: `月份${s}`, data };
  });
  return new Uint8Array(await writeXlsxFile(all).toBuffer());
}

// ---------------------------------------------------------------- PPTX

const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function shapeXml(id: number, paras: string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras
    .map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;
}

function tableXml(rows: string[][]): string {
  const tr = rows
    .map((r) => `<a:tr h="300">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`)
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="99" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

export interface SlideSpec {
  title: string;
  body?: string[];
  table?: string[][];
  notes?: string;
}

export function makePptx(slides: SlideSpec[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, xml: string) => {
    files[name] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`);
  };
  const ct = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    ...slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
    ...slides.flatMap((s, i) => (s.notes ? [`<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`] : [])),
  ];
  put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join('')}</Types>`);
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  put('ppt/presentation.xml', `<p:presentation ${NS_P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  put('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    const n = i + 1;
    const shapes = shapeXml(2, [s.title]) + (s.body?.length ? shapeXml(3, s.body) : '') + (s.table ? tableXml(s.table) : '');
    put(`ppt/slides/slide${n}.xml`, `<p:sld ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`);
    if (s.notes) {
      put(`ppt/slides/_rels/slide${n}.xml.rels`, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`);
      put(`ppt/notesSlides/notesSlide${n}.xml`, `<p:notes ${NS_P}><p:cSld><p:spTree>${shapeXml(2, [String(n)])}${shapeXml(3, [s.notes])}</p:spTree></p:cSld></p:notes>`);
    }
  });
  return zipSync(files);
}

// ---------------------------------------------------------------- text

/** GBK bytes for a string (Node has a GBK decoder but no encoder; build one from the decoder). */
let gbkTable: Map<string, number[]> | undefined;
export function encodeGbk(text: string): Uint8Array {
  if (!gbkTable) {
    gbkTable = new Map();
    const dec = new TextDecoder('gbk');
    for (let hi = 0x81; hi <= 0xfe; hi++) {
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue;
        const ch = dec.decode(Uint8Array.of(hi, lo));
        if (ch.length === 1 && ch !== '�' && !gbkTable.has(ch)) gbkTable.set(ch, [hi, lo]);
      }
    }
  }
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else {
      const b = gbkTable.get(ch);
      if (!b) throw new Error(`not encodable in GBK: ${ch}`);
      out.push(...b);
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- sample folder

export const QUOTE_PAGES: string[][] = [
  ['产品报价单 Quotation', '报价编号：Q-2026-0117', '客户：示例客户', '1. 便携显示器 15.6 英寸  单价 899 元  数量 20', '2. 无线键盘 静音款  单价 129 元  数量 150', '合计：36,330 元（含税）'],
  ['付款与交付', '付款方式：预付 30%，发货前付清余款。', '交货期：收到预付款后 15 个工作日内发货。', '报价有效期：至 2026-12-31。'],
];

export const MINUTES: DocxSpec = {
  title: '周例会会议纪要',
  sections: [
    {
      heading: '一、会议信息',
      paragraphs: ['时间：2026 年 11 月 3 日 14:00–15:00', '地点：三楼会议室（线上同步）', '参会：示例团队全体成员'],
    },
    {
      heading: '二、讨论事项',
      paragraphs: ['新版官网首页改版方案初稿已完成，大家对配色意见不一，下周再定。'],
      bullets: ['库存表格式统一为每周一更新', '报价单模板增加有效期一栏'],
    },
    {
      heading: '三、待办',
      paragraphs: ['以下事项下周例会前完成：'],
      table: [
        ['事项', '负责人', '截止日期'],
        ['整理首页改版意见', '小王', '11 月 7 日'],
        ['更新报价单模板', '小李', '11 月 6 日'],
      ],
    },
  ],
};

export const WEEKLY_SLIDES: SlideSpec[] = [
  { title: '项目周报', body: ['第 45 周', '示例项目组'], notes: '开场先说明本周整体进度正常。' },
  { title: '本周完成', body: ['首页改版初稿', '库存表模板统一'] },
  { title: '下周计划', table: [['事项', '负责人'], ['确定配色', '小王'], ['上线新模板', '小李']], notes: '配色需要下周例会拍板。' },
];

export const SALES_CSV = '门店,日期,销售额（元）,备注\n一号店,2026-11-01,12800,"周末促销, 客流较多"\n二号店,2026-11-01,9650,\n三号店,2026-11-01,7420,"新店试营业"\n';
export const MEMO_TXT = '备忘录\r\n1. 周五前把报价单发给示例客户。\r\n2. 库存表每周一更新。\r\n';
export const README_MD = '# 样例文件夹说明\n\n这里的文件都是虚构的通用示例，用来测试文件读取。\n';

/** Write the everyday samples (and optionally the big ones) into `dir`; returns the file paths. */
export async function writeSamples(dir: string, opts: { big?: boolean } = {}): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: [string, Uint8Array | string][] = [
    ['报价单.pdf', await makePdf(QUOTE_PAGES, { outline: [{ title: '报价明细', page: 1 }, { title: '付款与交付', page: 2 }] })],
    ['扫描件.pdf', await makeScannedPdf()],
    ['会议纪要.docx', await makeDocx(MINUTES)],
    ['库存表.xlsx', await makeInventoryXlsx()],
    ['项目周报.pptx', makePptx(WEEKLY_SLIDES)],
    ['门店销售.csv', encodeGbk(SALES_CSV)],
    ['备忘.txt', encodeGbk(MEMO_TXT)],
    ['说明.md', README_MD],
  ];
  if (opts.big) {
    files.push(
      ['大报告.pdf', await makePdf(Array.from({ length: 300 }, (_, p) => Array.from({ length: 30 }, (_, l) => `第 ${p + 1} 页第 ${l + 1} 行：这是用于测试分块的示例正文，内容为虚构。`)))],
      ['长纪要.docx', await makeDocx({ title: '年度会议纪要汇编', sections: Array.from({ length: 200 }, (_, s) => ({ heading: `第 ${s + 1} 次会议`, paragraphs: Array.from({ length: 10 }, (_, k) => `第 ${s + 1} 次会议第 ${k + 1} 段：示例讨论内容，用于测试按段分块。`) })) })],
      ['大库存.xlsx', await makeBigXlsx(3, 20_000)],
      ['大周报.pptx', makePptx(Array.from({ length: 200 }, (_, i) => ({ title: `第 ${i + 1} 页`, body: Array.from({ length: 20 }, (_, k) => `第 ${i + 1} 页要点 ${k + 1}：虚构的示例要点文字`) })))],
      ['大流水.csv', `编号,门店,金额\n${Array.from({ length: 50_000 }, (_, i) => `${i + 1},示例门店${i % 20},${(i * 37) % 10000}`).join('\n')}\n`],
    );
  }
  const paths: string[] = [];
  for (const [name, data] of files) {
    const p = join(dir, name);
    await writeFile(p, data);
    paths.push(p);
  }
  return paths;
}
