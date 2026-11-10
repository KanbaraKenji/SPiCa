/**
 * 带圈状态图标（完成、警告、错误、进行中这一族）：24×24 网格，线宽 2.5，圆圈半径 9.5，
 * 端点和拐角圆头。单色，颜色跟随调用处（currentColor）。
 *
 * 素材原件在 branding/icons/，要求见 branding/docs/check_icon.md；这里的图形和原件逐字一致（有测试核对）。
 * 字符串版给主进程、导出脚本用；React 版是 react/SpicaStatusIcon.tsx。
 */

export type StatusIconName = 'done';

/** 每个状态取皮肤的哪种语义色（CSS 变量），换皮肤跟着变 */
export const STATUS_ICON_TONE: Readonly<Record<StatusIconName, string>> = Object.freeze({
  done: '--spica-success',
});

/** 网格、线宽与圆圈：这一族共用 */
export const STATUS_ICON_GRID = Object.freeze({ viewBox: 24, strokeWidth: 2.5, ring: { cx: 12, cy: 12, r: 9.5 } });

/**
 * 图形本体（不含外层 svg）。maskId 用来区分同一页上的多个实例。
 * done：圆圈在对钩长臂穿出处断开，断口是切角（两个断面都和长臂平行）。
 */
export function statusIconBody(name: StatusIconName, maskId = 'spica-check-cut'): string {
  switch (name) {
    case 'done':
      return (
        `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">` +
        '<rect width="24" height="24" fill="white" stroke="none"/>' +
        '<path d="M16 11.26 24.6 1.39" stroke="black" stroke-width="5" stroke-linecap="butt"/>' +
        '</mask>' +
        `<circle cx="12" cy="12" r="9.5" mask="url(#${maskId})"/>` +
        '<path d="m6.8 12.8 4.2 4.2L22.5 3.8"/>'
      );
  }
}

/** 字符串版：完整 svg，颜色缺省 currentColor */
export function statusIconSvg(name: StatusIconName, opts: { size?: number; color?: string; maskId?: string } = {}): string {
  const size = opts.size ?? 24;
  const color = opts.color ?? 'currentColor';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${statusIconBody(name, opts.maskId)}</svg>`
  );
}
