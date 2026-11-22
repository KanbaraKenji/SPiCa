import type { DesktopBridge } from '../shared/bridge';

declare global {
  interface Window {
    spica: DesktopBridge;
    /** Present only while the screenshot script drives the window. */
    __spicaShots?: { setView(view: string): void; schedule?: (layout: string, scene: string) => void; preview?: (path: string) => void; browse?: (url: string) => void };
  }
}

export {};
