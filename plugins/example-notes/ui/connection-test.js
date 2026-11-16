/* global window, document */
// 测试连接 (placement "settings": a tab after 详情 under 设置 › 插件 › Notes).
// The notes folder and the catalog address are in the settings form Spica draws
// from manifest.json · user_config; this page only does what a form cannot: it
// tries the address once (test_connection, services/connection-test.json) and
// says how it went. It stores nothing.
const spica = window.spica;
const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--danger)' : '';
}

if (!spica) {
  document.body.textContent = '这个页面要在 Spica 里打开（设置 › 插件 › Notes）。';
} else {
  $('test').onclick = async () => {
    $('test').disabled = true;
    setStatus('');
    try {
      const r = await spica.callTool('test_connection', {});
      setStatus(r.content.replace(/^\[[A-Z_]+\] /, ''), r.isError);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      $('test').disabled = false;
    }
  };
}
