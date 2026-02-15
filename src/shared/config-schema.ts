import { z } from "zod";
import type { LauncherConfig } from "./types";

const nonEmptyText = z.string().trim().min(1);
const positiveInt = z.number().int().positive();

const launcherAppSchema = z.object({
  title: nonEmptyText,
  fullscreen: z.boolean(),
  mode: z.enum(["fullscreen", "widget"]).optional(),
  widget: z
    .object({
      width: positiveInt.optional(),
      height: positiveInt.optional(),
      anchor: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional(),
      offsetX: z.number().int().optional(),
      offsetY: z.number().int().optional(),
      alwaysOnTop: z.boolean().optional(),
      skipTaskbar: z.boolean().optional(),
      resizable: z.boolean().optional(),
      frame: z.boolean().optional(),
      hideOnBlur: z.boolean().optional(),
      hideTrigger: z.enum(["blur", "outside-click"]).optional(),
      blurBehavior: z
        .enum(["none", "hide", "dock-right-edge", "windows-docking"])
        .optional(),
      edgeVisiblePx: z.number().int().min(2).max(60).optional(),
      toggleShortcut: nonEmptyText.optional(),
    })
    .optional(),
  theme: nonEmptyText.optional(),
});

const launcherCategorySchema = z.object({
  id: nonEmptyText,
  label: nonEmptyText,
});

const launcherItemSchema = z.object({
  id: nonEmptyText,
  name: nonEmptyText,
  categoryId: nonEmptyText,
  target: nonEmptyText,
  args: z.union([z.string(), z.array(z.string())]).optional(),
  workingDir: nonEmptyText.optional(),
  icon: nonEmptyText.optional(),
  keywords: z.array(nonEmptyText).optional(),
});

export const launcherConfigSchema = z
  .object({
    version: z.literal(2),
    app: launcherAppSchema,
    categories: z.array(launcherCategorySchema).min(1),
    items: z.array(launcherItemSchema),
  })
  .superRefine((value, ctx) => {
    const categoryIds = new Set<string>();
    for (const category of value.categories) {
      if (categoryIds.has(category.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories"],
          message: `Duplicate category id: ${category.id}`,
        });
      }
      categoryIds.add(category.id);
    }

    const itemIds = new Set<string>();
    for (const item of value.items) {
      if (itemIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: `Duplicate item id: ${item.id}`,
        });
      }
      itemIds.add(item.id);

      if (!categoryIds.has(item.categoryId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: `Unknown category id '${item.categoryId}' in item '${item.id}'`,
        });
      }
    }
  });

export const parseLauncherConfig = (input: unknown): LauncherConfig =>
  launcherConfigSchema.parse(input) as LauncherConfig;
