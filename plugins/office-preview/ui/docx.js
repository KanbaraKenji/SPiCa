/* global window */
// Word preview: docx-preview draws the pages (fonts, colours, tables, pictures,
// headers and footers). Pictures as data URLs (useBase64URL): the page may not
// load blob: addresses.
(function () {
  'use strict';
  window.OfficePreview.run(async function (file, root) {
    root.replaceChildren();
    await window.docx.renderAsync(file.bytes, root, undefined, {
      useBase64URL: true,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
    });
  }, '这个 Word 文件打不开');
})();
