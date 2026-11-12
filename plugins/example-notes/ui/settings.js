/* global window, document */
// Settings page (placement "settings"): in Spica under 设置 › 插件 › Notes, the
// 设定 tab next to 详情. The notes folder is shown as its path, and the path is
// the way to it: pressed (or Enter on it), it opens in Explorer
// (window.spica.openFolder). The one in use is shown: the chosen one, else the
// plugin's default; none at all, —. The pencil opens the system's folder
// picker (window.spica.pickFolder); 恢复默认 (only while one was chosen) goes
// back to the default. 保存 saves through the plugin's settings service
// (get_settings / save_settings, views/settings.json). Cancelling the picker
// changes nothing.
const spica = window.spica;
const $ = (id) => document.getElementById(id);
let saved = { notesFolder: '', catalogUrl: '' };
let folder = ''; // chosen, not yet saved maybe; '' = the default
let defaultFolder = '';

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--danger)' : '';
}

const current = () => ({ notesFolder: folder, catalogUrl: $('catalog').value.trim() });
const changed = () => {
  const c = current();
  $('save').disabled = c.notesFolder === saved.notesFolder && c.catalogUrl === saved.catalogUrl;
  const inUse = folder || defaultFolder;
  const open = $('open');
  open.textContent = inUse || '—';
  open.disabled = !inUse;
  open.title = inUse ? `打开文件夹：${inUse}` : '';
  if (inUse) open.setAttribute('aria-label', `打开文件夹：${inUse}`);
  else open.removeAttribute('aria-label');
  $('reset').hidden = !folder;
};

function show(s) {
  saved = { notesFolder: s.notesFolder ?? '', catalogUrl: s.catalogUrl ?? '' };
  folder = saved.notesFolder;
  defaultFolder = s.defaultFolder ?? '';
  $('catalog').value = saved.catalogUrl;
  changed();
}

async function load() {
  const r = await spica.callTool('get_settings', {});
  if (r.isError) return setStatus(r.content, true);
  show(r.data ?? {});
}

$('pick').onclick = async () => {
  const dir = await spica.pickFolder({ title: '选择笔记文件夹', defaultPath: folder || defaultFolder || undefined });
  if (dir === null) return; // cancelled: nothing changes
  folder = dir;
  setStatus('');
  changed();
};

$('open').onclick = async () => {
  try {
    await spica.openFolder(folder || defaultFolder);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true); // e.g. 找不到文件夹：… (not created yet, or typed wrong)
  }
};

$('reset').onclick = () => {
  folder = '';
  setStatus('');
  changed();
};
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
