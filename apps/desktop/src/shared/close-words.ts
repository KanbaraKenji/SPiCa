// Said by the close question (the page's dialog, ui/CloseDialog.tsx; the small dialog window and the fallback
// message box, main/tray.ts).

export const CLOSE_QUESTION = '关闭窗口时要怎么做？';

/** Under the question only while a conversation is running (quitting stops it); nothing else is explained (he asked for none). */
export const CLOSE_RUNNING = '有任务正在运行，退出会中断它。';

/** The checkbox: ticked, the choice becomes 设置 › 常规 › 关闭窗口时 and the question is not asked again. */
export const CLOSE_REMEMBER = '不再提醒';
