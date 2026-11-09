import type { DesktopBridge } from '../shared/bridge';

declare global {
  interface Window {
    spica: DesktopBridge;
    /** Present only while the screenshot script drives the window. */
    __spicaShots?: { setView(view: string): void };
  }
}

export {};
