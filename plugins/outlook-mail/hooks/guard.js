// Keeps save_attachments inside the project folder.
//
// The MCP server cannot know which project a session works in; the hook can
// (ctx.session.cwd is the session's working folder, which is the project
// folder for a project manager). So before the call reaches the server:
//   - dest_folder is resolved against the project folder (default "attachments")
//   - anything outside the project folder or the plugin's data folder is refused
//   - overwrite: true asks the user first (the server never overwrites otherwise)

import { isAbsolute, relative, resolve } from 'node:path';

const inside = (root, p) => {
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = relative(norm(resolve(root)), norm(resolve(p)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** @type {import('@spica/plugins/types').HookModule} */
export default (ctx) => ({
  beforeTool(call, hctx) {
    if (call.name !== `${ctx.name}__save_attachments`) return;
    const input = call.input && typeof call.input === 'object' ? { ...call.input } : {};
    const cwd = hctx?.session?.cwd;
    if (!cwd) {
      return { action: 'deny', reason: '[PATH_NOT_ALLOWED] 这个会话没有项目文件夹，附件无处可存。' };
    }
    const raw = typeof input.dest_folder === 'string' && input.dest_folder.trim() ? input.dest_folder.trim() : 'attachments';
    const dest = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    if (!inside(cwd, dest) && !inside(ctx.dataDir, dest)) {
      return { action: 'deny', reason: `[PATH_NOT_ALLOWED] 附件只能存到项目文件夹（${cwd}）里，「${raw}」在它外面。` };
    }
    input.dest_folder = dest;
    if (input.overwrite === true) {
      return { action: 'confirm', reason: '会覆盖项目文件夹里同名的文件', input };
    }
    return { action: 'allow', input };
  },
});

export const priority = 20;
