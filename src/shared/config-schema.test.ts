import { describe, expect, it } from "vitest";
import { launcherConfigSchema } from "./config-schema";

describe("launcherConfigSchema", () => {
  it("accepts a valid v2 config", () => {
    const valid = {
      version: 2,
      app: {
        title: "Papa Launcher",
        fullscreen: false,
        mode: "widget",
        widget: {
          width: 460,
          height: 760,
          anchor: "bottom-right",
          offsetX: 24,
          offsetY: 24,
          alwaysOnTop: true,
          hideTrigger: "outside-click",
          blurBehavior: "windows-docking",
          edgeVisiblePx: 30,
        },
      },
      categories: [
        { id: "all", label: "전체" },
        { id: "tool", label: "유틸" },
      ],
      items: [
        {
          id: "notepad",
          name: "메모장",
          categoryId: "tool",
          target: "notepad.exe",
        },
      ],
    };

    const result = launcherConfigSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects unknown category references", () => {
    const invalid = {
      version: 2,
      app: {
        title: "Papa Launcher",
        fullscreen: true,
      },
      categories: [{ id: "all", label: "전체" }],
      items: [
        {
          id: "notepad",
          name: "메모장",
          categoryId: "tool",
          target: "notepad.exe",
        },
      ],
    };

    const result = launcherConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unknown category id");
    }
  });

  it("rejects duplicate ids", () => {
    const invalid = {
      version: 2,
      app: {
        title: "Papa Launcher",
        fullscreen: true,
      },
      categories: [
        { id: "all", label: "전체" },
        { id: "all", label: "전체2" },
      ],
      items: [],
    };

    const result = launcherConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Duplicate category id");
    }
  });

  it("rejects unknown hide trigger", () => {
    const invalid = {
      version: 2,
      app: {
        title: "Papa Launcher",
        fullscreen: false,
        mode: "widget",
        widget: {
          hideTrigger: "invalid-trigger",
        },
      },
      categories: [{ id: "all", label: "all" }],
      items: [],
    };

    const result = launcherConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
