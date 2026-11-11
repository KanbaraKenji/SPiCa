/* global window, ResizeObserver */
// Word preview: docx-preview draws the pages (fonts, colours, tables, pictures,
// headers and footers). Pictures as data URLs (useBase64URL): the page may not
// load blob: addresses.
//
// The pages are as wide as on paper (A4 is about 794 px), the right panel is
// usually narrower: the whole page is scaled down to the panel's width (never
// up), again whenever the panel changes width. CSS zoom, not a transform: the
// layout and the scroll height follow it, and text is drawn at the new size.
(function () {
  'use strict';
  var GUTTER = 32; // the wrapper's padding, both sides

  /** Scale the pages so the widest fits the page area. `natural` is their width at 100%. */
  function fit(root, natural) {
    var wrapper = root.querySelector('.docx-wrapper');
    if (!wrapper || !natural) return;
    var scale = Math.min(1, (root.clientWidth - GUTTER) / natural);
    wrapper.style.zoom = String(Math.max(0.1, scale));
  }

  var observer;
  window.OfficePreview.run(async function (file, root) {
    if (observer) observer.disconnect();
    root.replaceChildren();
    await window.docx.renderAsync(file.bytes, root, undefined, {
      useBase64URL: true,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
    });
    // measured once at 100% (zoom changes what the browser reports afterwards)
    var natural = 0;
    root.querySelectorAll('.docx-wrapper > section.docx').forEach(function (s) {
      natural = Math.max(natural, s.offsetWidth);
    });
    fit(root, natural);
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(function () {
        fit(root, natural);
      });
      observer.observe(root);
    }
  }, '这个 Word 文件打不开');
})();
