// Stroke icons drawn on a 16px grid. Plain geometry, no icon font, no emoji.
import type { SVGProps } from 'react';

const PATHS = {
  sidebar: 'M2.5 3.5h11v9h-11z M6 3.5v9',
  detail: 'M2.5 3.5h11v9h-11z M10 3.5v9',
  plus: 'M8 3v10 M3 8h10',
  settings:
    'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z M8 1.8v1.6 M8 12.6v1.6 M1.8 8h1.6 M12.6 8h1.6 M3.6 3.6l1.15 1.15 M11.25 11.25l1.15 1.15 M3.6 12.4l1.15-1.15 M11.25 4.75l1.15-1.15',
  chevronRight: 'M6 4l4 4-4 4',
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
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5',
  minus: 'M3.5 8h9',
  question: 'M6 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.6 M8 11.6v.2',
  arrowRight: 'M3 8h10 M9 4l4 4-4 4',
  dot: 'M8 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  inbox: 'M2.5 9.5l1.8-6h7.4l1.8 6v3h-11z M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2',
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
