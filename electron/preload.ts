import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiResult,
  LaunchResult,
  LauncherConfig,
  ReloadResult,
  SaveConfigResult,
} from "../src/shared/types";

const launcherApi = {
  getConfig: (): Promise<ApiResult<LauncherConfig>> => {
    return ipcRenderer.invoke("launcher:getConfig");
  },
  reloadConfig: (): Promise<ReloadResult> => {
    return ipcRenderer.invoke("launcher:reloadConfig");
  },
  launchItem: (itemId: string): Promise<LaunchResult> => {
    return ipcRenderer.invoke("launcher:launchItem", itemId);
  },
  saveConfig: (config: LauncherConfig): Promise<SaveConfigResult> => {
    return ipcRenderer.invoke("launcher:saveConfig", config);
  },
};

contextBridge.exposeInMainWorld("launcherApi", launcherApi);
