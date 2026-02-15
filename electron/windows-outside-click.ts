import { spawn, type ChildProcess } from "node:child_process";

export type MouseButton = "left" | "right" | "middle";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface MouseDownEdgeEvent {
  button: MouseButton;
  point: ScreenPoint;
  inside: boolean;
}

export interface OutsideClickEvent {
  button: MouseButton;
  point: ScreenPoint;
}

export interface WindowsOutsideClickWatcherOptions {
  intervalMs: number;
  getCursorPoint: () => ScreenPoint;
  isPointInside: (point: ScreenPoint) => boolean;
  onOutsideClick: (event: OutsideClickEvent) => void;
  onMouseDownEdge?: (event: MouseDownEdgeEvent) => void;
  onWatcherNotice?: (message: string) => void;
}

export interface WindowsOutsideClickWatcher {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
}

const VK_BY_BUTTON: Record<MouseButton, number> = {
  left: 0x01,
  right: 0x02,
  middle: 0x04,
};

function createNoopWatcher(): WindowsOutsideClickWatcher {
  return {
    start: () => undefined,
    stop: () => undefined,
    isRunning: () => false,
  };
}

function buildPowerShellScript(intervalMs: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class User32 { [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey); }'",
    "$prevLeft = $false",
    "$prevRight = $false",
    "$prevMiddle = $false",
    "[Console]::WriteLine(\"ready\")",
    "while ($true) {",
    "  $left = ([User32]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0",
    "  if ($left -and -not $prevLeft) {",
    "    [Console]::WriteLine(\"left\")",
    "  }",
    "  $prevLeft = $left",
    "  $right = ([User32]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0",
    "  if ($right -and -not $prevRight) {",
    "    [Console]::WriteLine(\"right\")",
    "  }",
    "  $prevRight = $right",
    "  $middle = ([User32]::GetAsyncKeyState(0x04) -band 0x8000) -ne 0",
    "  if ($middle -and -not $prevMiddle) {",
    "    [Console]::WriteLine(\"middle\")",
    "  }",
    "  $prevMiddle = $middle",
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    "}",
    "",
  ].join("\n");
}

function parseButton(raw: string): MouseButton | null {
  if (raw === "left" || raw === "right" || raw === "middle") {
    return raw;
  }
  return null;
}

export function createWindowsOutsideClickWatcher(
  options: WindowsOutsideClickWatcherOptions,
): WindowsOutsideClickWatcher {
  if (process.platform !== "win32") {
    return createNoopWatcher();
  }

  const intervalMs = Math.max(8, Math.floor(options.intervalMs));
  let child: ChildProcess | null = null;
  let stdoutBuffer = "";

  const onStdoutData = (chunk: string): void => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed === "ready") {
        options.onWatcherNotice?.("ready");
        continue;
      }

      const button = parseButton(trimmed);
      if (!button) {
        continue;
      }

      if (!(button in VK_BY_BUTTON)) {
        continue;
      }

      const point = options.getCursorPoint();
      const inside = options.isPointInside(point);
      options.onMouseDownEdge?.({ button, point, inside });
      if (!inside) {
        options.onOutsideClick({ button, point });
      }
    }
  };

  return {
    start: () => {
      if (child) {
        return;
      }

      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-EncodedCommand",
          Buffer.from(buildPowerShellScript(intervalMs), "utf16le").toString("base64"),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      const startedChild = child;
      if (!startedChild.stdout || !startedChild.stderr) {
        options.onWatcherNotice?.("spawned without stdio; stopping watcher");
        startedChild.kill();
        child = null;
        stdoutBuffer = "";
        return;
      }

      startedChild.stdout.setEncoding("utf8");
      startedChild.stdout.on("data", onStdoutData);
      startedChild.stderr.setEncoding("utf8");
      startedChild.stderr.on("data", (chunk: string) => {
        const message = chunk.trim();
        if (!message || message.startsWith("#< CLIXML")) {
          return;
        }
        options.onWatcherNotice?.(`stderr: ${message}`);
      });
      startedChild.on("exit", (code, signal) => {
        options.onWatcherNotice?.(
          `worker exited code=${String(code)} signal=${String(signal)}`,
        );
        child = null;
        stdoutBuffer = "";
      });
    },
    stop: () => {
      if (!child) {
        return;
      }

      const currentChild = child;
      child = null;
      currentChild.kill();
      stdoutBuffer = "";
    },
    isRunning: () => child !== null,
  };
}
