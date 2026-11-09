import type { SpicaBridge } from '@spica/protocol';

declare global {
  interface Window {
    spica: SpicaBridge;
  }
}

export {};
