/* global window, document */
// What both preview pages share: get the file from Spica (window.spica.preview),
// say when it is drawn or why it cannot be, and draw again when the user opens
// another file. Opened on its own (a browser, for development) there is no
// bridge: a file picker stands in, and errors are shown on the page.
(function () {
  'use strict';

  function message(err) {
    return err && err.message ? err.message : String(err);
  }

  /** run(draw, failText): draw(file, root) puts the file into root; failText starts the line Spica shows when it cannot. */
  window.OfficePreview = {
    run: function (draw, failText) {
      var bridge = window.spica && window.spica.preview;
      var root = document.getElementById('doc');
      var status = document.getElementById('status');
      var show = async function (file) {
        status.hidden = false;
        status.textContent = '正在打开 ' + file.name + '…';
        try {
          await draw(file, root);
          status.hidden = true;
          if (bridge) bridge.ready();
        } catch (err) {
          var text = failText + '：' + message(err);
          if (bridge) bridge.fail(text);
          else status.textContent = text;
        }
      };
      if (bridge) {
        bridge.file().then(show, function (err) { bridge.fail(failText + '：' + message(err)); });
        window.spica.onEvent(function (e) {
          if (e && e.type === 'preview.file') bridge.file().then(show);
        });
        return;
      }
      // on its own: pick a file
      var pick = document.createElement('input');
      pick.type = 'file';
      pick.className = 'pick';
      pick.addEventListener('change', function () {
        var f = pick.files && pick.files[0];
        if (!f) return;
        f.arrayBuffer().then(function (bytes) {
          show({ name: f.name, size: f.size, modifiedAt: new Date(f.lastModified).toISOString(), extension: (/\.[^.]+$/.exec(f.name) || [''])[0].toLowerCase(), bytes: bytes });
        });
      });
      status.textContent = '在 Spica 外打开：选一个文件来看效果。';
      status.after(pick);
    },
  };
})();
