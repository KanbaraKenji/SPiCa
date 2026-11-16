// Said by the close question (the page's dialog, ui/CloseDialog.tsx; the small dialog window and the fallback
// message box, main/tray.ts).
import { N_ } from './i18n';

// Keys (shared/i18n): the places that show them call t().
export const CLOSE_QUESTION = N_('关闭窗口时要怎么做？');

/** Under the question only while a conversation is running (quitting stops it); nothing else is explained (he asked for none). */
export const CLOSE_RUNNING = N_('有任务正在运行，退出会中断它。');

/** The checkbox: ticked, the choice becomes 设置 › 常规 › 关闭窗口时 and the question is not asked again. */
export const CLOSE_REMEMBER = N_('不再提醒');
