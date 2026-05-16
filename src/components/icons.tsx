import type { CSSProperties, ReactNode } from "react";

type SvProps = {
  children: ReactNode;
  size?: number;
  sw?: number;
  fill?: string;
  style?: CSSProperties;
};

const Sv = ({ children, size = 16, sw = 1.5, fill = "none", style }: SvProps) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={fill}
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {children}
  </svg>
);

export type IcoProps = Omit<SvProps, "children">;

export const Ico = {
  folder: (p: IcoProps) => <Sv {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></Sv>,
  trash: (p: IcoProps) => <Sv {...p}><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v7M14 11v7"/></Sv>,
  undo: (p: IcoProps) => <Sv {...p}><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5h-4"/></Sv>,
  redo: (p: IcoProps) => <Sv {...p}><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v0a5 5 0 0 0 5 5h4"/></Sv>,
  sparkles: (p: IcoProps) => <Sv {...p}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3zM5 16l.7 2L8 18.7 5.7 19.4 5 22l-.7-2.6L2 18.7 4.3 18z"/></Sv>,
  chevDown: (p: IcoProps) => <Sv {...p}><path d="M6 9l6 6 6-6"/></Sv>,
  chevRight: (p: IcoProps) => <Sv {...p}><path d="M9 6l6 6-6 6"/></Sv>,
  sidebar: (p: IcoProps) => <Sv {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 5v14"/></Sv>,
  gauge: (p: IcoProps) => <Sv {...p}><path d="M3.5 18a10 10 0 1 1 17 0"/><path d="M12 13l4.5-4"/><circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none"/></Sv>,
  eye: (p: IcoProps) => <Sv {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></Sv>,
  eyeOff: (p: IcoProps) => <Sv {...p}><path d="M3 3l18 18M10.6 6.2A9.3 9.3 0 0 1 12 5c6.4 0 10 7 10 7a16.7 16.7 0 0 1-3.3 4M6.6 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.3 9.3 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></Sv>,
  upload: (p: IcoProps) => <Sv {...p}><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></Sv>,
  rect: (p: IcoProps) => <Sv {...p}><rect x="4" y="6" width="16" height="12" rx="2"/></Sv>,
  cursor: (p: IcoProps) => <Sv {...p}><path d="M6 4l12 7-5 1-2 6-5-14z" fill="currentColor"/></Sv>,
  webcam: (p: IcoProps) => <Sv {...p}><rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></Sv>,
  speech: (p: IcoProps) => <Sv {...p}><path d="M21 12a8 8 0 1 1-3.5-6.6L21 4l-1 4.4A8 8 0 0 1 21 12z"/><path d="M8 11h8M8 14h5"/></Sv>,
  audio: (p: IcoProps) => <Sv {...p}><path d="M11 5L6 9H3v6h3l5 4V5zM15 9a4 4 0 0 1 0 6"/></Sv>,
  cmd: (p: IcoProps) => <Sv {...p}><path d="M9 9h6v6H9z"/><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 8.5L8 8M16 8l-.5.5M8.5 15.5L8 16M16 16l-.5-.5"/></Sv>,
  link: (p: IcoProps) => <Sv {...p}><path d="M10 14a4 4 0 0 0 5.6 0l3.4-3.4a4 4 0 0 0-5.6-5.6L12 6.4M14 10a4 4 0 0 0-5.6 0L5 13.4a4 4 0 0 0 5.6 5.6L12 17.6"/></Sv>,
  image: (p: IcoProps) => <Sv {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><path d="m4 17 5-4 4 3 3-2 4 3"/></Sv>,
  rewind: (p: IcoProps) => <Sv {...p}><path d="M11 6l-7 6 7 6V6zM21 6l-7 6 7 6V6z" fill="currentColor"/></Sv>,
  play: (p: IcoProps) => <Sv {...p}><path d="M7 5l12 7-12 7V5z" fill="currentColor"/></Sv>,
  pause: (p: IcoProps) => <Sv {...p}><rect x="6" y="5" width="4" height="14" rx="0.5" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="0.5" fill="currentColor"/></Sv>,
  fwd: (p: IcoProps) => <Sv {...p}><path d="M13 6l7 6-7 6V6zM3 6l7 6-7 6V6z" fill="currentColor"/></Sv>,
  scissors: (p: IcoProps) => <Sv {...p}><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 9.2L20 17M8.5 14.8L20 7"/></Sv>,
  arrowLR: (p: IcoProps) => <Sv {...p}><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/></Sv>,
  crop: (p: IcoProps) => <Sv {...p}><path d="M6 2v16a2 2 0 0 0 2 2h14M2 6h16a2 2 0 0 1 2 2v14"/></Sv>,
  film: (p: IcoProps) => <Sv {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M9 4v16M15 4v16"/></Sv>,
  speedo: (p: IcoProps) => <Sv {...p}><circle cx="12" cy="13" r="7"/><path d="M12 13l3-2"/></Sv>,
  mouse: (p: IcoProps) => <Sv {...p}><rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v4"/></Sv>,
  zoomIn: (p: IcoProps) => <Sv {...p}><path d="M3 7l5-5h4M21 17l-5 5h-4M3 17l5 5h4M21 7l-5-5h-4"/></Sv>,
  apple: (p: IcoProps) => <Sv {...p}><path d="M12.5 6c.5-1.5 2-2.5 3.5-2.5 0 1.5-.5 3-1.5 4-1 .5-2.5 0-2-1.5zM18 13c0-2 1-3 2-3.5-1-1.5-2.5-2-4-2-1.5 0-2.5 1-3.5 1s-2-1-3.5-1c-2 0-4 1.5-4 4.5 0 3.5 2.5 8 4.5 8 1 0 2-1 3-1s2 1 3 1c2 0 4-3.5 4-7z" fill="currentColor" stroke="none"/></Sv>,
  battery: (p: IcoProps) => <Sv {...p}><rect x="2" y="8" width="18" height="8" rx="2"/><rect x="20" y="11" width="2" height="2"/><rect x="4" y="10" width="13" height="4" fill="currentColor" stroke="none"/></Sv>,
  wifi: (p: IcoProps) => <Sv {...p}><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M11 19.5a1 1 0 0 1 2 0"/></Sv>,
  search: (p: IcoProps) => <Sv {...p}><circle cx="11" cy="11" r="6"/><path d="M21 21l-4.3-4.3"/></Sv>,
  tilde: (p: IcoProps) => <Sv {...p} sw={1.2}><path d="M5 12c2-4 5-4 7 0s5 4 7 0"/></Sv>,
  display: (p: IcoProps) => <Sv {...p}><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17v4"/></Sv>,
  windowApp: (p: IcoProps) => <Sv {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></Sv>,
  area: (p: IcoProps) => (
    <Sv {...p}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
    </Sv>
  ),
  device: (p: IcoProps) => <Sv {...p}><rect x="7" y="2.5" width="10" height="19" rx="2"/><circle cx="12" cy="18" r="0.8" fill="currentColor" stroke="none"/></Sv>,
  cameraSlash: (p: IcoProps) => (
    <Sv {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h7l2 3h2a2 2 0 0 1 2 2v6" />
      <path d="M19 17v0a2 2 0 0 1-2 2H6.5" />
      <path d="M3 3l18 18" />
    </Sv>
  ),
  micSlash: (p: IcoProps) => (
    <Sv {...p}>
      <path d="M9 4.5a3 3 0 0 1 6 0V11" />
      <path d="M9 9v2a3 3 0 0 0 4.5 2.6" />
      <path d="M19 11a7 7 0 0 1-1.2 4M5 11a7 7 0 0 0 12 5" />
      <path d="M12 18v3" />
      <path d="M3 3l18 18" />
    </Sv>
  ),
  systemAudioSlash: (p: IcoProps) => (
    <Sv {...p}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M10 16V9l4-1v6" />
      <circle cx="9" cy="16" r="1.4" />
      <circle cx="13" cy="15" r="1.4" />
      <path d="M3 3l18 18" />
    </Sv>
  ),
  gear: (p: IcoProps) => (
    <Sv {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8l1.8-1.8M18 6l1.8-1.8" />
    </Sv>
  ),
  xMark: (p: IcoProps) => <Sv {...p}><path d="M6 6l12 12M18 6L6 18"/></Sv>,
  plus: (p: IcoProps) => <Sv {...p}><path d="M12 5v14M5 12h14"/></Sv>,
  target: (p: IcoProps) => <Sv {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></Sv>,
  chevUp: (p: IcoProps) => <Sv {...p}><path d="M6 15l6-6 6 6"/></Sv>,
  stopCircle: (p: IcoProps) => (
    <Sv {...p}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="0.6" fill="currentColor" stroke="none" />
    </Sv>
  ),
  pauseCircle: (p: IcoProps) => (
    <Sv {...p}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9.25" y="8.5" width="2" height="7" rx="0.3" fill="currentColor" stroke="none" />
      <rect x="12.75" y="8.5" width="2" height="7" rx="0.3" fill="currentColor" stroke="none" />
    </Sv>
  ),
  playCircle: (p: IcoProps) => (
    <Sv {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" stroke="none" />
    </Sv>
  ),
  restart: (p: IcoProps) => (
    <Sv {...p}>
      <path d="M5 8.5a7 7 0 1 1-1.4 4.5" />
      <path d="M3 4v5h5" strokeLinejoin="round" />
    </Sv>
  ),
} as const;
