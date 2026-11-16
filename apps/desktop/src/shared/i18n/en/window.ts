// The window around the pages: the tray, the close question (ui/CloseDialog.tsx, main/tray.ts), the text menus
// (main/edit-menu.ts, ui/TextMenu.tsx), the small dialog window.
import type { Catalog } from '../index';

export const EN_WINDOW: Catalog = {
  '打开 {app}': 'Open {app}',
  '退出 {app}': 'Quit {app}',
  最小化到托盘: 'Minimize to tray',
  取消: 'Cancel',
  确定: 'OK',
  关闭: 'Close',
  '关闭（Esc）': 'Close (Esc)',
  '关闭窗口时要怎么做？': 'What should closing the window do?',
  '有任务正在运行，退出会中断它。': 'A task is running. Quitting will stop it.',
  不再提醒: 'Don’t ask again',
  '{app} 已最小化到托盘，仍在运行。点托盘图标打开，右键图标可以退出。': '{app} is still running in the tray. Click its icon to open it, or right-click to quit.',
  '撤消(&U)': '&Undo',
  '剪切(&T)': 'Cu&t',
  '复制(&C)': '&Copy',
  '粘贴(&P)': '&Paste',
  '删除(&D)': '&Delete',
  '全选(&A)': 'Select &All',
  复制: 'Copy',
};
