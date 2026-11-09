/* global window, document */
// "Quick note" panel: sits beside the conversation (placement "panel") and
// appends lines to the note "Inbox". Allowed tools: read_note, write_note
// (views/quick-note.json).
const spica = window.spica;
const $ = (id) => document.getElementById(id);
const INBOX = 'Inbox';

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--danger)' : '';
}

async function load() {
  const r = await spica.callTool('read_note', { title: INBOX });
  // A missing note is not an error for this panel: it just has nothing yet.
  $('inbox').textContent = r.isError ? '还没有记过。' : r.content.trim();
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('line').value.trim();
  if (!text) return setStatus('先写点什么。', true);
  const r = await spica.callTool('write_note', { title: INBOX, text });
  if (r.isError) return setStatus(r.content, true);
  $('line').value = '';
  setStatus('已记下');
  await load();
};

if (!spica) {
  document.body.textContent = '这个面板要在 Spica 里打开（启用「Notes」后，在对话右侧的面板里）。';
} else {
  spica.onEvent?.((e) => {
    if (e.type === 'plugin.changed') void load().catch(() => {});
  });
  load().catch((err) => setStatus(err.message, true));
}
