/**
 * 带圈状态图标（完成、警告、错误、进行中这一族）：24×24 网格，线宽 2.5，圆圈半径 9.5，
 * 端点和拐角圆头。单色，颜色跟随调用处（currentColor）。
 *
 * 素材原件在 branding/icons/，要求见 branding/docs/check_icon.md；这里的图形和原件逐字一致（有测试核对）。
 * 字符串版给主进程、导出脚本用；React 版是 react/SpicaStatusIcon.tsx。
 */

/**
 * 九种状态：完成、进行中、警告、错误、等待确认、提问（等待回答）、已停止、排队、提示。
 * 定稿见 branding/docs/status_icons.md。
 */
export const STATUS_ICON_NAMES = ['done', 'running', 'warning', 'error', 'waiting', 'question', 'stopped', 'queued', 'info'] as const;
export type StatusIconName = (typeof STATUS_ICON_NAMES)[number];

/** 每个状态取皮肤的哪种语义色（CSS 变量），换皮肤跟着变 */
export const STATUS_ICON_TONE: Readonly<Record<StatusIconName, string>> = Object.freeze({
  done: '--spica-success',
  running: '--spica-accent',
  warning: '--spica-warning',
  error: '--spica-danger',
  waiting: '--spica-warning',
  question: '--spica-warning',
  stopped: '--spica-muted',
  queued: '--spica-muted',
  info: '--spica-accent',
});

/** 网格、线宽与圆圈：这一族共用 */
export const STATUS_ICON_GRID = Object.freeze({ viewBox: 24, strokeWidth: 2.5, ring: { cx: 12, cy: 12, r: 9.5 } });

const RING = '<circle cx="12" cy="12" r="9.5"/>';

/** 圆圈里的图形（done 另画：它的圆圈有断口） */
const BODIES: Readonly<Record<Exclude<StatusIconName, 'done'>, string>> = Object.freeze({
  // 淡色底环 + 四分之一亮弧；亮弧带 class，样式里让它绕圆心转（减弱动效时不转）
  running: '<circle cx="12" cy="12" r="9.5" opacity=".25"/><path class="spica-status-spin" d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5"/>',
  warning: `${RING}<path d="M12 7.25v5.5M12 16.5h.01"/>`,
  error: `${RING}<path d="m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5"/>`,
  // 时钟指针
  waiting: `${RING}<path d="M12 7v5l3.25 2.25"/>`,
  question: `${RING}<path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.45c-.75.35-1.2.9-1.2 1.65v.3M12 16.75h.01"/>`,
  // 实心小方块（描边加填充，圆角）
  stopped: `${RING}<rect x="9.25" y="9.25" width="5.5" height="5.5" rx=".4" fill="currentColor"/>`,
  // 九段虚线圈
  queued: '<circle cx="12" cy="12" r="9.5" stroke-dasharray="2.2 4.432"/>',
  info: `${RING}<path d="M12 11v5.5M12 7.5h.01"/>`,
});

/**
 * 图形本体（不含外层 svg）。maskId 用来区分同一页上的多个实例（只有 done 用到遮罩）。
 * done：圆圈在对钩长臂穿出处断开，断口是切角（两个断面都和长臂平行）。
 */
export function statusIconBody(name: StatusIconName, maskId = 'spica-check-cut'): string {
  if (name !== 'done') return BODIES[name];
  return (
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">` +
    '<rect width="24" height="24" fill="white" stroke="none"/>' +
    '<path d="M16 11.26 24.6 1.39" stroke="black" stroke-width="5" stroke-linecap="butt"/>' +
    '</mask>' +
    `<circle cx="12" cy="12" r="9.5" mask="url(#${maskId})"/>` +
    '<path d="m6.8 12.8 4.2 4.2L22.5 3.8"/>'
  );
}

/** 字符串版：完整 svg，颜色缺省 currentColor */
export function statusIconSvg(name: StatusIconName, opts: { size?: number; color?: string; maskId?: string } = {}): string {
  const size = opts.size ?? 24;
  // 给了颜色就写在 color 上，图形里的 currentColor（描边和已停止的实心方块）都跟着它
  const color = opts.color ? ` color="${opts.color}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"${color} fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${statusIconBody(name, opts.maskId)}</svg>`
  );
}
