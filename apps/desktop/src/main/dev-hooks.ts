// Development-only answers for the system pickers, so test scripts never drive a
// Windows dialog: SPICA_PICK_FOLDER=<dir> and SPICA_PICK_FILES=<a;b>. Never in an
// installed build, whatever the environment says.

/** The folder the picker answers without showing; null: show the dialog. */
export function pickedFolder(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged) return null;
  return env.SPICA_PICK_FOLDER || null;
}

/** The files the picker answers without showing (;-separated, at most 20); null: show the dialog. */
export function pickedFiles(env: NodeJS.ProcessEnv, packaged: boolean): string[] | null {
  if (packaged || !env.SPICA_PICK_FILES) return null;
  return env.SPICA_PICK_FILES.split(';').filter(Boolean).slice(0, 20);
}

/**
 * SPICA_RECORD_SHELL=<file> (development only): what would open in Explorer (打开所在文件夹, a folder path in an
 * answer) is written to this file, one JSON line each, instead of opening a window on the screen; test scripts
 * read it back. null: open for real (always in an installed build).
 */
export function recordShellTo(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged) return null;
  return env.SPICA_RECORD_SHELL || null;
}

/**
 * SPICA_MOCK_WEB=<folder> (development only): pictures on the web for screenshots without the network.
 * null: https as usual (always in an installed build).
 */
export function mockWebFolder(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged) return null;
  return env.SPICA_MOCK_WEB || null;
}

/** One line of the SPICA_RECORD_SHELL file. */
export function shellRecord(op: 'showInFolder' | 'openFolder', path: string): string {
  return `${JSON.stringify({ op, path })}\n`;
}

/**
 * Where 文档 is for a development run on another settings folder (SPICA_USER_DATA, or the screenshots' own):
 * a Documents folder inside it, so the default workflow folder, the export's default place and the folder
 * conversations shared up to 0.1.0-rc.2 never point into the developer's own 文档. null: the system's.
 * An installed build keeps the system's even with SPICA_USER_DATA (a test install upgraded over rc.2 data
 * must still see that shared folder).
 */
export function documentsFolder(env: NodeJS.ProcessEnv, packaged: boolean, automated: boolean, userData: string): string | null {
  if (packaged || !(env.SPICA_USER_DATA || automated)) return null;
  const sep = userData.includes('\\') ? '\\' : '/';
  return `${userData.replace(/[\\/]+$/, '')}${sep}Documents`;
}

/**
 * Whether to make the default workflow folder (文档\<name>\workflows) when the app starts. An installed build
 * makes it so it is there to find and edit, unless another folder is set in 设置 › 常规; a development run
 * never does (it is made when 打开文件夹 is clicked).
 */
export function makeWorkflowsDirAtStart(packaged: boolean, chosenDir: string): boolean {
  return packaged && !chosenDir;
}

/**
 * A development-only switch: its value in a development build, nothing in an installed one, whatever the
 * environment says. SPICA_BACKEND (the demo backend), SPICA_CAPTURE and SPICA_SHOTS (screenshot and quit)
 * go through it, so an installed Spica started with them still runs on its real data and does not quit.
 * SPICA_USER_DATA and SPICA_THEME are not among them: the install smoke test uses them on installed builds.
 */
export function devSwitch(env: NodeJS.ProcessEnv, packaged: boolean, name: 'SPICA_BACKEND' | 'SPICA_CAPTURE' | 'SPICA_SHOTS'): string | undefined {
  if (packaged) return undefined;
  return env[name] || undefined;
}

/**
 * The workflow folder the screenshots show (设置 › 常规). Their own settings folder is a temporary one under the
 * user's profile, so the default would put the developer's user name into committed images; this neutral one,
 * like the demo data's D:\工作\… folders, is only shown (the demo backend reads no workflow files).
 */
export const SHOTS_WORKFLOWS_DIR = 'D:\\工作\\Spica\\workflows';
