import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiResult,
  FolderImportScanResult,
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
  consumeRecoveryNotice: (): Promise<string | null> => {
    return ipcRenderer.invoke("launcher:consumeRecoveryNotice");
  },
  widgetBodyInteracted: (): Promise<void> => {
    return ipcRenderer.invoke("launcher:widgetBodyInteracted");
  },
  quit: (): Promise<void> => {
    return ipcRenderer.invoke("launcher:quit");
  },
  pickLaunchTarget: (targetType: "file" | "folder"): Promise<string | null> => {
    return ipcRenderer.invoke("launcher:pickLaunchTarget", targetType);
  },
  scanFolderImportTargets: (folderPath: string): Promise<FolderImportScanResult | null> => {
    return ipcRenderer.invoke("launcher:scanFolderImportTargets", folderPath);
  },
  pickItemIconPath: (): Promise<string | null> => {
    return ipcRenderer.invoke("launcher:pickItemIconPath");
  },
  pickEmptyStateImage: (): Promise<string | null> => {
    return ipcRenderer.invoke("launcher:pickEmptyStateImage");
  },
  launchItem: (itemId: string): Promise<LaunchResult> => {
    return ipcRenderer.invoke("launcher:launchItem", itemId);
  },
  saveConfig: (config: LauncherConfig): Promise<SaveConfigResult> => {
    return ipcRenderer.invoke("launcher:saveConfig", config);
  },
};

contextBridge.exposeInMainWorld("launcherApi", launcherApi);
