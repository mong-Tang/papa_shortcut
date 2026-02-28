import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import type { NativeImage } from "electron";
import type { OpenDialogOptions } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launcherConfigSchema } from "../src/shared/config-schema";
import {
  createWindowsOutsideClickWatcher,
  type WindowsOutsideClickWatcher,
} from "./windows-outside-click";
import type {
  ApiResult,
  ErrResult,
  FolderImportCandidate,
  FolderImportScanResult,
  LaunchResult,
  LauncherConfig,
  LauncherItem,
  ReloadResult,
  SaveConfigResult,
} from "../src/shared/types";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const EXECUTABLE_EXTENSIONS = new Set([".exe", ".bat", ".cmd", ".com"]);
const EXTENSION_ICON_CABINET: Record<string, string> = {
  ".txt": "assets/icons/text-file.svg",
  ".md": "assets/icons/text-file.svg",
  ".json": "assets/icons/text-file.svg",
  ".log": "assets/icons/text-file.svg",
  ".ini": "assets/icons/text-file.svg",
  ".csv": "assets/icons/text-file.svg",
  ".html": "assets/icons/web.svg",
  ".htm": "assets/icons/web.svg",
  ".url": "assets/icons/web.svg",
  ".pdf": "assets/icons/text-file.svg",
  ".doc": "assets/icons/text-file.svg",
  ".docx": "assets/icons/text-file.svg",
  ".xls": "assets/icons/text-file.svg",
  ".xlsx": "assets/icons/text-file.svg",
  ".ppt": "assets/icons/text-file.svg",
  ".pptx": "assets/icons/text-file.svg",
  ".zip": "assets/icons/folder.svg",
  ".7z": "assets/icons/folder.svg",
  ".rar": "assets/icons/folder.svg",
  ".exe": "assets/icons/game.svg",
  ".lnk": "assets/icons/game.svg",
  ".bat": "assets/icons/game.svg",
  ".cmd": "assets/icons/game.svg",
};
const SMOKE_LAUNCH_ARG_PREFIX = "--smoke-launch-item=";
const SMOKE_ENTER_ARG_PREFIX = "--smoke-enter-item=";
const LOCAL_STORAGE_ROOT_DIR = "papa-launcher";
const WIDGET_SIZE_PERSIST_DEBOUNCE_MS = 420;
const MIN_WIDGET_HEIGHT_PX = 600;
const DEFAULT_RECOVERY_CONFIG: LauncherConfig = {
  version: 2,
  app: {
    title: "mongTang",
    fullscreen: false,
    mode: "widget",
    widget: {
      width: 460,
      height: 760,
      anchor: "bottom-right",
      offsetX: 0,
      offsetY: 0,
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: true,
      frame: false,
      hideOnBlur: false,
      hideTrigger: "blur",
      blurBehavior: "windows-docking",
      edgeVisiblePx: 4,
    },
    theme: "blue",
  },
  categories: [
    { id: "all", label: "전체" },
    { id: "document", label: "문서" },
    { id: "game", label: "게임" },
    { id: "web", label: "웹" },
    { id: "tool", label: "도구" },
  ],
  items: [],
};

let mainWindow: BrowserWindow | null = null;
let cachedConfigRaw: LauncherConfig | null = null;
let cachedConfigForRenderer: LauncherConfig | null = null;
let widgetModeEnabled = false;
let widgetHideOnTrigger = false;
let widgetDockOnTrigger = false;
let widgetHideTrigger: "blur" | "outside-click" = "blur";
let widgetDocked = false;
let widgetEdgeVisiblePx = 6;
let widgetHomeBounds: { width: number; height: number; x: number; y: number } | null = null;
let widgetCursorWatchInterval: NodeJS.Timeout | null = null;
let widgetFocusWatchInterval: NodeJS.Timeout | null = null;
let widgetFocusAcquireTimer: NodeJS.Timeout | null = null;
let widgetRestoreBlurGuardTimer: NodeJS.Timeout | null = null;
let widgetRestoreBlurGuardExpireAt = 0;
let lastWidgetBlurActionAt = 0;
let widgetCursorRestoreReady = false;
let widgetFocusWatchCursorInsideSeen = false;
let widgetPointerLeaveAutoDockEnabled = true;
let widgetOutsideClickWatcher: WindowsOutsideClickWatcher | null = null;
let widgetOutsideClickFallbackApplied = false;
let widgetToggleShortcut: string | null = null;
let smokeEnterExpectedItemId: string | null = null;
let smokeEnterLaunchMatched = false;
let quitFallbackTimer: NodeJS.Timeout | null = null;
let widgetSizePersistTimer: NodeJS.Timeout | null = null;
let lastPersistedWidgetSize: { width: number; height: number } | null = null;
let pendingRecoveryNotice: string | null = null;

function configureRuntimePaths(): void {
  const localAppDataPath = process.env.LOCALAPPDATA?.trim();
  if (!localAppDataPath) {
    return;
  }

  const storageRootPath = path.join(localAppDataPath, LOCAL_STORAGE_ROOT_DIR);
  const userDataPath = path.join(storageRootPath, "user-data");
  const sessionDataPath = path.join(storageRootPath, "session-data");

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(sessionDataPath, { recursive: true });
    app.setPath("userData", userDataPath);
    app.setPath("sessionData", sessionDataPath);
  } catch (error) {
    console.error(
      `[papa-launcher] Failed to configure runtime paths: ${formatUnknownError(error)}`,
    );
  }
}

configureRuntimePaths();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    appendLog("Second instance detected. Focus existing window.");
    focusMainWindowForSecondInstance();
  });
}

function getCliOptionValue(prefix: string): string | null {
  const option = process.argv.find((value) => value.startsWith(prefix));
  if (!option) {
    return null;
  }

  const parsedValue = option.slice(prefix.length).trim();
  return parsedValue.length > 0 ? parsedValue : null;
}

function getProjectRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function getResourcesRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return getProjectRoot();
}

function getRendererHtmlPath(): string {
  return path.resolve(__dirname, "..", "..", "dist", "index.html");
}

function getConfigPath(): string {
  return path.join(getResourcesRoot(), "config", "launcher.config.json");
}

function getBundledConfigPath(): string {
  return getConfigPath();
}

function getUserConfigPath(): string {
  return path.join(app.getPath("userData"), "config", "launcher.config.json");
}

function getConfigReadCandidates(): string[] {
  const userPath = getUserConfigPath();
  const bundledPath = getBundledConfigPath();
  if (userPath === bundledPath) {
    return [userPath];
  }
  return [userPath, bundledPath];
}

function getWritableConfigPath(): string {
  return getUserConfigPath();
}

function getLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "launcher.log");
}

function appendLog(message: string): void {
  try {
    const logPath = getLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Ignore logging failures.
  }
}

function requestAppQuit(reason: string): void {
  appendLog(`Quit requested reason=${reason}`);

  if (quitFallbackTimer) {
    clearTimeout(quitFallbackTimer);
    quitFallbackTimer = null;
  }

  app.quit();

  // In rare cases quit can be ignored by environment hooks.
  // Force-exit after grace period to guarantee Exit button behavior.
  quitFallbackTimer = setTimeout(() => {
    appendLog(`Quit fallback forced exit reason=${reason}`);
    app.exit(0);
  }, 1600);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function configError(
  code: ErrResult["error"]["code"],
  message: string,
  details?: string,
): ErrResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function normalizePathToPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function toAbsolutePath(candidate: string): string {
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(getResourcesRoot(), candidate);
}

function getMimeTypeFromPath(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return null;
  }
}

function toImageDataUrl(filePath: string): string | null {
  const mimeType = getMimeTypeFromPath(filePath);
  if (!mimeType) {
    return null;
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function nativeImageToDataUrl(image: NativeImage): string | null {
  if (image.isEmpty()) {
    return null;
  }
  try {
    const buffer = image.toPNG();
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function toNativePath(candidate: string): string {
  if (process.platform !== "win32") {
    return candidate;
  }
  return path.normalize(candidate.replace(/\//g, "\\"));
}

function shouldResolveFileIcon(target: string, icon: string | undefined): boolean {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return false;
  }
  const extension = path.extname(normalizedTarget.split(/[?#]/, 1)[0]).toLowerCase();
  if (!extension) {
    return false;
  }
  if (extension === ".url") {
    return false;
  }
  if (!EXTENSION_ICON_CABINET[extension]) {
    return false;
  }
  if (!icon) {
    return true;
  }
  const defaultIcon = getDefaultIconAssetPathForTarget(normalizedTarget);
  if (defaultIcon === icon) {
    return true;
  }
  const resolvedDefault = resolveRendererAssetPath(defaultIcon);
  return resolvedDefault === icon;
}

async function resolveFileIconDataUrl(target: string): Promise<string | null> {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    appendLog("Icon extract skipped: empty target");
    return null;
  }
  const nativeTarget = toNativePath(normalizedTarget);
  if (!fs.existsSync(nativeTarget)) {
    appendLog(`Icon extract skipped: target not found path=${nativeTarget}`);
    return null;
  }
  const extension = path.extname(normalizedTarget.split(/[?#]/, 1)[0]).toLowerCase();
  if (extension === ".lnk") {
    try {
      const shortcut = shell.readShortcutLink(nativeTarget);
      const iconTarget = shortcut.icon?.trim() || shortcut.target?.trim();
      if (!iconTarget) {
        appendLog(`Icon extract skipped: shortcut has no icon/target path=${nativeTarget}`);
        return null;
      }
      const nativeIconTarget = toNativePath(iconTarget);
      if (!fs.existsSync(nativeIconTarget)) {
        appendLog(`Icon extract skipped: shortcut icon target missing path=${nativeIconTarget}`);
        return null;
      }
      if (getMimeTypeFromPath(nativeIconTarget)) {
        const directDataUrl = toImageDataUrl(nativeIconTarget);
        if (directDataUrl) {
          appendLog(`Icon extract shortcut image success: ${nativeTarget} -> ${nativeIconTarget}`);
          return directDataUrl;
        }
        appendLog(`Icon extract skipped: shortcut image load failed path=${nativeIconTarget}`);
        return null;
      }
      const icon = await app.getFileIcon(nativeIconTarget, { size: "normal" });
      const dataUrl = nativeImageToDataUrl(icon);
      if (dataUrl) {
        appendLog(`Icon extract shortcut success: ${nativeTarget} -> ${nativeIconTarget}`);
        return dataUrl;
      }
      appendLog(`Icon extract skipped: shortcut target icon empty path=${nativeIconTarget}`);
      return null;
    } catch {
      appendLog(`Icon extract failed: readShortcutLink error path=${nativeTarget}`);
      return null;
    }
  }

  try {
    const icon = await app.getFileIcon(nativeTarget, { size: "normal" });
    const dataUrl = nativeImageToDataUrl(icon);
    if (dataUrl) {
      appendLog(`Icon extract success: ${nativeTarget}`);
      return dataUrl;
    }
  } catch {
    appendLog(`Icon extract failed: app.getFileIcon error path=${nativeTarget}`);
  }

  return null;
}

function resolveRendererAssetPath(assetPath: string | undefined): string | undefined {
  if (!assetPath) {
    return undefined;
  }

  if (/^(https?:\/\/|file:\/\/|data:)/i.test(assetPath)) {
    return assetPath;
  }

  const absolutePath = toAbsolutePath(assetPath);

  if (!fs.existsSync(absolutePath)) {
    return assetPath;
  }

  const dataUrl = toImageDataUrl(absolutePath);
  if (dataUrl) {
    return dataUrl;
  }

  return pathToFileURL(absolutePath).toString();
}

function getDefaultIconAssetPathForTarget(target: string): string | undefined {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return undefined;
  }
  if (/^https?:\/\//i.test(normalizedTarget)) {
    return "assets/icons/web.svg";
  }
  if (/^data:/i.test(normalizedTarget)) {
    return undefined;
  }
  if (/^file:\/\//i.test(normalizedTarget)) {
    return undefined;
  }

  const targetWithoutQuery = normalizedTarget.split(/[?#]/, 1)[0];
  const extension = path.extname(targetWithoutQuery).toLowerCase();
  const cabinetIconPath = EXTENSION_ICON_CABINET[extension];
  if (cabinetIconPath) {
    return cabinetIconPath;
  }
  if (!extension) {
    try {
      if (path.isAbsolute(targetWithoutQuery) && fs.existsSync(targetWithoutQuery)) {
        const stat = fs.statSync(targetWithoutQuery);
        if (stat.isDirectory()) {
          return "assets/icons/folder.svg";
        }
      }
    } catch {
      // Ignore icon fallback errors.
    }
  }

  return undefined;
}

function inferItemNameFromTarget(targetPath: string): string {
  const normalizedTarget = normalizePathToPosix(targetPath);
  const fileName = normalizedTarget.split("/").filter(Boolean).pop() ?? "";
  if (!fileName) {
    return "New Item";
  }
  const nameWithoutExtension = fileName.replace(/\.[^.]+$/, "");
  return nameWithoutExtension || fileName;
}

function getFolderImportCategoryLabel(rootPath: string, fullPath: string): string {
  const rootLabel = path.basename(rootPath).trim() || "Imported";
  const parentDirectory = path.dirname(fullPath);
  const parentLabel = path.basename(parentDirectory).trim();
  if (!parentLabel) {
    return rootLabel;
  }
  return parentLabel;
}

function scanFolderImportTargets(folderPath: string): FolderImportScanResult | null {
  const normalizedInput = folderPath.trim();
  if (!normalizedInput) {
    return null;
  }

  const absoluteRoot = path.resolve(normalizedInput);
  try {
    const rootStat = fs.statSync(absoluteRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const MAX_ENTRIES = 3000;
  const directoryQueue: string[] = [absoluteRoot];
  const entries: FolderImportCandidate[] = [];
  const topLevelEntries: FolderImportCandidate[] = [];
  let scannedDirectoryCount = 0;
  let nestedDirectoryCount = 0;
  let truncated = false;

  while (directoryQueue.length > 0) {
    const currentDirectory = directoryQueue.shift();
    if (!currentDirectory) {
      continue;
    }
    scannedDirectoryCount += 1;

    let directoryEntries: fs.Dirent[] = [];
    try {
      directoryEntries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const directoryEntry of directoryEntries) {
      const absoluteEntryPath = path.join(currentDirectory, directoryEntry.name);

      if (directoryEntry.isDirectory()) {
        if (currentDirectory === absoluteRoot) {
          nestedDirectoryCount += 1;
        }
        directoryQueue.push(absoluteEntryPath);
        continue;
      }

      if (!directoryEntry.isFile()) {
        continue;
      }

      const normalizedTarget = normalizePathToPosix(absoluteEntryPath);
      entries.push({
        target: normalizedTarget,
        name: inferItemNameFromTarget(normalizedTarget),
        categoryLabel: getFolderImportCategoryLabel(absoluteRoot, absoluteEntryPath),
        workingDir: normalizePathToPosix(path.dirname(absoluteEntryPath)),
        icon: getDefaultIconAssetPathForTarget(normalizedTarget),
      });
      if (currentDirectory === absoluteRoot) {
        topLevelEntries.push({
          target: normalizedTarget,
          name: inferItemNameFromTarget(normalizedTarget),
          categoryLabel: getFolderImportCategoryLabel(absoluteRoot, absoluteEntryPath),
          workingDir: normalizePathToPosix(path.dirname(absoluteEntryPath)),
          icon: getDefaultIconAssetPathForTarget(normalizedTarget),
        });
      }

      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }

    if (truncated) {
      break;
    }
  }

  return {
    rootPath: normalizePathToPosix(absoluteRoot),
    entries,
    topLevelEntries,
    scannedDirectoryCount,
    nestedDirectoryCount,
    truncated,
  };
}

function toRendererConfig(config: LauncherConfig): LauncherConfig {
  return {
    ...config,
    app: {
      ...config.app,
      emptyStateImage: resolveRendererAssetPath(config.app.emptyStateImage),
    },
    items: config.items.map((item) => ({
      ...item,
      icon: resolveRendererAssetPath(item.icon ?? getDefaultIconAssetPathForTarget(item.target)),
    })),
  };
}

function loadConfigFromPath(configPath: string): ApiResult<LauncherConfig> {
  let rawJson = "";
  try {
    rawJson = fs.readFileSync(configPath, "utf8");
    // PowerShell/other editors may save UTF-8 BOM; JSON.parse cannot consume it.
    rawJson = rawJson.replace(/^\uFEFF/, "");
  } catch (error) {
    return configError(
      "CONFIG_READ_FAILED",
      "Failed to read config file.",
      formatUnknownError(error),
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch (error) {
    return configError(
      "CONFIG_INVALID_JSON",
      "Config JSON is invalid.",
      formatUnknownError(error),
    );
  }

  const schemaResult = launcherConfigSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    const details = schemaResult.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join(" | ");

    return configError(
      "CONFIG_INVALID_SCHEMA",
      "Config schema validation failed.",
      details,
    );
  }

  return { ok: true, data: schemaResult.data };
}

function loadConfig(): ApiResult<LauncherConfig> {
  const readCandidates = getConfigReadCandidates();
  const attemptLogs: string[] = [];
  let foundAnyFile = false;

  for (const candidate of readCandidates) {
    if (!fs.existsSync(candidate)) {
      attemptLogs.push(`${candidate}: not found`);
      continue;
    }

    foundAnyFile = true;
    const candidateResult = loadConfigFromPath(candidate);
    if (candidateResult.ok) {
      cachedConfigRaw = candidateResult.data;
      cachedConfigForRenderer = toRendererConfig(candidateResult.data);

      if (attemptLogs.length > 0) {
        appendLog(
          `Config fallback used. Loaded from: ${candidate}. Previous attempts: ${attemptLogs.join(
            " || ",
          )}`,
        );
      } else {
        appendLog(`Config loaded from: ${candidate}`);
      }

      return { ok: true, data: cachedConfigForRenderer };
    }

    attemptLogs.push(
      `${candidate}: ${candidateResult.error.code} ${candidateResult.error.message} ${
        candidateResult.error.details ?? ""
      }`.trim(),
    );
  }

  if (!foundAnyFile) {
    const recovered = recoverConfigFromDefault(
      "CONFIG_NOT_FOUND",
      `Expected one of: ${readCandidates.join(" | ")}`,
    );
    if (recovered.ok) {
      return recovered;
    }
    return configError(
      "CONFIG_NOT_FOUND",
      "Config file not found.",
      `Expected one of: ${readCandidates.join(" | ")}`,
    );
  }

  const recovered = recoverConfigFromDefault(
    "CONFIG_INVALID_SCHEMA",
    attemptLogs.join(" | "),
  );
  if (recovered.ok) {
    return recovered;
  }

  return configError(
    "CONFIG_INVALID_SCHEMA",
    "All discovered config files are invalid.",
    attemptLogs.join(" | "),
  );
}

function writeConfigToPath(configPath: string, config: LauncherConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const backupPath = `${configPath}.bak`;
  const tempPath = `${configPath}.tmp`;
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
  }

  fs.writeFileSync(tempPath, serialized, "utf8");
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  fs.renameSync(tempPath, configPath);
}

function recoverConfigFromDefault(
  reason: "CONFIG_NOT_FOUND" | "CONFIG_INVALID_SCHEMA",
  details: string,
): ApiResult<LauncherConfig> {
  const writablePath = getWritableConfigPath();
  appendLog(
    `Config auto-recovery requested reason=${reason} details=${details} target=${writablePath}`,
  );

  const parsedDefault = launcherConfigSchema.safeParse(DEFAULT_RECOVERY_CONFIG);
  if (!parsedDefault.success) {
    const schemaDetails = parsedDefault.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join(" | ");
    appendLog(`Config auto-recovery failed: default schema invalid: ${schemaDetails}`);
    return configError(
      "CONFIG_INVALID_SCHEMA",
      "Default recovery config is invalid.",
      schemaDetails,
    );
  }

  try {
    writeConfigToPath(writablePath, parsedDefault.data);
  } catch (error) {
    appendLog(`Config auto-recovery write failed: ${formatUnknownError(error)}`);
    return configError(
      "CONFIG_WRITE_FAILED",
      "Failed to write recovered config file.",
      formatUnknownError(error),
    );
  }

  const reloaded = loadConfigFromPath(writablePath);
  if (!reloaded.ok) {
    appendLog(
      `Config auto-recovery reload failed: ${reloaded.error.code} ${reloaded.error.details ?? reloaded.error.message}`,
    );
    return reloaded;
  }

  cachedConfigRaw = reloaded.data;
  cachedConfigForRenderer = toRendererConfig(reloaded.data);
  pendingRecoveryNotice = "설정 오류를 감지해 기본 설정으로 복구했습니다.";
  appendLog(`Config auto-recovery success path=${writablePath}`);
  return { ok: true, data: cachedConfigForRenderer };
}

function normalizeRendererAssetForStorage(assetPath: string | undefined): string | undefined {
  if (!assetPath) {
    return undefined;
  }

  if (!assetPath.startsWith("file://")) {
    return assetPath;
  }

  try {
    const absolutePath = fileURLToPath(assetPath);
    const rootCandidates = [getResourcesRoot(), getProjectRoot()];

    for (const root of rootCandidates) {
      const normalizedRoot = path.resolve(root);
      const normalizedAbsolute = path.resolve(absolutePath);
      if (normalizedAbsolute.startsWith(`${normalizedRoot}${path.sep}`)) {
        const relativePath = path.relative(normalizedRoot, normalizedAbsolute);
        return normalizePathToPosix(relativePath);
      }
    }

    return normalizePathToPosix(absolutePath);
  } catch {
    return assetPath;
  }
}

async function saveConfig(input: unknown): Promise<SaveConfigResult> {
  const normalizedInput =
    typeof input === "object" && input !== null
      ? {
          ...(input as LauncherConfig),
          app: {
            ...(input as LauncherConfig).app,
            emptyStateImage: normalizeRendererAssetForStorage(
              (input as LauncherConfig).app?.emptyStateImage,
            ),
          },
          items: Array.isArray((input as LauncherConfig).items)
            ? (input as LauncherConfig).items.map((item) => ({
                ...item,
                icon: normalizeRendererAssetForStorage(item.icon),
              }))
            : (input as LauncherConfig).items,
        }
      : input;

  const schemaResult = launcherConfigSchema.safeParse(normalizedInput);
  if (!schemaResult.success) {
    const details = schemaResult.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join(" | ");
    return configError(
      "CONFIG_INVALID_SCHEMA",
      "Config schema validation failed while saving.",
      details,
    );
  }

  try {
    const enrichedItems = await Promise.all(
      schemaResult.data.items.map(async (item) => {
        if (!shouldResolveFileIcon(item.target, item.icon)) {
          return item;
        }
        const resolvedIcon = await resolveFileIconDataUrl(item.target);
        if (!resolvedIcon) {
          return item;
        }
        return {
          ...item,
          icon: resolvedIcon,
        };
      }),
    );
    const configPath = getWritableConfigPath();
    writeConfigToPath(configPath, { ...schemaResult.data, items: enrichedItems });
  } catch (error) {
    return configError(
      "CONFIG_WRITE_FAILED",
      "Failed to save config file.",
      formatUnknownError(error),
    );
  }

  appendLog(`Config saved to: ${getWritableConfigPath()}`);
  return loadConfig();
}

function normalizeArgs(args: LauncherItem["args"]): string[] {
  if (Array.isArray(args)) {
    return args;
  }

  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return [];
    }

    const match = trimmed.match(/[^\s"]+|"[^"]*"/g);
    if (!match) {
      return [];
    }

    return match.map((token) => token.replace(/^"(.*)"$/, "$1"));
  }

  return [];
}

function isBareCommandTarget(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value.includes("\\") || value.includes("/")) {
    return false;
  }

  return true;
}

function resolveWindowsCommandPath(command: string): string | null {
  if (process.platform !== "win32" || !isBareCommandTarget(command)) {
    return null;
  }

  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && fs.existsSync(line));

  if (candidates.length === 0) {
    return null;
  }

  const nonWindowsAppsCandidate = candidates.find(
    (candidate) => !candidate.toLowerCase().includes("\\windowsapps\\"),
  );

  return nonWindowsAppsCandidate ?? candidates[0];
}

function launchError(
  code: ErrResult["error"]["code"],
  message: string,
  details?: string,
): LaunchResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

async function openPathTarget(
  targetPath: string,
  itemName: string,
): Promise<LaunchResult> {
  const openResult = await shell.openPath(targetPath);
  if (openResult) {
    return launchError(
      "TARGET_LAUNCH_FAILED",
      `Failed to open path for '${itemName}'.`,
      openResult,
    );
  }
  return { ok: true, message: `Opened: ${itemName}` };
}

async function spawnProcess(
  executable: string,
  args: string[],
  cwd: string,
  itemName: string,
): Promise<LaunchResult> {
  const isBareCommand =
    !executable.includes("\\") && !executable.includes("/") && executable.length > 0;

  const spawnDetachedProcess = async (useShell: boolean): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        detached: true,
        shell: useShell,
        stdio: "ignore",
        windowsHide: true,
      });

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };

  try {
    await spawnDetachedProcess(false);
  } catch (error) {
    const launchFailure = error as NodeJS.ErrnoException;
    if (launchFailure.code === "ENOENT" && isBareCommand) {
      appendLog(
        `Primary spawn failed with ENOENT for '${itemName}', retrying with shell=true target=${executable}`,
      );
      try {
        await spawnDetachedProcess(true);
      } catch (fallbackError) {
        return launchError(
          "TARGET_LAUNCH_FAILED",
          `Failed to launch '${itemName}'.`,
          formatUnknownError(fallbackError),
        );
      }

      return { ok: true, message: `Launched: ${itemName}` };
    }

    if (launchFailure.code === "EACCES" || launchFailure.code === "EPERM") {
      return launchError(
        "TARGET_PERMISSION_DENIED",
        `Permission denied while launching '${itemName}'.`,
        formatUnknownError(error),
      );
    }

    return launchError(
      "TARGET_LAUNCH_FAILED",
      `Failed to launch '${itemName}'.`,
      formatUnknownError(error),
    );
  }

  return { ok: true, message: `Launched: ${itemName}` };
}

function isWindowsProcessImageRunning(imageName: string): boolean {
  if (process.platform !== "win32") {
    return true;
  }

  const result = spawnSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  const output = result.stdout.trim().toLowerCase();
  if (!output) {
    return false;
  }

  return !output.includes("no tasks are running");
}

async function verifyProcessLaunch(imageName: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return true;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (isWindowsProcessImageRunning(imageName)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return false;
}

async function launchItem(item: LauncherItem): Promise<LaunchResult> {
  const target = item.target.trim();
  const args = normalizeArgs(item.args);

  if (/^https?:\/\//i.test(target)) {
    try {
      await shell.openExternal(target);
    } catch (error) {
      return launchError(
        "TARGET_LAUNCH_FAILED",
        `Failed to open URL for '${item.name}'.`,
        formatUnknownError(error),
      );
    }

    return { ok: true, message: `Opened URL: ${item.name}` };
  }

  const resolvedCommandPath = resolveWindowsCommandPath(target);
  const absoluteTarget = path.isAbsolute(target)
    ? target
    : resolvedCommandPath && path.isAbsolute(resolvedCommandPath)
      ? resolvedCommandPath
      : null;
  let executableNoArgsAbsoluteTarget: string | null = null;

  if (resolvedCommandPath) {
    appendLog(
      `Resolved command target item='${item.name}' original='${target}' resolved='${resolvedCommandPath}'`,
    );
  }

  if (absoluteTarget && !fs.existsSync(absoluteTarget)) {
    return launchError(
      "TARGET_NOT_FOUND",
      `Target path does not exist for '${item.name}'.`,
      absoluteTarget,
    );
  }

  if (absoluteTarget) {
    const stat = fs.statSync(absoluteTarget);
    if (stat.isDirectory()) {
      return openPathTarget(absoluteTarget, item.name);
    }
    if (stat.isFile() && args.length === 0) {
      const extension = path.extname(absoluteTarget).toLowerCase();
      if (!EXECUTABLE_EXTENSIONS.has(extension)) {
        return openPathTarget(absoluteTarget, item.name);
      }
      executableNoArgsAbsoluteTarget = absoluteTarget;
    }
  }

  const workingDirCandidate = item.workingDir?.trim();
  const workingDir =
    workingDirCandidate && workingDirCandidate.length > 0
      ? workingDirCandidate
      : absoluteTarget
        ? path.dirname(absoluteTarget)
        : process.cwd();

  if (workingDirCandidate && !fs.existsSync(workingDir)) {
    return launchError(
      "TARGET_NOT_FOUND",
      `Working directory not found for '${item.name}'.`,
      workingDir,
    );
  }

  if (executableNoArgsAbsoluteTarget) {
    const spawned = await spawnProcess(
      executableNoArgsAbsoluteTarget,
      [],
      workingDir,
      item.name,
    );
    if (!spawned.ok) {
      return spawned;
    }

    const imageName = path.basename(executableNoArgsAbsoluteTarget);
    const verified = await verifyProcessLaunch(imageName);
    if (verified) {
      return spawned;
    }

    appendLog(
      `Process verification failed after spawn item='${item.name}' image='${imageName}', retrying with shell.openPath`,
    );
    return openPathTarget(executableNoArgsAbsoluteTarget, item.name);
  }

  const launchTarget = absoluteTarget ?? target;
  return spawnProcess(launchTarget, args, workingDir, item.name);
}

function getCachedConfig(): ApiResult<LauncherConfig> {
  if (cachedConfigRaw) {
    return { ok: true, data: cachedConfigRaw };
  }

  const loaded = loadConfig();
  if (!loaded.ok || !cachedConfigRaw) {
    return loaded;
  }
  return { ok: true, data: cachedConfigRaw };
}

function clearWidgetSizePersistTimer(): void {
  if (!widgetSizePersistTimer) {
    return;
  }
  clearTimeout(widgetSizePersistTimer);
  widgetSizePersistTimer = null;
}

async function persistWidgetSize(width: number, height: number, trigger: string): Promise<void> {
  const normalizedWidth = Math.max(1, Math.round(width));
  const normalizedHeight = Math.max(MIN_WIDGET_HEIGHT_PX, Math.round(height));

  if (
    lastPersistedWidgetSize &&
    lastPersistedWidgetSize.width === normalizedWidth &&
    lastPersistedWidgetSize.height === normalizedHeight
  ) {
    return;
  }

  const configResult = getCachedConfig();
  if (!configResult.ok) {
    appendLog(
      `Widget size save skipped trigger=${trigger} reason=config-not-ready details=${
        configResult.error.details ?? configResult.error.message
      }`,
    );
    return;
  }

  const currentConfig = configResult.data;
  const currentWidget = currentConfig.app.widget ?? {};
  if (
    currentWidget.width === normalizedWidth &&
    currentWidget.height === normalizedHeight
  ) {
    lastPersistedWidgetSize = { width: normalizedWidth, height: normalizedHeight };
    return;
  }

  const saveResult = await saveConfig({
    ...currentConfig,
    app: {
      ...currentConfig.app,
      widget: {
        ...currentWidget,
        width: normalizedWidth,
        height: normalizedHeight,
      },
    },
  });

  if (!saveResult.ok) {
    appendLog(
      `Widget size save failed trigger=${trigger} code=${saveResult.error.code} details=${
        saveResult.error.details ?? saveResult.error.message
      }`,
    );
    return;
  }

  lastPersistedWidgetSize = { width: normalizedWidth, height: normalizedHeight };
  appendLog(
    `Widget size saved trigger=${trigger} width=${normalizedWidth} height=${normalizedHeight}`,
  );
}

function scheduleWidgetSizePersistence(trigger: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
    return;
  }

  clearWidgetSizePersistTimer();
  widgetSizePersistTimer = setTimeout(() => {
    widgetSizePersistTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
      return;
    }
    const bounds = mainWindow.getBounds();
    persistWidgetSize(bounds.width, bounds.height, trigger);
  }, WIDGET_SIZE_PERSIST_DEBOUNCE_MS);
}

function flushWidgetSizePersistence(trigger: string): void {
  clearWidgetSizePersistTimer();
  if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
    return;
  }

  const bounds = widgetHomeBounds ?? mainWindow.getBounds();
  persistWidgetSize(bounds.width, bounds.height, trigger);
}

function getWidgetBounds(config: LauncherConfig["app"]): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
  const widget = config.widget ?? {};
  const width = widget.width ?? 460;
  const height = Math.max(MIN_WIDGET_HEIGHT_PX, widget.height ?? 760);
  const offsetX = widget.offsetX ?? 0;
  const offsetY = widget.offsetY ?? 0;
  const anchor = widget.anchor ?? "bottom-right";

  const workArea = screen.getPrimaryDisplay().workArea;
  const rightX = workArea.x + workArea.width - width - offsetX;
  const leftX = workArea.x + offsetX;
  const topY = workArea.y + offsetY;
  const bottomY = workArea.y + workArea.height - height - offsetY;

  if (anchor === "top-left") {
    return { width, height, x: leftX, y: topY };
  }
  if (anchor === "top-right") {
    return { width, height, x: rightX, y: topY };
  }
  if (anchor === "bottom-left") {
    return { width, height, x: leftX, y: bottomY };
  }

  return { width, height, x: rightX, y: bottomY };
}

function clearWidgetCursorWatch(): void {
  if (!widgetCursorWatchInterval) {
    return;
  }

  clearInterval(widgetCursorWatchInterval);
  widgetCursorWatchInterval = null;
}

function clearWidgetFocusWatch(): void {
  if (!widgetFocusWatchInterval) {
    return;
  }

  clearInterval(widgetFocusWatchInterval);
  widgetFocusWatchInterval = null;
}

function clearRestoreBlurGuard(): void {
  if (widgetRestoreBlurGuardTimer) {
    clearInterval(widgetRestoreBlurGuardTimer);
    widgetRestoreBlurGuardTimer = null;
  }
  widgetRestoreBlurGuardExpireAt = 0;
}

function armRestoreBlurGuard(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
    return;
  }

  clearRestoreBlurGuard();
  widgetRestoreBlurGuardExpireAt = Date.now() + 3000;
  appendLog("Restore blur guard armed for 3000ms.");

  widgetRestoreBlurGuardTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
      clearRestoreBlurGuard();
      return;
    }

    if (widgetDocked || !mainWindow.isVisible()) {
      clearRestoreBlurGuard();
      return;
    }

    if (Date.now() >= widgetRestoreBlurGuardExpireAt) {
      appendLog("Restore blur guard expired without fallback action.");
      clearRestoreBlurGuard();
      return;
    }

    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow === mainWindow) {
      return;
    }

    if (!focusedWindow) {
      return;
    }

    appendLog(
      `Restore blur guard fallback executed (focusedWindow=${focusedWindow.getTitle()}).`,
    );
    clearRestoreBlurGuard();
    applyWidgetHideAction("blur");
  }, 120);
}

function clearWidgetOutsideClickWatch(): void {
  if (!widgetOutsideClickWatcher) {
    return;
  }

  widgetOutsideClickWatcher.stop();
  widgetOutsideClickWatcher = null;
  appendLog("Outside-click watcher stopped.");
}

function hasWidgetFocus(): boolean {
  if (!mainWindow) {
    return false;
  }
  const focusedWindow = BrowserWindow.getFocusedWindow();
  return focusedWindow === mainWindow;
}

function forceFocusMainWindow(options?: { sustain?: boolean }): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const sustain = options?.sustain ?? true;

  if (widgetFocusAcquireTimer) {
    clearInterval(widgetFocusAcquireTimer);
    widgetFocusAcquireTimer = null;
  }

  let focusLogged = false;
  const attemptFocus = (stage: string): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const wasAlwaysOnTop = mainWindow.isAlwaysOnTop();
    mainWindow.show();
    mainWindow.moveTop();
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true, "screen-saver");
    }
    mainWindow.focus();
    mainWindow.webContents.focus();
    if (process.platform === "win32" && !wasAlwaysOnTop) {
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        mainWindow.setAlwaysOnTop(false);
      }, 80);
    }
    if (hasWidgetFocus() && !focusLogged) {
      appendLog(`Widget focus acquired stage=${stage}`);
      focusLogged = true;
    }
  };

  attemptFocus("initial");
  if (hasWidgetFocus()) {
    return;
  }

  if (!sustain) {
    return;
  }

  const intervalMs = 50;
  const maxDurationMs = 3000;
  let elapsedMs = 0;
  widgetFocusAcquireTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (widgetFocusAcquireTimer) {
        clearInterval(widgetFocusAcquireTimer);
        widgetFocusAcquireTimer = null;
      }
      return;
    }

    if (hasWidgetFocus()) {
      if (widgetFocusAcquireTimer) {
        clearInterval(widgetFocusAcquireTimer);
        widgetFocusAcquireTimer = null;
      }
      return;
    }

    elapsedMs += intervalMs;
    attemptFocus(`retry-${Math.max(1, Math.floor(elapsedMs / intervalMs))}`);
    if (hasWidgetFocus()) {
      if (widgetFocusAcquireTimer) {
        clearInterval(widgetFocusAcquireTimer);
        widgetFocusAcquireTimer = null;
      }
      return;
    }

    if (elapsedMs >= maxDurationMs) {
      appendLog("Widget focus not acquired within 3000ms.");
      if (widgetFocusAcquireTimer) {
        clearInterval(widgetFocusAcquireTimer);
        widgetFocusAcquireTimer = null;
      }
    }
  }, intervalMs);
}

function revealAndForceFocus(
  reason: string,
  options?: { aggressive?: boolean },
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const aggressive = options?.aggressive ?? true;

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  appendLog(`Reveal + focus requested reason=${reason}`);
  forceFocusMainWindow({ sustain: aggressive });

  const retryDelays = aggressive ? [120, 280, 520] : [];
  retryDelays.forEach((delay, index) => {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || hasWidgetFocus()) {
        return;
      }

      appendLog(
        `Reveal focus fallback retry=${index + 1} reason=${reason} delayMs=${delay}`,
      );
      forceFocusMainWindow({ sustain: aggressive });
    }, delay);
  });
}

function isPointInsideBounds(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function getWidgetOutsideClickPollSettings(): {
  intervalMs: number;
  refreshRate: number;
} {
  const display = screen.getPrimaryDisplay();
  const detectedRefreshRate =
    typeof display.displayFrequency === "number" && display.displayFrequency > 0
      ? display.displayFrequency
      : 60;
  const targetInterval = Math.round((1000 / detectedRefreshRate) * 3);
  const intervalMs = Math.max(16, Math.min(60, targetInterval));
  return {
    intervalMs,
    refreshRate: detectedRefreshRate,
  };
}

function applyWidgetHideAction(trigger: "blur" | "outside-click"): void {
  if (!mainWindow || !widgetModeEnabled || !mainWindow.isVisible()) {
    return;
  }

  // Reset leave-based auto-dock gate after a completed hide/dock cycle.
  widgetPointerLeaveAutoDockEnabled = true;
  widgetFocusWatchCursorInsideSeen = false;

  if (widgetHideOnTrigger) {
    appendLog(`Widget hide action executed trigger=${trigger}`);
    mainWindow.hide();
    return;
  }

  if (widgetDockOnTrigger) {
    appendLog(`Widget dock action requested trigger=${trigger}`);
    dockWidgetWindow();
    return;
  }

  appendLog(`Widget trigger ignored trigger=${trigger} reason=no-action`);
}

function startWidgetOutsideClickWatch(): void {
  if (
    !mainWindow ||
    !widgetModeEnabled ||
    widgetHideTrigger !== "outside-click" ||
    (!widgetHideOnTrigger && !widgetDockOnTrigger) ||
    widgetOutsideClickWatcher
  ) {
    return;
  }

  const { intervalMs, refreshRate } = getWidgetOutsideClickPollSettings();

  try {
    widgetOutsideClickWatcher = createWindowsOutsideClickWatcher({
      intervalMs,
      getCursorPoint: () => screen.getCursorScreenPoint(),
      isPointInside: (point) => {
        if (!mainWindow) {
          return false;
        }
        return isPointInsideBounds(point, mainWindow.getBounds());
      },
      onMouseDownEdge: ({ button, point, inside }) => {
        appendLog(
          `Outside-click edge button=${button} x=${point.x} y=${point.y} inside=${inside}`,
        );
      },
      onWatcherNotice: (message) => {
        appendLog(`Outside-click watcher notice: ${message}`);
        if (
          !widgetOutsideClickFallbackApplied &&
          widgetHideTrigger === "outside-click" &&
          message.includes("worker exited")
        ) {
          widgetHideTrigger = "blur";
          widgetOutsideClickFallbackApplied = true;
          appendLog("Outside-click watcher unavailable; fallback trigger switched to blur.");
        }
      },
      onOutsideClick: ({ button, point }) => {
        appendLog(
          `Outside-click trigger button=${button} x=${point.x} y=${point.y} docked=${widgetDocked}`,
        );
        if (widgetDocked) {
          return;
        }
        applyWidgetHideAction("outside-click");
      },
    });
  } catch (error) {
    appendLog(`Outside-click watcher init failed: ${formatUnknownError(error)}`);
    if (!widgetOutsideClickFallbackApplied && widgetHideTrigger === "outside-click") {
      widgetHideTrigger = "blur";
      widgetOutsideClickFallbackApplied = true;
      appendLog("Outside-click watcher init failed; fallback trigger switched to blur.");
    }
    return;
  }

  widgetOutsideClickWatcher.start();
  appendLog(
    `Outside-click watcher started interval=${intervalMs}ms refreshRate=${refreshRate}Hz`,
  );
}

function startWidgetFocusWatch(): void {
  if (!mainWindow || widgetFocusWatchInterval || !widgetModeEnabled) {
    return;
  }

  if (widgetHideTrigger !== "blur" || !widgetDockOnTrigger) {
    return;
  }

  widgetFocusWatchInterval = setInterval(() => {
    if (!mainWindow || !widgetModeEnabled) {
      return;
    }

    if (!widgetDockOnTrigger || widgetDocked || widgetHideTrigger !== "blur") {
      return;
    }

    if (!mainWindow.isVisible()) {
      return;
    }

    if (!widgetPointerLeaveAutoDockEnabled) {
      return;
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const cursorInsideWindow = isPointInsideBounds(cursorPoint, bounds);

    if (cursorInsideWindow) {
      widgetFocusWatchCursorInsideSeen = true;
      return;
    }

    if (!widgetFocusWatchCursorInsideSeen) {
      return;
    }

    widgetFocusWatchCursorInsideSeen = false;
    appendLog("Widget docked by focus-watch (cursor leave).");
    dockWidgetWindow();
  }, 140);
}

function getWidgetDockBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayMatching(bounds);
  const workAreaTop = display.workArea.y;
  const workAreaBottom = display.workArea.y + display.workArea.height;
  const maxTop = Math.max(workAreaTop, workAreaBottom - bounds.height);
  const dockY = Math.max(workAreaTop, Math.min(bounds.y, maxTop));

  return {
    x: display.workArea.x + display.workArea.width - widgetEdgeVisiblePx,
    y: dockY,
    width: bounds.width,
    height: bounds.height,
  };
}

function restoreDockedWidget(shouldFocus: boolean): void {
  if (!mainWindow || !widgetDocked) {
    return;
  }

  const fallbackBounds = mainWindow.getBounds();
  const targetBounds = widgetHomeBounds ?? fallbackBounds;
  mainWindow.setBounds(targetBounds, false);
  appendLog(
    `Widget restored bounds x=${targetBounds.x} y=${targetBounds.y} w=${targetBounds.width} h=${targetBounds.height}`,
  );

  widgetDocked = false;
  widgetFocusWatchCursorInsideSeen = false;
  clearWidgetCursorWatch();

  if (shouldFocus) {
    armRestoreBlurGuard();
    revealAndForceFocus("restore-docked", { aggressive: false });
  }
}

function startWidgetCursorWatch(): void {
  if (!mainWindow || !widgetDocked || widgetCursorWatchInterval) {
    return;
  }

  // Require cursor to leave strip once before allowing restore.
  widgetCursorRestoreReady = false;

  widgetCursorWatchInterval = setInterval(() => {
    if (!mainWindow || !widgetDocked) {
      return;
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const stripWidth = Math.max(2, widgetEdgeVisiblePx);
    const onVisibleStrip =
      cursorPoint.x >= bounds.x &&
      cursorPoint.x <= bounds.x + stripWidth &&
      cursorPoint.y >= bounds.y &&
      cursorPoint.y <= bounds.y + bounds.height;

    if (!onVisibleStrip) {
      widgetCursorRestoreReady = true;
      return;
    }

    if (widgetCursorRestoreReady) {
      widgetCursorRestoreReady = false;
      restoreDockedWidget(true);
    }
  }, 120);
}

function dockWidgetWindow(): void {
  if (!mainWindow || !widgetModeEnabled || !widgetDockOnTrigger || widgetDocked) {
    return;
  }

  if (!mainWindow.isVisible()) {
    return;
  }

  const currentBounds = mainWindow.getBounds();
  widgetHomeBounds = currentBounds;

  const dockBounds = getWidgetDockBounds(currentBounds);
  mainWindow.setBounds(dockBounds, false);
  const applied = mainWindow.getBounds();
  appendLog(
    `Widget docked requested x=${dockBounds.x} y=${dockBounds.y} w=${dockBounds.width} h=${dockBounds.height}; applied x=${applied.x} y=${applied.y} w=${applied.width} h=${applied.height}`,
  );
  widgetDocked = true;
  widgetFocusWatchCursorInsideSeen = false;
  widgetCursorRestoreReady = false;
  startWidgetCursorWatch();
}

function createMainWindow(): void {
  const configResult = getCachedConfig();
  const appConfig = configResult.ok
    ? configResult.data.app
    : { title: "Papa Launcher", fullscreen: true };
  const windowTitle = appConfig.title;
  const mode =
    appConfig.mode ?? (appConfig.fullscreen ? "fullscreen" : "widget");
  const isWidgetMode = mode === "widget";
  const widgetBounds = getWidgetBounds(appConfig);
  const widget = appConfig.widget ?? {};
  const blurBehavior = widget.blurBehavior ?? (widget.hideOnBlur ? "hide" : "none");
  const configuredHideTrigger = widget.hideTrigger ?? "blur";
  const hideTrigger =
    process.platform === "win32" && configuredHideTrigger === "outside-click"
      ? "blur"
      : configuredHideTrigger;
  const widgetResizable = isWidgetMode ? (widget.resizable ?? false) : true;
  const dockOnBlurBehavior =
    blurBehavior === "dock-right-edge" || blurBehavior === "windows-docking";

  widgetModeEnabled = isWidgetMode;
  widgetDocked = false;
  lastWidgetBlurActionAt = 0;
  clearWidgetCursorWatch();
  clearWidgetFocusWatch();
  clearRestoreBlurGuard();
  clearWidgetOutsideClickWatch();
  clearWidgetSizePersistTimer();
  widgetHomeBounds = isWidgetMode ? { ...widgetBounds } : null;
  lastPersistedWidgetSize = isWidgetMode
    ? { width: widgetBounds.width, height: widgetBounds.height }
    : null;
  widgetEdgeVisiblePx = isWidgetMode
    ? Math.max(2, Math.min(60, widget.edgeVisiblePx ?? 4))
    : 30;
  widgetHideOnTrigger = isWidgetMode ? blurBehavior === "hide" : false;
  widgetDockOnTrigger = isWidgetMode ? dockOnBlurBehavior : false;
  widgetHideTrigger = isWidgetMode ? hideTrigger : "blur";
  if (
    isWidgetMode &&
    process.platform === "win32" &&
    configuredHideTrigger === "outside-click"
  ) {
    appendLog(
      "Windows security compatibility: hideTrigger=outside-click overridden to blur.",
    );
  }
  widgetToggleShortcut = isWidgetMode
    ? widget.toggleShortcut?.trim() || null
    : null;
  widgetOutsideClickFallbackApplied = false;
  if (widgetFocusAcquireTimer) {
    clearInterval(widgetFocusAcquireTimer);
    widgetFocusAcquireTimer = null;
  }
  widgetCursorRestoreReady = false;
  widgetFocusWatchCursorInsideSeen = false;
  widgetPointerLeaveAutoDockEnabled = true;

  mainWindow = new BrowserWindow({
    title: windowTitle,
    show: false,
    fullscreen: !isWidgetMode,
    width: isWidgetMode ? widgetBounds.width : undefined,
    height: isWidgetMode ? widgetBounds.height : undefined,
    x: isWidgetMode ? widgetBounds.x : undefined,
    y: isWidgetMode ? widgetBounds.y : undefined,
    resizable: widgetResizable,
    minWidth: isWidgetMode && widgetResizable ? widgetBounds.width : undefined,
    maxWidth: isWidgetMode && widgetResizable ? widgetBounds.width : undefined,
    minHeight: isWidgetMode ? MIN_WIDGET_HEIGHT_PX : undefined,
    frame: isWidgetMode ? (widget.frame ?? true) : true,
    alwaysOnTop: isWidgetMode ? (widget.alwaysOnTop ?? true) : false,
    skipTaskbar: isWidgetMode ? (widget.skipTaskbar ?? false) : false,
    maximizable: isWidgetMode ? false : true,
    fullscreenable: !isWidgetMode,
    autoHideMenuBar: true,
    backgroundColor: isWidgetMode ? "#00000000" : "#081124",
    transparent: isWidgetMode,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isWidgetMode) {
    setTimeout(() => {
      revealAndForceFocus("post-create");
    }, 0);
  }

  mainWindow.once("ready-to-show", () => {
    forceFocusMainWindow();
    setTimeout(() => forceFocusMainWindow(), 80);
    setTimeout(() => forceFocusMainWindow(), 220);
    if (isWidgetMode) {
      mainWindow?.setPosition(widgetBounds.x, widgetBounds.y);
      widgetHomeBounds = { ...widgetBounds };
      startWidgetFocusWatch();
      startWidgetOutsideClickWatch();
    }

    if (smokeEnterExpectedItemId) {
      appendLog(`Smoke enter mode started expectedItemId=${smokeEnterExpectedItemId}`);
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        mainWindow.focus();
        mainWindow.webContents.focus();
        mainWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        mainWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        appendLog("Smoke enter mode sent Enter key.");
      }, 1800);

      setTimeout(() => {
        appendLog(
          `Smoke enter mode finished expectedItemId=${smokeEnterExpectedItemId} matched=${String(
            smokeEnterLaunchMatched,
          )}`,
        );
        app.exit(smokeEnterLaunchMatched ? 0 : 21);
      }, 4500);
    }
  });

  const handleWidgetBlur = (source: string): void => {
    if (!isWidgetMode) {
      return;
    }

    const now = Date.now();
    if (now - lastWidgetBlurActionAt < 140) {
      return;
    }
    lastWidgetBlurActionAt = now;

    clearRestoreBlurGuard();
    appendLog(`Widget blur event received source=${source}.`);

    // blurBehavior=windows-docking (or dock-right-edge) should dock on blur
    // even when hideTrigger is outside-click.
    if (widgetHideTrigger !== "blur" && !widgetDockOnTrigger) {
      return;
    }

    applyWidgetHideAction("blur");
  };

  const onWindowBlur = (): void => {
    handleWidgetBlur("window");
  };
  const onWebContentsBlur = (): void => {
    handleWidgetBlur("webContents");
  };
  const onAppBrowserWindowBlur = (_event: unknown, blurredWindow: BrowserWindow): void => {
    if (!mainWindow || blurredWindow !== mainWindow) {
      return;
    }
    handleWidgetBlur("app-browser-window-blur");
  };

  mainWindow.on("blur", onWindowBlur);
  mainWindow.webContents.on("blur", onWebContentsBlur);
  app.on("browser-window-blur", onAppBrowserWindowBlur);

  mainWindow.on("focus", () => {
    if (!isWidgetMode || !widgetDocked) {
      return;
    }

    restoreDockedWidget(true);
  });

  mainWindow.on("resize", () => {
    if (!isWidgetMode || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const bounds = mainWindow.getBounds();
    widgetHomeBounds = { ...bounds };
    scheduleWidgetSizePersistence("window-resize");
  });

  mainWindow.on("close", () => {
    if (!isWidgetMode) {
      return;
    }
    flushWidgetSizePersistence("window-close");
  });

  mainWindow.on("closed", () => {
    clearWidgetCursorWatch();
    clearWidgetFocusWatch();
    clearRestoreBlurGuard();
    clearWidgetOutsideClickWatch();
    app.off("browser-window-blur", onAppBrowserWindowBlur);
    clearWidgetSizePersistTimer();
    widgetDocked = false;
    mainWindow = null;
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(
      `render-process-gone reason=${details.reason} exitCode=${String(details.exitCode)}`,
    );
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, validatedURL) => {
      appendLog(
        `did-fail-load code=${String(code)} description=${description} url=${validatedURL}`,
      );
    },
  );

  mainWindow.webContents.once("did-finish-load", () => {
    if (!isWidgetMode) {
      return;
    }
    revealAndForceFocus("did-finish-load");
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(getRendererHtmlPath());
  }
}

function focusMainWindowForSecondInstance(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (widgetDocked) {
    restoreDockedWidget(true);
    return;
  }

  if (!mainWindow.isVisible()) {
    revealAndForceFocus("second-instance-hidden");
    return;
  }

  revealAndForceFocus("second-instance-visible");
}

function toggleWidgetWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (widgetDocked) {
    restoreDockedWidget(true);
    return;
  }

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }

  if (!mainWindow.isVisible()) {
    revealAndForceFocus("toggle-show");
    return;
  }

  revealAndForceFocus("toggle-visible");
}

function registerWidgetShortcut(): void {
  globalShortcut.unregisterAll();

  if (!widgetToggleShortcut) {
    return;
  }

  let registered = false;
  try {
    registered = globalShortcut.register(widgetToggleShortcut, () => {
      toggleWidgetWindow();
    });
  } catch (error) {
    appendLog(
      `Shortcut registration error (${widgetToggleShortcut}): ${formatUnknownError(error)}`,
    );
    return;
  }

  if (!registered) {
    appendLog(`Failed to register widget shortcut: ${widgetToggleShortcut}`);
    return;
  }

  appendLog(`Registered widget shortcut: ${widgetToggleShortcut}`);
}

ipcMain.handle("launcher:getConfig", async (): Promise<ApiResult<LauncherConfig>> => {
  return loadConfig();
});

ipcMain.handle("launcher:reloadConfig", async (): Promise<ReloadResult> => {
  return loadConfig();
});

ipcMain.handle("launcher:consumeRecoveryNotice", async (): Promise<string | null> => {
  const notice = pendingRecoveryNotice;
  pendingRecoveryNotice = null;
  return notice;
});

ipcMain.handle("launcher:widgetBodyInteracted", async (): Promise<void> => {
  if (!mainWindow || mainWindow.isDestroyed() || !widgetModeEnabled) {
    return;
  }
  if (!mainWindow.isVisible() || widgetDocked) {
    return;
  }
  if (!widgetDockOnTrigger || widgetHideTrigger !== "blur") {
    return;
  }
  if (!widgetPointerLeaveAutoDockEnabled) {
    return;
  }

  widgetPointerLeaveAutoDockEnabled = false;
  widgetFocusWatchCursorInsideSeen = false;
  appendLog("Widget pointer-leave auto-dock temporarily disabled by body interaction.");
});

ipcMain.handle("launcher:quit", async (): Promise<void> => {
  requestAppQuit("renderer-ipc");
});

ipcMain.handle(
  "launcher:pickLaunchTarget",
  async (_event, targetType: "file" | "folder" = "file"): Promise<string | null> => {
  try {
    const ownerWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const pickingFolder = targetType === "folder";
    const options: OpenDialogOptions = pickingFolder
      ? {
          title: "Select folder to add",
          properties: ["openDirectory"],
        }
      : {
          title: "Select file to add",
          properties: ["openFile"],
          filters: [{ name: "All Files", extensions: ["*"] }],
        };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      appendLog("Pick launch target canceled.");
      return null;
    }

    const selectedPath = normalizePathToPosix(result.filePaths[0]);
    appendLog(
      `Pick launch target selected type=${pickingFolder ? "folder" : "file"} path=${selectedPath}`,
    );
    return selectedPath;
  } catch (error) {
    appendLog(`Pick launch target failed: ${formatUnknownError(error)}`);
    return null;
  }
  },
);

ipcMain.handle(
  "launcher:scanFolderImportTargets",
  async (_event, folderPath: string): Promise<FolderImportScanResult | null> => {
    try {
      const result = scanFolderImportTargets(folderPath);
      if (!result) {
        appendLog(`Scan folder import targets failed path=${folderPath} reason=invalid-folder`);
        return null;
      }
      appendLog(
        `Scan folder import targets success path=${result.rootPath} entries=${result.entries.length} topLevelEntries=${result.topLevelEntries.length} nestedDirs=${result.nestedDirectoryCount} dirs=${result.scannedDirectoryCount} truncated=${String(result.truncated)}`,
      );
      return result;
    } catch (error) {
      appendLog(`Scan folder import targets failed: ${formatUnknownError(error)}`);
      return null;
    }
  },
);

ipcMain.handle("launcher:pickItemIconPath", async (): Promise<string | null> => {
  try {
    const ownerWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const options: OpenDialogOptions = {
      title: "Select item icon",
      properties: ["openFile"],
      filters: [
        { name: "Image Files", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp", "svg", "ico"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      appendLog("Pick item icon canceled.");
      return null;
    }

    const selectedPath = normalizePathToPosix(result.filePaths[0]);
    appendLog(`Pick item icon selected path=${selectedPath}`);
    return selectedPath;
  } catch (error) {
    appendLog(`Pick item icon failed: ${formatUnknownError(error)}`);
    return null;
  }
});

ipcMain.handle("launcher:pickEmptyStateImage", async (): Promise<string | null> => {
  try {
    const ownerWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const options: OpenDialogOptions = {
      title: "Select empty-state background image",
      properties: ["openFile"],
      filters: [
        { name: "Image Files", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      appendLog("Pick empty-state image canceled.");
      return null;
    }

    const selectedPath = normalizePathToPosix(result.filePaths[0]);
    appendLog(`Pick empty-state image selected path=${selectedPath}`);
    return selectedPath;
  } catch (error) {
    appendLog(`Pick empty-state image failed: ${formatUnknownError(error)}`);
    return null;
  }
});

ipcMain.handle(
  "launcher:saveConfig",
  async (_event, config: unknown): Promise<SaveConfigResult> => {
    return saveConfig(config);
  },
);

ipcMain.handle(
  "launcher:launchItem",
  async (_event, itemId: string): Promise<LaunchResult> => {
    appendLog(`Launch request received itemId=${itemId}`);
    if (smokeEnterExpectedItemId && itemId === smokeEnterExpectedItemId) {
      smokeEnterLaunchMatched = true;
    }
    const configResult = getCachedConfig();
    if (!configResult.ok) {
      appendLog(
        `Launch request failed itemId=${itemId} reason=config-not-ready details=${
          configResult.error.details ?? configResult.error.message
        }`,
      );
      return {
        ok: false,
        error: {
          code: "CONFIG_NOT_READY",
          message: "Config is not ready.",
          details: configResult.error.details ?? configResult.error.message,
        },
      };
    }

    const item = configResult.data.items.find((entry) => entry.id === itemId);
    if (!item) {
      appendLog(`Launch request failed itemId=${itemId} reason=item-not-found`);
      return launchError(
        "ITEM_NOT_FOUND",
        "Selected item does not exist.",
        `itemId: ${itemId}`,
      );
    }

    const result = await launchItem(item);
    if (result.ok) {
      appendLog(`Launch success itemId=${itemId} target=${item.target}`);
    } else {
      appendLog(
        `Launch failure itemId=${itemId} code=${result.error.code} details=${
          result.error.details ?? ""
        }`,
      );
    }
    return result;
  },
);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  appendLog("Application started.");
  const smokeLaunchItemId = getCliOptionValue(SMOKE_LAUNCH_ARG_PREFIX);
  if (smokeLaunchItemId) {
    appendLog(`Smoke launch mode started itemId=${smokeLaunchItemId}`);
    const configResult = getCachedConfig();
    if (!configResult.ok) {
      appendLog(
        `Smoke launch failed itemId=${smokeLaunchItemId} reason=config-not-ready details=${
          configResult.error.details ?? configResult.error.message
        }`,
      );
      app.exit(11);
      return;
    }

    const item = configResult.data.items.find((entry) => entry.id === smokeLaunchItemId);
    if (!item) {
      appendLog(`Smoke launch failed itemId=${smokeLaunchItemId} reason=item-not-found`);
      app.exit(12);
      return;
    }

    const launchResult = await launchItem(item);
    if (launchResult.ok) {
      appendLog(`Smoke launch success itemId=${smokeLaunchItemId} target=${item.target}`);
      app.exit(0);
    } else {
      appendLog(
        `Smoke launch failure itemId=${smokeLaunchItemId} code=${launchResult.error.code} details=${
          launchResult.error.details ?? ""
        }`,
      );
      app.exit(13);
    }
    return;
  }

  const smokeEnterItemId = getCliOptionValue(SMOKE_ENTER_ARG_PREFIX);
  if (smokeEnterItemId) {
    smokeEnterExpectedItemId = smokeEnterItemId;
    smokeEnterLaunchMatched = false;
  } else {
    smokeEnterExpectedItemId = null;
    smokeEnterLaunchMatched = false;
  }

  createMainWindow();
  registerWidgetShortcut();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      registerWidgetShortcut();
    }
  });
});

app.on("window-all-closed", () => {
  appendLog("All windows closed.");
  if (process.platform !== "darwin") {
    requestAppQuit("window-all-closed");
  }
});

app.on("will-quit", () => {
  if (quitFallbackTimer) {
    clearTimeout(quitFallbackTimer);
    quitFallbackTimer = null;
  }
  clearWidgetSizePersistTimer();
  lastPersistedWidgetSize = null;
  globalShortcut.unregisterAll();
  clearWidgetCursorWatch();
  clearWidgetFocusWatch();
  clearWidgetOutsideClickWatch();
});

process.on("uncaughtException", (error) => {
  appendLog(`uncaughtException: ${formatUnknownError(error)}`);
});

process.on("unhandledRejection", (reason) => {
  appendLog(`unhandledRejection: ${formatUnknownError(reason)}`);
});
