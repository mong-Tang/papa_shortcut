export type ConfigErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_READ_FAILED"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_INVALID_SCHEMA"
  | "CONFIG_WRITE_FAILED";

export type LaunchErrorCode =
  | "ITEM_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "TARGET_PERMISSION_DENIED"
  | "TARGET_LAUNCH_FAILED"
  | "CONFIG_NOT_READY";

export type ErrorCode = ConfigErrorCode | LaunchErrorCode;

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: string;
}

export interface OkResult<T> {
  ok: true;
  data: T;
}

export interface ErrResult {
  ok: false;
  error: ApiError;
}

export type ApiResult<T> = OkResult<T> | ErrResult;

export interface LauncherAppConfig {
  title: string;
  fullscreen: boolean;
  mode?: "fullscreen" | "widget";
  widget?: LauncherWidgetConfig;
  theme?: string;
}

export interface LauncherWidgetConfig {
  width?: number;
  height?: number;
  anchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  offsetX?: number;
  offsetY?: number;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
  frame?: boolean;
  hideOnBlur?: boolean;
  hideTrigger?: "blur" | "outside-click";
  blurBehavior?: "none" | "hide" | "dock-right-edge" | "windows-docking";
  edgeVisiblePx?: number;
  toggleShortcut?: string;
}

export interface LauncherCategory {
  id: string;
  label: string;
}

export interface LauncherItem {
  id: string;
  name: string;
  categoryId: string;
  target: string;
  args?: string | string[];
  workingDir?: string;
  icon?: string;
  keywords?: string[];
}

export interface LauncherConfig {
  version: 2;
  app: LauncherAppConfig;
  categories: LauncherCategory[];
  items: LauncherItem[];
}

export interface LaunchSuccess {
  ok: true;
  message: string;
}

export interface LaunchFailure {
  ok: false;
  error: ApiError;
}

export type LaunchResult = LaunchSuccess | LaunchFailure;

export type ReloadResult = ApiResult<LauncherConfig>;
export type SaveConfigResult = ApiResult<LauncherConfig>;
