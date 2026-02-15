/// <reference types="vite/client" />

import type {
  ApiResult,
  LaunchResult,
  LauncherConfig,
  ReloadResult,
  SaveConfigResult,
} from "../shared/types";

interface LauncherApi {
  getConfig: () => Promise<ApiResult<LauncherConfig>>;
  reloadConfig: () => Promise<ReloadResult>;
  launchItem: (itemId: string) => Promise<LaunchResult>;
  saveConfig: (config: LauncherConfig) => Promise<SaveConfigResult>;
}

declare global {
  interface Window {
    launcherApi: LauncherApi;
  }
}

export {};
