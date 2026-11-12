/* global window, document */
// Settings page (placement "settings"): shown in Spica under 设置 › 插件 › Notes,
// below the plugin's details. 选择… opens the system's folder picker
// (window.spica.pickFolder); the path goes into the box, and 保存 saves it
// through the plugin's settings service (get_settings / save_settings,
// views/settings.json). Cancelling the picker changes nothing.
const spica = window.spica;
const $ = (id) => document.getElementById(id);
let saved = { notesFolder: '', catalogUrl: '' };

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--danger)' : '';
}

const current = () => ({ notesFolder: $('folder').value.trim(), catalogUrl: $('catalog').value.trim() });
const changed = () => {
  const c = current();
  $('save').disabled = c.notesFolder === saved.notesFolder && c.catalogUrl === saved.catalogUrl;
};

function show(s) {
  saved = { notesFolder: s.notesFolder ?? '', catalogUrl: s.catalogUrl ?? '' };
  $('folder').value = saved.notesFolder;
  $('folder').placeholder = s.defaultFolder ?? '';
  $('catalog').value = saved.catalogUrl;
  changed();
}

async function load() {
  const r = await spica.callTool('get_settings', {});
  if (r.isError) return setStatus(r.content, true);
  show(r.data ?? {});
}

$('pick').onclick = async () => {
  const dir = await spica.pickFolder({ title: '选择笔记文件夹', defaultPath: $('folder').value.trim() || undefined });
  if (dir === null) return; // cancelled: nothing changes
  $('folder').value = dir;
  setStatus('');
  changed();
};

$('folder').oninput = changed;
$('catalog').oninput = changed;

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const r = await spica.callTool('save_settings', current());
  if (r.isError) return setStatus(r.content, true);
  show(r.data ?? current());
  setStatus('已保存');
};

if (!spica) {
  document.body.textContent = '这个页面要在 Spica 里打开（设置 › 插件 › Notes）。';
} else {
  spica.onEvent?.((e) => {
    if (e.type === 'plugin.changed') void load().catch(() => {});
  });
  load().catch((err) => setStatus(err.message, true));
}
