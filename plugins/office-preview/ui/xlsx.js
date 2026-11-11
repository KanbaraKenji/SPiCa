/* global window, document */
// Excel preview: ExcelJS reads the file, sheet.js draws each sheet as a styled
// table; one tab per visible sheet.
(function () {
  'use strict';
  window.OfficePreview.run(async function (file, root) {
    var got = await window.OfficeSheet.loadWorkbook(window.ExcelJS, window.JSZip, file.bytes);
    var sheets = window.OfficeSheet.visibleSheets(got.wb);
    if (sheets.length === 0) throw new Error('里面没有能显示的工作表');
    root.replaceChildren();
    var tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');
    var notes = document.createElement('div');
    notes.className = 'notes';
    var view = document.createElement('div');
    view.className = 'view';
    root.append(tabs, notes, view);
    var open = function (i) {
      var out = window.OfficeSheet.renderSheet(sheets[i], got.wb);
      view.innerHTML = out.html;
      var all = got.notes.concat(out.notes);
      notes.textContent = all.join(' ');
      notes.hidden = all.length === 0;
      Array.prototype.forEach.call(tabs.children, function (b, j) {
        b.setAttribute('aria-selected', String(i === j));
      });
    };
    sheets.forEach(function (ws, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.textContent = ws.name;
      b.addEventListener('click', function () { open(i); });
      tabs.append(b);
    });
    tabs.hidden = sheets.length < 2;
    open(0);
  }, '这个 Excel 文件打不开');
})();
