import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function icon(children: ReactNode, props: IconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const I = {
  arrow: (props: IconProps = {}) => icon(<><path d="M2 7h9" /><path d="M7 3l4 4-4 4" /></>, props),
  close: (props: IconProps = {}) => icon(<><path d="M3 3l8 8" /><path d="M11 3l-8 8" /></>, props),
  menu: (props: IconProps = {}) => icon(<><path d="M2.5 3.5h9" /><path d="M2.5 7h9" /><path d="M2.5 10.5h9" /></>, props),
  more: (props: IconProps = {}) => icon(<><circle cx="3" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="11" cy="7" r="1" fill="currentColor" stroke="none" /></>, props),
  download: (props: IconProps = {}) => icon(<><path d="M2.5 9.5v1.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9.5" /><path d="M4.5 6.5 7 9l2.5-2.5" /><path d="M7 9V2" /></>, props),
  trash: (props: IconProps = {}) => icon(<><path d="M2 4h10" /><path d="M5 4V2.8A1.2 1.2 0 0 1 6.2 1.6h1.6A1.2 1.2 0 0 1 9 2.8V4" /><path d="M11 4v7.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4" /></>, props),
  archive: (props: IconProps = {}) => icon(<><rect x="1.5" y="2.5" width="11" height="3" rx="0.6" /><path d="M2.5 5.5V11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5" /><path d="M5.5 8h3" /></>, props),
  library: (props: IconProps = {}) => icon(<><path d="M3 2h6.5A1.5 1.5 0 0 1 11 3.5V12H4a2 2 0 0 1 0-4h7" /><path d="M4 2v6" /><path d="M6 4.5h2.5" /></>, props),
  copy: (props: IconProps = {}) => icon(<><rect x="5" y="5" width="7" height="7" rx="1" /><path d="M3 9H2.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1H8a1 1 0 0 1 1 1V3" /></>, props),
  reroll: (props: IconProps = {}) => icon(<><path d="M11.5 7A4.5 4.5 0 1 1 9.9 3.6" /><path d="M11.5 2.5v3h-3" /></>, props),
  dice: (props: IconProps = {}) => icon(<><rect x="2" y="2" width="10" height="10" rx="2" /><circle cx="5" cy="5" r="0.5" fill="currentColor" stroke="none" /><circle cx="9" cy="5" r="0.5" fill="currentColor" stroke="none" /><circle cx="7" cy="7" r="0.5" fill="currentColor" stroke="none" /><circle cx="5" cy="9" r="0.5" fill="currentColor" stroke="none" /><circle cx="9" cy="9" r="0.5" fill="currentColor" stroke="none" /></>, props),
  clock: (props: IconProps = {}) => icon(<><circle cx="7" cy="7" r="5" /><path d="M7 4v3l2 1.2" /></>, props),
  alert: (props: IconProps = {}) => icon(<><path d="M6.1 2.2a1 1 0 0 1 1.8 0l4.5 8.2a1 1 0 0 1-.9 1.5h-9a1 1 0 0 1-.9-1.5z" /><path d="M7 5.2v2.6" /><path d="M7 10h.01" /></>, props),
  check: (props: IconProps = {}) => icon(<path d="M11.5 3.5 5.7 9.3 2.5 6.2" />, props),
  warn: (props: IconProps = {}) =>
    icon(
      <>
        <path d="M7 1.5 13 12.5H1z" />
        <path d="M7 5.5v3.5" />
        <path d="M7 11v.1" />
      </>,
      props,
    ),
  expand: (props: IconProps = {}) => icon(<><path d="M8.5 2H12v3.5" /><path d="M5.5 12H2V8.5" /><path d="M12 2 8 6" /><path d="M2 12l4-4" /></>, props),
  play: (props: IconProps = {}) => icon(<path d="M5 3.5 10 7l-5 3.5Z" />, props),
  film: (props: IconProps = {}) => icon(<><rect x="2" y="3" width="10" height="8" rx="1" /><path d="M2 5.5h10" /><path d="M4.5 3v2.5" /><path d="M7 3v2.5" /><path d="M9.5 3v2.5" /></>, props),
  extend: (props: IconProps = {}) => icon(<><path d="M2 4.5h5.5a3.5 3.5 0 0 1 3.5 3.5v3" /><path d="m8.5 8.5 2.5 2.5 2-2.5" /><path d="M2 2.5v4" /></>, props),
  image: (props: IconProps = {}) => icon(<><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" /><circle cx="5" cy="5" r="1.2" /><path d="M12.5 9 8.8 5.3 2 12" /></>, props),
  chip: (props: IconProps = {}) => icon(<><rect x="3" y="3" width="8" height="8" rx="1.2" /><path d="M5.5 5.5h3v3h-3z" /><path d="M1.5 5h1.5M1.5 9h1.5M11 5h1.5M11 9h1.5M5 1.5V3M9 1.5V3M5 11v1.5M9 11v1.5" /></>, props),
  paperclip: (props: IconProps = {}) => icon(<path d="m11.2 6.3-4.7 4.7a3 3 0 0 1-4.2-4.2l5.1-5.1a2 2 0 0 1 2.8 2.8L5.1 9.6a1 1 0 0 1-1.4-1.4l4.7-4.7" />, props),
  penLine: (props: IconProps = {}) => icon(<><path d="M8.5 2.5 11.5 5.5" /><path d="M10.6 1.6a1.4 1.4 0 0 1 2 2L4.8 11.4 2 12l.6-2.8Z" /></>, props),
  caret: (props: IconProps = {}) => icon(<path d="M3.5 5.5 7 9l3.5-3.5" />, props),
  info: (props: IconProps = {}) => icon(<><circle cx="7" cy="7" r="5.5" /><path d="M7 6.2v3.4" /><path d="M7 4.3h.01" /></>, props),
  pencil: (props: IconProps = {}) => icon(<><path d="M9.3 2.4 11.6 4.7 5 11.3 2.4 12 3.1 9.4 9.3 2.4Z" /><path d="M8.4 3.3 10.7 5.6" /></>, props),
  chevronLeft: (props: IconProps = {}) => icon(<path d="M9 3 5 7l4 4" />, props),
  chevronRight: (props: IconProps = {}) => icon(<path d="M5 3l4 4-4 4" />, props),
  folder: (props: IconProps = {}) => icon(<><path d="M2 4.2V3.4a1 1 0 0 1 1-1h2.7l1.2 1.4H11a1 1 0 0 1 1 1v.8" /><path d="M2 4.8h10v5.8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /></>, props),
  folderPlus: (props: IconProps = {}) => icon(<><path d="M2 4.2V3.4a1 1 0 0 1 1-1h2.7l1.2 1.4H11a1 1 0 0 1 1 1v.8" /><path d="M2 4.8h10v5.8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /><path d="M7 7v3" /><path d="M5.5 8.5h3" /></>, props),
  search: (props: IconProps = {}) => icon(<><circle cx="6.2" cy="6.2" r="3.7" /><path d="m9 9 2.8 2.8" /></>, props),
  zoomIn: (props: IconProps = {}) => icon(<><circle cx="6.2" cy="6.2" r="3.7" /><path d="m9 9 2.8 2.8" /><path d="M6.2 4.6v3.2" /><path d="M4.6 6.2h3.2" /></>, props),
  zoomOut: (props: IconProps = {}) => icon(<><circle cx="6.2" cy="6.2" r="3.7" /><path d="m9 9 2.8 2.8" /><path d="M4.6 6.2h3.2" /></>, props),
  star: (props: IconProps = {}) => icon(<path d="m7 1.7 1.7 3.4 3.8.6-2.8 2.7.7 3.8L7 10.4l-3.4 1.8.7-3.8-2.8-2.7 3.8-.6Z" />, props),
  tag: (props: IconProps = {}) => icon(<><path d="M2 3.5V7l5 5 4.5-4.5-5-5H3a1 1 0 0 0-1 1Z" /><circle cx="5" cy="5.2" r="0.7" /></>, props),
  settings: (props: IconProps = {}) => icon(<><circle cx="7" cy="7" r="2" /><path d="M11.4 8.4l1 .6-1 1.7-1.1-.4a3.6 3.6 0 0 1-1 .6l-.2 1.1h-2l-.2-1.1a3.6 3.6 0 0 1-1-.6l-1.1.4-1-1.7 1-.6a3.6 3.6 0 0 1 0-1.2l-1-.6 1-1.7 1.1.4a3.6 3.6 0 0 1 1-.6l.2-1.1h2l.2 1.1a3.6 3.6 0 0 1 1 .6l1.1-.4 1 1.7-1 .6a3.6 3.6 0 0 1 0 1.2z" /></>, props),
  sun: (props: IconProps = {}) => icon(<><circle cx="7" cy="7" r="2.4" /><path d="M7 1.5v1.4M7 11.1v1.4M1.5 7h1.4M11.1 7h1.4M3.1 3.1l1 1M9.9 9.9l1 1M3.1 10.9l1-1M9.9 4.1l1-1" /></>, props),
  moon: (props: IconProps = {}) => icon(<path d="M11.6 8.3A4.6 4.6 0 0 1 5.7 2.4 4.8 4.8 0 1 0 11.6 8.3Z" />, props),
  grip: (props: IconProps = {}) => icon(<><circle cx="5" cy="3.5" r="0.6" fill="currentColor" stroke="none" /><circle cx="9" cy="3.5" r="0.6" fill="currentColor" stroke="none" /><circle cx="5" cy="7" r="0.6" fill="currentColor" stroke="none" /><circle cx="9" cy="7" r="0.6" fill="currentColor" stroke="none" /><circle cx="5" cy="10.5" r="0.6" fill="currentColor" stroke="none" /><circle cx="9" cy="10.5" r="0.6" fill="currentColor" stroke="none" /></>, props),
  lock: (props: IconProps = {}) => icon(<><rect x="3" y="6.5" width="8" height="5.5" rx="1" /><path d="M4.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" /></>, props),
  plus: (props: IconProps = {}) => icon(<><path d="M7 2.5v9" /><path d="M2.5 7h9" /></>, props),
  layers: (props: IconProps = {}) => icon(<><path d="M7 1.5 1.5 4.5l5.5 3 5.5-3L7 1.5Z" /><path d="M1.5 9.5l5.5 3 5.5-3" /><path d="M1.5 7l5.5 3 5.5-3" /></>, props),
  sparkle: (props: IconProps = {}) => icon(<><path d="M7 1.5l1.4 3.7L12 6.6 8.4 8 7 11.7 5.6 8 2 6.6l3.6-1.4Z" /><path d="M11.5 1.5v2M12.5 2.5h-2" /></>, props),
  card: (props: IconProps = {}) => icon(<><rect x="2.5" y="1.5" width="9" height="11" rx="1.5" /><circle cx="7" cy="5.5" r="1.6" /><path d="M5.2 9.6h3.6" /></>, props),
};
