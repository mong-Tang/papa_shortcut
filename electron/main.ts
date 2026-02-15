import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
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
  LaunchResult,
  LauncherConfig,
  LauncherItem,
  ReloadResult,
  SaveConfigResult,
} from "../src/shared/types";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const EXECUTABLE_EXTENSIONS = new Set([".exe", ".bat", ".cmd", ".com"]);
const SMOKE_LAUNCH_ARG_PREFIX = "--smoke-launch-item=";
const SMOKE_ENTER_ARG_PREFIX = "--smoke-enter-item=";

let mainWindow: BrowserWindow | null = null;
let cachedConfigRaw: LauncherConfig | null = null;
let cachedConfigForRenderer: LauncherConfig | null = null;
let widgetModeEnabled = false;
let widgetHideOnTrigger = false;
let widgetDockOnTrigger = false;
let widgetHideTrigger: "blur" | "outside-click" = "outside-click";
let widgetDocked = false;
let widgetEdgeVisiblePx = 6;
let widgetHomeBounds: { width: number; height: number; x: number; y: number } | null = null;
let widgetCursorWatchInterval: NodeJS.Timeout | null = null;
let widgetFocusWatchInterval: NodeJS.Timeout | null = null;
let widgetOutsideClickWatcher: WindowsOutsideClickWatcher | null = null;
let widgetToggleShortcut: string | null = null;
let smokeEnterExpectedItemId: string | null = null;
let smokeEnterLaunchMatched = false;

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

function resolveIconPath(icon: string | undefined): string | undefined {
  if (!icon) {
    return undefined;
  }

  if (/^(https?:\/\/|file:\/\/|data:)/i.test(icon)) {
    return icon;
  }

  const absolutePath = toAbsolutePath(icon);

  if (!fs.existsSync(absolutePath)) {
    return icon;
  }

  return pathToFileURL(absolutePath).toString();
}

function toRendererConfig(config: LauncherConfig): LauncherConfig {
  return {
    ...config,
    items: config.items.map((item) => ({
      ...item,
      icon: resolveIconPath(item.icon),
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
    return configError(
      "CONFIG_NOT_FOUND",
      "Config file not found.",
      `Expected one of: ${readCandidates.join(" | ")}`,
    );
  }

  return configError(
    "CONFIG_INVALID_SCHEMA",
    "All discovered config files are invalid.",
    attemptLogs.join(" | "),
  );
}

function normalizeIconForStorage(icon: string | undefined): string | undefined {
  if (!icon) {
    return undefined;
  }

  if (!icon.startsWith("file://")) {
    return icon;
  }

  try {
    const absolutePath = fileURLToPath(icon);
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
    return icon;
  }
}

function saveConfig(input: unknown): SaveConfigResult {
  const normalizedInput =
    typeof input === "object" && input !== null
      ? {
          ...(input as LauncherConfig),
          items: Array.isArray((input as LauncherConfig).items)
            ? (input as LauncherConfig).items.map((item) => ({
                ...item,
                icon: normalizeIconForStorage(item.icon),
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
    const configPath = getWritableConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const backupPath = `${configPath}.bak`;
    const tempPath = `${configPath}.tmp`;
    const serialized = `${JSON.stringify(schemaResult.data, null, 2)}\n`;

    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, backupPath);
    }

    fs.writeFileSync(tempPath, serialized, "utf8");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    fs.renameSync(tempPath, configPath);
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

function getWidgetBounds(config: LauncherConfig["app"]): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
  const widget = config.widget ?? {};
  const width = widget.width ?? 460;
  const height = widget.height ?? 760;
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
  return mainWindow.isFocused() || mainWindow.webContents.isFocused();
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

    const cursorPoint = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const cursorInsideWindow = isPointInsideBounds(cursorPoint, bounds);

    // Fallback for Windows focus-steal restrictions:
    // if focus state is unreliable after hover-restore, dock once cursor leaves.
    if (!hasWidgetFocus() && !cursorInsideWindow) {
      appendLog("Widget docked by focus-watch (unfocused + cursor outside).");
      dockWidgetWindow();
    }
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
  clearWidgetCursorWatch();

  if (shouldFocus) {
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.webContents.focus();
    setTimeout(() => {
      if (!mainWindow || widgetDocked || hasWidgetFocus()) {
        return;
      }
      mainWindow.focus();
      mainWindow.webContents.focus();
    }, 80);
  }
}

function startWidgetCursorWatch(): void {
  if (!mainWindow || !widgetDocked || widgetCursorWatchInterval) {
    return;
  }

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

    if (onVisibleStrip) {
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
  const hideTrigger = widget.hideTrigger ?? "outside-click";
  const widgetResizable = isWidgetMode ? (widget.resizable ?? false) : true;
  const dockOnBlurBehavior =
    blurBehavior === "dock-right-edge" || blurBehavior === "windows-docking";

  widgetModeEnabled = isWidgetMode;
  widgetDocked = false;
  clearWidgetCursorWatch();
  clearWidgetFocusWatch();
  clearWidgetOutsideClickWatch();
  widgetHomeBounds = isWidgetMode ? { ...widgetBounds } : null;
  widgetEdgeVisiblePx = isWidgetMode
    ? Math.max(2, Math.min(60, widget.edgeVisiblePx ?? 30))
    : 30;
  widgetHideOnTrigger = isWidgetMode ? blurBehavior === "hide" : false;
  widgetDockOnTrigger = isWidgetMode ? dockOnBlurBehavior : false;
  widgetHideTrigger = isWidgetMode ? hideTrigger : "outside-click";
  widgetToggleShortcut = isWidgetMode
    ? widget.toggleShortcut?.trim() || "Control+Shift+Space"
    : null;

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

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
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

  mainWindow.on("blur", () => {
    if (!isWidgetMode) {
      return;
    }
    appendLog("Widget blur event received.");

    if (widgetHideTrigger !== "blur") {
      return;
    }

    applyWidgetHideAction("blur");
  });

  mainWindow.on("focus", () => {
    if (!isWidgetMode || !widgetDocked) {
      return;
    }

    restoreDockedWidget(false);
  });

  mainWindow.on("closed", () => {
    clearWidgetCursorWatch();
    clearWidgetFocusWatch();
    clearWidgetOutsideClickWatch();
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

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(getRendererHtmlPath());
  }
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
    mainWindow.show();
  }

  mainWindow.focus();
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
    app.quit();
  }
});

app.on("will-quit", () => {
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
