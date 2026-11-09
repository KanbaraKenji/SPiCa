/* global window, document */
// Notebook page. Runs in Spica's plugin sandbox: no Node, only files of this
// plugin, only the tools listed in views/notebook.json. Everything goes
// through window.spica, which Spica injects.
const spica = window.spica;
const $ = (id) => document.getElementById(id);
let current = null;

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? 'var(--danger)' : '';
}

/** Call a tool of this plugin; returns its text, throws with the tool's message on errors. */
async function tool(name, args = {}) {
  const r = await spica.callTool(name, args);
  if (r.isError) throw new Error(r.content);
  return r.content;
}

async function refresh() {
  // list_notes answers "- <title> (<n> characters)" per line, or a sentence when empty.
  const text = await tool('list_notes');
  const titles = text.split('\n').map((l) => /^- (.+) \(\d+ characters\)$/.exec(l)?.[1]).filter(Boolean);
  const ul = $('notes');
  ul.replaceChildren(
    ...titles.map((t) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.setAttribute('aria-current', String(t === current));
      b.onclick = () => open(t);
      li.append(b);
      return li;
    }),
  );
  $('empty').hidden = titles.length > 0;
}

async function open(title) {
  try {
    $('text').value = await tool('read_note', { title });
    $('title').value = title;
    current = title;
    setStatus('');
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  }
}

$('new').onclick = () => {
  current = null;
  $('title').value = '';
  $('text').value = '';
  $('title').focus();
  void refresh();
};

$('save').onclick = async () => {
  const title = $('title').value.trim();
  if (!title) return setStatus('先写一个标题。', true);
  try {
    await tool('write_note', { title, text: $('text').value, replace: true });
    current = title;
    setStatus('已保存');
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  }
};

$('delete').onclick = async () => {
  if (!current) return setStatus('先在左边选一条笔记。', true);
  try {
    // delete_note is irreversible: Spica asks the user before it runs.
    await tool('delete_note', { title: current });
    current = null;
    $('title').value = '';
    $('text').value = '';
    setStatus('已删除');
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  }
};

if (!spica) {
  document.body.textContent = '这个页面要在 Spica 里打开（设置 › 插件 › 启用「Notes」后，在侧栏点 Notebook）。';
} else {
  spica.onEvent?.((e) => {
    if (e.type === 'plugin.changed') void refresh().catch(() => {});
  });
  refresh().catch((err) => setStatus(err.message, true));
}
