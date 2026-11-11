/* global self */
// Excel workbook -> HTML that keeps what a reader sees: fills, font colour and
// style, borders, alignment, merged cells, column widths, row heights, number
// formats and pictures. No page needed (it returns strings), so it runs in
// tests too. In the page it is window.OfficeSheet; in Node, module.exports.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OfficeSheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** What a sheet shows at most (a bigger one says so). */
  var LIMITS = { rows: 2000, cols: 200 };

  /**
   * Read the file. ExcelJS fails on some files with pictures (written by
   * openpyxl, without the drawing prefix); then the pictures are taken out and
   * the rest is read, with a note.
   */
  async function loadWorkbook(ExcelJS, JSZip, bytes) {
    var notes = [];
    var wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes);
      return { wb: wb, notes: notes };
    } catch (first) {
      var stripped = await withoutDrawings(JSZip, bytes);
      if (!stripped) throw first;
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(stripped);
      notes.push('这个文件里的图片读不出来，没有显示；表格照常显示。');
      return { wb: wb, notes: notes };
    }
  }

  /** The same workbook without its drawings (pictures, shapes), or undefined when it has none. */
  async function withoutDrawings(JSZip, bytes) {
    var zip = await JSZip.loadAsync(bytes);
    var drawings = Object.keys(zip.files).filter(function (n) { return /^xl\/drawings\//.test(n); });
    if (drawings.length === 0) return undefined;
    drawings.forEach(function (n) { zip.remove(n); });
    var sheets = Object.keys(zip.files).filter(function (n) { return /^xl\/worksheets\/[^/]+\.xml$/.test(n); });
    for (var i = 0; i < sheets.length; i++) {
      var xml = await zip.file(sheets[i]).async('string');
      zip.file(sheets[i], xml.replace(/<(\w+:)?drawing\b[^>]*\/>/g, ''));
    }
    var rels = Object.keys(zip.files).filter(function (n) { return /^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(n); });
    for (var j = 0; j < rels.length; j++) {
      var r = await zip.file(rels[j]).async('string');
      zip.file(rels[j], r.replace(/<Relationship\b[^>]*Target="[^"]*drawings\/[^"]*"[^>]*\/>/g, ''));
    }
    var types = zip.file('[Content_Types].xml');
    if (types) {
      var t = await types.async('string');
      zip.file('[Content_Types].xml', t.replace(/<Override\b[^>]*PartName="\/xl\/drawings\/[^"]*"[^>]*\/>/g, ''));
    }
    return zip.generateAsync({ type: 'uint8array' });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** An ARGB / RGB colour as #rrggbb; openpyxl writes 00 as the alpha, which Excel ignores too. */
  function color(c) {
    if (!c || typeof c.argb !== 'string') return undefined;
    var hex = c.argb.length === 8 ? c.argb.slice(2) : c.argb;
    return /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex.toLowerCase() : undefined;
  }

  var BORDER = { thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', mediumDashed: '2px dashed', dotted: '1px dotted', double: '3px double', dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dotted', mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed' };

  function cellCss(cell, numeric, notes) {
    var css = [];
    var f = cell.font || {};
    if (f.bold) css.push('font-weight:700');
    if (f.italic) css.push('font-style:italic');
    var deco = [];
    if (f.underline) deco.push('underline');
    if (f.strike) deco.push('line-through');
    if (deco.length) css.push('text-decoration:' + deco.join(' '));
    if (f.size) css.push('font-size:' + f.size + 'pt');
    if (f.name) css.push('font-family:"' + esc(f.name) + '",var(--spica-font, sans-serif)');
    var fc = color(f.color);
    if (fc) css.push('color:' + fc);
    else if (f.color && f.color.theme !== undefined) notes.theme = true;
    var fill = cell.fill;
    if (fill && fill.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
      var bg = color(fill.fgColor) || color(fill.bgColor);
      if (bg) css.push('background:' + bg);
      else if (fill.fgColor && fill.fgColor.theme !== undefined) notes.theme = true;
    }
    var a = cell.alignment || {};
    var h = a.horizontal || (numeric ? 'right' : undefined);
    if (h === 'centerContinuous') h = 'center';
    if (h && h !== 'general' && h !== 'fill' && h !== 'distributed') css.push('text-align:' + h);
    if (a.vertical) css.push('vertical-align:' + (a.vertical === 'middle' || a.vertical === 'center' ? 'middle' : a.vertical === 'top' ? 'top' : 'bottom'));
    if (a.wrapText) css.push('white-space:pre-wrap');
    if (a.indent) css.push('padding-left:' + (4 + a.indent * 9) + 'px');
    var b = cell.border || {};
    ['top', 'right', 'bottom', 'left'].forEach(function (side) {
      var s = b[side];
      if (s && s.style && BORDER[s.style]) css.push('border-' + side + ':' + BORDER[s.style] + ' ' + (color(s.color) || '#000'));
    });
    return css.join(';');
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /** The text Excel would show for a value with its number format (the common formats; others plainly). */
  function formatValue(value, numFmt) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
      var d = value;
      var day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
      var hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || /h|s/i.test(String(numFmt || '').replace(/"[^"]*"/g, ''));
      return hasTime ? day + ' ' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) : day;
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.richText)) return value.richText.map(function (r) { return r.text; }).join('');
      if ('result' in value) return formatValue(value.result, numFmt);
      if ('text' in value) return String(value.text);
      if ('error' in value) return String(value.error);
      return '';
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value !== 'number') return String(value);
    var fmt = String(numFmt || 'General').split(';')[0];
    var plain = fmt.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '');
    if (/^general$/i.test(plain.trim())) return String(Number(value.toPrecision(11)));
    var percent = plain.indexOf('%') >= 0;
    var n = percent ? value * 100 : value;
    var dec = /\.(0+)/.exec(plain);
    var places = dec ? dec[1].length : 0;
    if (!/[0#]/.test(plain)) return String(value);
    var parts = Math.abs(n).toFixed(places).split('.');
    if (plain.indexOf(',') >= 0) parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var lit = /^"([^"]*)"/.exec(fmt);
    return (n < 0 ? '-' : '') + (lit ? lit[1] : '') + parts.join('.') + (percent ? '%' : '');
  }

  function colLetters(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function parseRef(ref) {
    var m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return undefined;
    var c = 0;
    for (var i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
    return { col: c, row: Number(m[2]) };
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /**
   * One sheet as HTML: a table (with column widths and row heights) and the
   * pictures placed over it. `notes` gathers what could not be shown.
   */
  function renderSheet(ws, wb, limits) {
    limits = limits || LIMITS;
    var notes = [];
    var flags = {};
    var rowCount = Math.min(ws.rowCount || 0, limits.rows);
    var colCount = Math.min(ws.columnCount || 0, limits.cols);
    if ((ws.rowCount || 0) > limits.rows) notes.push('只显示前 ' + limits.rows + ' 行。');
    if ((ws.columnCount || 0) > limits.cols) notes.push('只显示前 ' + limits.cols + ' 列。');
    // merged ranges: the top-left cell spans, the others are left out
    var span = {};
    var covered = {};
    (ws.model && ws.model.merges ? ws.model.merges : []).forEach(function (range) {
      var ends = String(range).split(':').map(parseRef);
      if (!ends[0] || !ends[1]) return;
      var r0 = Math.min(ends[0].row, ends[1].row), r1 = Math.max(ends[0].row, ends[1].row);
      var c0 = Math.min(ends[0].col, ends[1].col), c1 = Math.max(ends[0].col, ends[1].col);
      span[r0 + ':' + c0] = { rows: r1 - r0 + 1, cols: c1 - c0 + 1 };
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered[r + ':' + c] = true;
    });
    var widths = [];
    var cols = '<colgroup><col class="rowhead">';
    for (var c = 1; c <= colCount; c++) {
      var column = ws.getColumn(c);
      var w = column.hidden ? 0 : Math.round((column.width || 8.43) * 7 + 5);
      widths.push(w);
      cols += '<col style="width:' + w + 'px">';
    }
    cols += '</colgroup>';
    var head = '<tr class="colhead"><th></th>';
    for (var hc = 1; hc <= colCount; hc++) head += widths[hc - 1] ? '<th>' + colLetters(hc) + '</th>' : '<th class="hidden"></th>';
    head += '</tr>';
    var heights = [];
    var body = '';
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      var hpx = row.hidden ? 0 : Math.round((row.height || 15) * 4 / 3);
      heights.push(hpx);
      if (row.hidden) continue;
      body += '<tr style="height:' + hpx + 'px"><th>' + r + '</th>';
      for (var cc = 1; cc <= colCount; cc++) {
        if (covered[r + ':' + cc]) continue;
        if (!widths[cc - 1]) { body += '<td class="hidden"></td>'; continue; }
        var cell = row.getCell(cc);
        var v = cell.value;
        var shown = v && typeof v === 'object' && 'result' in v ? v.result : v;
        var numeric = typeof shown === 'number' || shown instanceof Date;
        var text = formatValue(v, cell.numFmt);
        var sp = span[r + ':' + cc];
        var attrs = sp ? (sp.rows > 1 ? ' rowspan="' + sp.rows + '"' : '') + (sp.cols > 1 ? ' colspan="' + sp.cols + '"' : '') : '';
        var css = cellCss(cell, numeric, flags);
        body += '<td' + attrs + (css ? ' style="' + css + '"' : '') + '>' + esc(text) + '</td>';
      }
      body += '</tr>';
    }
    // pictures, placed by their top-left cell (and offset within it)
    var pics = '';
    var images = typeof ws.getImages === 'function' ? ws.getImages() : [];
    images.forEach(function (img) {
      var media = wb.getImage(Number(img.imageId));
      var tl = img.range && img.range.tl;
      if (!media || !tl) return;
      var data = media.base64 ? String(media.base64).replace(/^data:[^,]*,/, '') : media.buffer ? toBase64(media.buffer) : undefined;
      if (!data) return;
      var at = function (list, pos, head0) {
        var whole = Math.floor(pos);
        var x = head0;
        for (var i = 0; i < whole && i < list.length; i++) x += list[i];
        return x + (list[whole] || 0) * (pos - whole);
      };
      // tl.col / tl.row: the anchor's cell as a fraction (offset within the cell included), from 0
      var left = at(widths, tl.col || 0, 40);
      var top = at(heights, tl.row || 0, 22);
      var ext = img.range.ext;
      var br = img.range.br;
      var w = ext && ext.width ? ext.width : br ? at(widths, br.col, 40) - left : 120;
      var h = ext && ext.height ? ext.height : br ? at(heights, br.row, 22) - top : 80;
      var type = media.extension === 'jpg' ? 'jpeg' : media.extension || 'png';
      pics += '<img class="pic" alt="" src="data:image/' + esc(type) + ';base64,' + data + '" style="left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px;width:' + Math.round(w) + 'px;height:' + Math.round(h) + 'px">';
    });
    if (flags.theme) notes.push('用了主题色的格子按默认色显示。');
    var html = '<div class="sheet-wrap"><table class="sheet">' + cols + head + body + '</table>' + pics + '</div>';
    return { html: html, notes: notes };
  }

  /** The sheets a reader sees (hidden ones left out), in order. */
  function visibleSheets(wb) {
    return wb.worksheets.filter(function (ws) { return ws.state !== 'hidden' && ws.state !== 'veryHidden'; });
  }

  return { LIMITS: LIMITS, loadWorkbook: loadWorkbook, withoutDrawings: withoutDrawings, renderSheet: renderSheet, visibleSheets: visibleSheets, formatValue: formatValue, color: color };
});
