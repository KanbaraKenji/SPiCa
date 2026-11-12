// Stroke icons drawn on a 16px grid. Plain geometry, no icon font, no emoji.
import type { SVGProps } from 'react';

const PATHS = {
  sidebar: 'M2.5 3.5h11v9h-11z M6 3.5v9',
  // The panel on the right (the title bar's button for the file preview).
  detail: 'M2.5 3.5h11v9h-11z M10 3.5v9',
  // 详情: a list (bullets and lines), unlike the panel shapes beside it.
  details: 'M6 4.5h7.5 M6 8h7.5 M6 11.5h7.5 M2.8 4.5v.1 M2.8 8v.1 M2.8 11.5v.1',
  plus: 'M8 3v10 M3 8h10',
  // A gear (the old one read as a sun).
  settings:
    'M6.54 3.22 L6.78 1.41 L9.22 1.41 L9.46 3.22 L10.35 3.59 L11.79 2.48 L13.52 4.21 L12.41 5.65 L12.78 6.54 L14.59 6.78 L14.59 9.22 L12.78 9.46 L12.41 10.35 L13.52 11.79 L11.79 13.52 L10.35 12.41 L9.46 12.78 L9.22 14.59 L6.78 14.59 L6.54 12.78 L5.65 12.41 L4.21 13.52 L2.48 11.79 L3.59 10.35 L3.22 9.46 L1.41 9.22 L1.41 6.78 L3.22 6.54 L3.59 5.65 L2.48 4.21 L4.21 2.48 L5.65 3.59z M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
  // 新对话: a page and a pen (the plus stays for 新项目, 添加附件, 新建皮肤, 放大).
  newChat: 'M13.5 8.5v5h-11v-11h5 M11.6 2.1l2.3 2.3-5.6 5.6H6V7.7z',
  // 助理: the assistant's main conversation.
  assistant: 'M2.5 3h11v8h-6.5l-3 2.5V11h-1.5z',
  // A plugin page without its own icon.
  plugin: 'M2.5 2.5h4.5v4.5h-4.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5h-4.5z M9 9h4.5v4.5H9z',
  // A confirmation (something needs your permission).
  shield: 'M8 1.8l5 1.9v4.1c0 3.1-2.1 5.3-5 6.4-2.9-1.1-5-3.3-5-6.4V3.7z',
  chevronRight: 'M6 4l4 4-4 4',
  chevronLeft: 'M10 4L6 8l4 4',
  chevronDown: 'M4 6l4 4 4-4',
  back: 'M10 4L6 8l4 4',
  send: 'M8 13V3 M4 7l4-4 4 4',
  stop: 'M5 5h6v6H5z',
  check: 'M3.5 8.5l3 3 6-7',
  close: 'M4 4l8 8 M12 4l-8 8',
  file: 'M4 2.5h5l3 3v8H4z M9 2.5v3h3',
  folder: 'M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z',
  tool: 'M10.5 2.8a3 3 0 0 0-3.6 3.9L3 10.6 5.4 13l3.9-3.9a3 3 0 0 0 3.9-3.6l-1.8 1.8-1.9-.5-.5-1.9z',
  thinking: 'M8 2.5a4 4 0 0 0-2.5 7.1V11h5V9.6A4 4 0 0 0 8 2.5z M6.2 13.2h3.6',
  pin: 'M6 2.5h4 M7 2.5v3.8L4.8 8.8h6.4L9 6.3V2.5 M8 8.8v4.7',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5',
  minus: 'M3.5 8h9',
  question: 'M6 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.6 M8 11.6v.2',
  arrowRight: 'M3 8h10 M9 4l4 4-4 4',
  // ← before a way back (‹ 已安装, 返回「…」).
  arrowLeft: 'M13 8H3 M7 4L3 8l4 4',
  dot: 'M8 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  // 支持图片: an eye (a model that takes pictures).
  eye: 'M1.5 8s2.4-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.4 4.5-6.5 4.5S1.5 8 1.5 8z M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  // 更多: three dots in a row (a row's menu in the sidebar).
  more: 'M3.5 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z M8 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z M12.5 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  inbox: 'M2.5 9.5l1.8-6h7.4l1.8 6v3h-11z M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2',
  maximize: 'M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9',
  restore: 'M13.5 2.5L9.5 6.5 M9.5 3v3.5H13 M2.5 13.5l4-4 M6.5 13V9.5H3',
  model: 'M8 1.8l1.5 4.7L14.2 8l-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z',
  info: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z M8 7.3v3.7 M8 5.1v.2',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7 M13.2 2.6v2.9h-2.9',
  paste: 'M5.5 2.5h5v2h-5z M5.5 3.5h-2v10h9v-10h-2',
  external: 'M9 2.5h4.5V7 M13.5 2.5L8 8 M11.5 9.5v4h-9v-9h4',
  pencil: 'M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z',
  // 导出: an arrow down onto a tray.
  download: 'M8 2.5v7.5 M4.8 6.8 8 10l3.2-3.2 M3 11.5v2h10v-2',
  // 代码: angle brackets (a file's source, as against its preview).
  code: 'M5.5 4.5 2 8l3.5 3.5 M10.5 4.5 14 8l-3.5 3.5',
  // A link to a web page (before link text in answers).
  link: 'M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9 M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9',
  copy: 'M5.5 5.5h7.5v8H5.5z M3 10.5V2.5h7.5',
  // 搜索设置: a lens.
  search: 'M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4z M10.1 10.1l3.4 3.4',
  // 设置 › 账号: a head and shoulders.
  account: 'M8 2.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z M3 13.6c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8',
  // 设置 › 外观: a painter's palette.
  // 用量: bars over a baseline.
  chart: 'M2.5 13.5h11 M4.5 11V8 M8 11V4 M11.5 11V6.5',
  palette: 'M8 2.2a5.8 5.8 0 0 0 0 11.6c.9 0 1.3-.6 1.1-1.3-.3-1 .3-1.8 1.3-1.8h1.3a2.2 2.2 0 0 0 2.1-2.4A6 6 0 0 0 8 2.2z M5.2 7.4v.1 M7.4 5v.1 M10.4 5.8v.1',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
