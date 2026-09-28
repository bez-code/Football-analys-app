/// <reference types="vite/client" />

import type { TactixApi } from '../../common/ipc';

declare global {
  interface Window {
    tactix: TactixApi;
  }
}

export {};
