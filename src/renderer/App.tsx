import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type {
  ApiResult,
  FolderImportCandidate,
  FolderImportScanResult,
  LauncherCategory,
  LauncherConfig,
  LauncherItem,
} from "@shared/types";

interface ErrorModal {
  title: string;
  message: string;
  details?: string;
  severity?: "error" | "warning";
}

interface CategoryChip {
  id: string;
  label: string;
  kind: "main" | "all";
}

interface NewItemDraft {
  target: string;
  name: string;
  workingDir?: string;
}

interface FolderImportPrepared {
  nextCategories: LauncherCategory[];
  nextItems: LauncherItem[];
  addedItemCount: number;
  skippedDuplicateCount: number;
  addedCategoryCount: number;
  firstImportedCategoryId: string | null;
}

interface FolderImportPending {
  scanResult: FolderImportScanResult;
  prepared: FolderImportPrepared;
  source: "picker" | "drop";
}

interface FolderImportStrategyPending {
  scanResult: FolderImportScanResult;
  source: "picker" | "drop";
}

interface DeleteCategoryConfirm {
  id: string;
  label: string;
  itemCount: number;
}

type CoreCategoryId = "document" | "game" | "web" | "tool";

const ALL_FILTER_ID = "__all__";
const CORE_CATEGORY_DEFAULT_LABELS: Record<CoreCategoryId, string> = {
  document: "Document",
  game: "Game",
  web: "Web",
  tool: "Tool",
};
const CORE_CATEGORY_ORDER: CoreCategoryId[] = ["document", "game", "web", "tool"];
const MAIN_CATEGORY_CHIPS: CategoryChip[] = CORE_CATEGORY_ORDER.map((id) => ({
  id,
  label: CORE_CATEGORY_DEFAULT_LABELS[id],
  kind: "main",
}));
const ALL_CATEGORY_CHIP: CategoryChip = { id: ALL_FILTER_ID, label: "All", kind: "all" };

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function isProtectedCategoryId(categoryId: string): boolean {
  return categoryId === "all" || toCoreCategoryId(categoryId) !== null;
}

function isImageLikePath(value: string): boolean {
  return /\.(png|jpe?g|gif|bmp|webp|svg|ico)(?:$|[?#])/i.test(value);
}

function getEditableCategories(categories: LauncherCategory[]): LauncherCategory[] {
  return categories.filter((category) => category.id !== "all");
}

function ensureCoreCategories(config: LauncherConfig): LauncherConfig {
  const existingIds = new Set(config.categories.map((category) => category.id));
  const missingCoreCategories = MAIN_CATEGORY_CHIPS
    .filter((chip) => !existingIds.has(chip.id))
    .map((chip) => ({ id: chip.id, label: chip.label }));

  if (missingCoreCategories.length === 0) {
    return config;
  }

  return {
    ...config,
    categories: [...config.categories, ...missingCoreCategories],
  };
}

function toCoreCategoryId(value: string): CoreCategoryId | null {
  switch (value) {
    case "document":
    case "game":
    case "web":
    case "tool":
      return value;
    default:
      return null;
  }
}

function getCoreCategoryLabels(categories: LauncherCategory[]): Record<CoreCategoryId, string> {
  const labels: Record<CoreCategoryId, string> = {
    ...CORE_CATEGORY_DEFAULT_LABELS,
  };

  for (const category of categories) {
    const coreId = toCoreCategoryId(category.id);
    if (!coreId) {
      continue;
    }
    const normalizedLabel = category.label.trim();
    labels[coreId] =
      normalizedLabel.length > 0 ? normalizedLabel : CORE_CATEGORY_DEFAULT_LABELS[coreId];
  }

  return labels;
}

function orderEditorCategories(categories: LauncherCategory[]): LauncherCategory[] {
  const byId = new Map(categories.map((category) => [category.id, category] as const));
  const ordered: LauncherCategory[] = [];

  for (const chip of MAIN_CATEGORY_CHIPS) {
    const coreCategory = byId.get(chip.id);
    if (!coreCategory) {
      continue;
    }
    ordered.push(coreCategory);
    byId.delete(chip.id);
  }

  for (const category of categories) {
    if (!byId.has(category.id)) {
      continue;
    }
    ordered.push(category);
    byId.delete(category.id);
  }

  return ordered;
}

function clampContextMenuPosition(position: { x: number; y: number }): { x: number; y: number } {
  const MENU_WIDTH = 200;
  const MENU_HEIGHT = 56;
  const PADDING = 8;
  const maxX = Math.max(PADDING, window.innerWidth - MENU_WIDTH - PADDING);
  const maxY = Math.max(PADDING, window.innerHeight - MENU_HEIGHT - PADDING);
  return {
    x: Math.min(Math.max(position.x, PADDING), maxX),
    y: Math.min(Math.max(position.y, PADDING), maxY),
  };
}

function toConfigError(result: ApiResult<LauncherConfig>): ErrorModal | null {
  if (result.ok) {
    return null;
  }
  return {
    title: "Config Load Failed",
    message: result.error.message,
    details: result.error.details,
  };
}

function getIconSrc(icon: string | undefined): string | undefined {
  if (!icon) {
    return undefined;
  }
  if (/^data:/i.test(icon)) {
    return /^data:image\//i.test(icon) ? icon : undefined;
  }
  if (/^(https?:\/\/|file:\/\/)/i.test(icon) && isImageLikePath(icon)) {
    return icon;
  }
  return undefined;
}

function parseKeywords(input: string): string[] | undefined {
  const values = input
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return values.length > 0 ? values : undefined;
}

function keywordsToString(keywords: string[] | undefined): string {
  return keywords?.join(", ") ?? "";
}

function inferItemNameFromTarget(target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  const fileName = normalizedTarget.split("/").filter(Boolean).pop() ?? "";
  if (!fileName) {
    return "New Item";
  }

  const nameWithoutExtension = fileName.replace(/\.[^.]+$/, "");
  return nameWithoutExtension || fileName;
}

function inferWorkingDirFromTarget(target: string): string | undefined {
  const normalizedTarget = target.replace(/\\/g, "/");
  const lastSeparatorIndex = normalizedTarget.lastIndexOf("/");
  if (lastSeparatorIndex <= 0) {
    return undefined;
  }
  return normalizedTarget.slice(0, lastSeparatorIndex);
}

function normalizeTargetForComparison(target: string): string {
  return target.replace(/\\/g, "/").trim().toLowerCase();
}

function cloneItems(items: LauncherItem[]): LauncherItem[] {
  return items.map((item) => ({
    ...item,
    args: Array.isArray(item.args) ? [...item.args] : item.args,
    keywords: item.keywords ? [...item.keywords] : undefined,
  }));
}

function mergeItemsByCategory(
  sourceItems: LauncherItem[],
  categoryId: string,
  scopedItems: LauncherItem[],
): LauncherItem[] {
  const scopedById = new Map(scopedItems.map((item) => [item.id, item] as const));
  const merged: LauncherItem[] = [];

  for (const item of sourceItems) {
    if (item.categoryId === categoryId) {
      const replacement = scopedById.get(item.id);
      if (replacement) {
        merged.push(replacement);
        scopedById.delete(item.id);
      }
      continue;
    }

    if (scopedById.has(item.id)) {
      continue;
    }

    merged.push(item);
  }

  for (const item of scopedItems) {
    if (scopedById.has(item.id)) {
      merged.push(item);
      scopedById.delete(item.id);
    }
  }

  return merged;
}

function normalizeItem(item: LauncherItem): LauncherItem {
  return {
    ...item,
    id: item.id.trim(),
    name: item.name.trim(),
    categoryId: item.categoryId.trim(),
    target: item.target.trim(),
    args: typeof item.args === "string" ? item.args.trim() : item.args,
    workingDir: item.workingDir?.trim() || undefined,
    icon: item.icon?.trim() || undefined,
    keywords: item.keywords?.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0),
  };
}

function validateItems(items: LauncherItem[], categories: LauncherCategory[]): string | null {
  const categoryIds = new Set(categories.map((category) => category.id));
  const usedIds = new Set<string>();

  for (const [index, item] of items.entries()) {
    const row = index + 1;
    const id = item.id.trim();
    const name = item.name.trim();
    const categoryId = item.categoryId.trim();
    const target = item.target.trim();

    if (!id) {
      return `Item #${row}: ID is required.`;
    }
    if (usedIds.has(id)) {
      return `Item #${row}: duplicated ID '${id}'.`;
    }
    usedIds.add(id);

    if (!name) {
      return `Item #${row}: Name is required.`;
    }
    if (!categoryId) {
      return `Item #${row}: Category is required.`;
    }
    if (categoryId === "all") {
      return `Item #${row}: Category 'all' is filter-only.`;
    }
    if (!categoryIds.has(categoryId)) {
      return `Item #${row}: Unknown category '${categoryId}'.`;
    }
    if (!target) {
      return `Item #${row}: Target is required.`;
    }
  }

  return null;
}

export default function App(): JSX.Element {
  const EDITOR_AUTOSAVE_DEBOUNCE_MS = 500;
  const [config, setConfig] = useState<LauncherConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<ErrorModal | null>(null);

  const [search, setSearch] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusText, setStatusText] = useState("Preparing widget...");
  const [launchingItemId, setLaunchingItemId] = useState<string | null>(null);
  const [errorModal, setErrorModal] = useState<ErrorModal | null>(null);
  const [quitting, setQuitting] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorItems, setEditorItems] = useState<LauncherItem[]>([]);
  const [editorOriginalItems, setEditorOriginalItems] = useState<LauncherItem[]>([]);
  const [editorCategoryId, setEditorCategoryId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<LauncherItem | null>(null);
  const [deleteConfirmCategory, setDeleteConfirmCategory] = useState<DeleteCategoryConfirm | null>(null);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameSaving, setRenameSaving] = useState(false);
  const [folderImportDragActive, setFolderImportDragActive] = useState(false);
  const [folderImportPending, setFolderImportPending] = useState<FolderImportPending | null>(null);
  const [folderImportStrategyPending, setFolderImportStrategyPending] =
    useState<FolderImportStrategyPending | null>(null);
  const [renameDraftLabels, setRenameDraftLabels] = useState<Record<CoreCategoryId, string>>({
    ...CORE_CATEGORY_DEFAULT_LABELS,
  });
  const [emptyStateMenuPosition, setEmptyStateMenuPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [emptyStateImageSaving, setEmptyStateImageSaving] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemListRef = useRef<HTMLElement>(null);
  const lastBodyInteractionNotifyAtRef = useRef(0);

  const categoryChips = useMemo<CategoryChip[]>(() => {
    const labelByCoreId = getCoreCategoryLabels(config?.categories ?? []);
    const mainCategoryChips = CORE_CATEGORY_ORDER.map((id) => ({
      id,
      label: labelByCoreId[id],
      kind: "main" as const,
    }));
    const allCategoryLabel =
      config?.categories.find((category) => category.id === "all")?.label ??
      ALL_CATEGORY_CHIP.label;
    return [...mainCategoryChips, { ...ALL_CATEGORY_CHIP, label: allCategoryLabel }];
  }, [config?.categories]);
  const extraCategories = useMemo(
    () =>
      (config?.categories ?? []).filter(
        (category) =>
          category.id !== "all" &&
          !CORE_CATEGORY_ORDER.includes(category.id as CoreCategoryId),
      ),
    [config?.categories],
  );

  const editableCategories = useMemo(() => config?.categories ?? [], [config]);
  const editorCategoryOptions = useMemo(() => {
    return orderEditorCategories(getEditableCategories(editableCategories));
  }, [editableCategories]);
  const editorSelectedCategory = useMemo(
    () => editorCategoryOptions.find((category) => category.id === editorCategoryId) ?? null,
    [editorCategoryId, editorCategoryOptions],
  );
  const hasPickedEditorCategory = useMemo(
    () => typeof editorCategoryId === "string" && editorCategoryId.trim().length > 0,
    [editorCategoryId],
  );
  const shouldDisableRenameButton = useMemo(
    () => hasPickedEditorCategory || editorSelectedCategory !== null,
    [hasPickedEditorCategory, editorSelectedCategory],
  );
  const canDeleteEditorCategory = useMemo(() => {
    if (!editorCategoryId || !config) {
      return false;
    }
    if (isProtectedCategoryId(editorCategoryId)) {
      return false;
    }
    return config.categories.some((category) => category.id === editorCategoryId);
  }, [config, editorCategoryId]);
  const primaryAddButtonLabel = useMemo(
    () => (editorCategoryId ? "Add Item" : "Import Folder"),
    [editorCategoryId],
  );
  const emptyStateImageSrc = useMemo(
    () => getIconSrc(config?.app.emptyStateImage),
    [config?.app.emptyStateImage],
  );
  const isIdleEmptyState = selectedCategoryId === null;

  const filteredItems = useMemo(() => {
    if (!config || selectedCategoryId === null) {
      return [];
    }

    const normalizedSearch = normalizeText(search);

    return config.items.filter((item) => {
      const categoryMatched = selectedCategoryId === ALL_FILTER_ID || item.categoryId === selectedCategoryId;
      if (!categoryMatched) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const text = [item.name, item.target, ...(item.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      return text.includes(normalizedSearch);
    });
  }, [config, search, selectedCategoryId]);

  const selectedItem = filteredItems[selectedIndex] ?? null;
  const editingItem = editorItems.find((item) => item.id === editingItemId) ?? null;
  const currentMode = useMemo(() => {
    if (!config) {
      return "fullscreen";
    }
    return config.app.mode ?? (config.app.fullscreen ? "fullscreen" : "widget");
  }, [config]);
  const widgetBlurBehavior = useMemo(() => {
    if (!config) {
      return "none";
    }
    const widget = config.app.widget;
    return widget?.blurBehavior ?? (widget?.hideOnBlur ? "hide" : "none");
  }, [config]);
  const editorDirty = useMemo(() => {
    if (!editorOpen) {
      return false;
    }
    return JSON.stringify(editorItems) !== JSON.stringify(editorOriginalItems);
  }, [editorItems, editorOpen, editorOriginalItems]);

  async function loadConfig(reload = false): Promise<void> {
    setLoading(true);
    setConfigError(null);

    const result = reload
      ? await window.launcherApi.reloadConfig()
      : await window.launcherApi.getConfig();

    const error = toConfigError(result);
    if (error) {
      setConfig(null);
      setConfigError(error);
      setStatusText("Config load failed.");
      setLoading(false);
      return;
    }

    const normalizedConfig = ensureCoreCategories(result.data);
    setConfig(normalizedConfig);
    setSelectedCategoryId(null);
    setSelectedIndex(0);
    setEmptyStateMenuPosition(null);
    const recoveryNotice = await window.launcherApi.consumeRecoveryNotice();
    setStatusText(recoveryNotice ?? `Loaded ${normalizedConfig.items.length} items.`);
    setLoading(false);

    if (normalizedConfig !== result.data) {
      void window.launcherApi.saveConfig(normalizedConfig).catch(() => undefined);
    }
  }

  function openEditor(): void {
    if (!config) {
      return;
    }

    setEditorItems([]);
    setEditorOriginalItems([]);
    setEditorCategoryId(null);
    setEditingItemId(null);
    setEditorOpen(true);
  }

  function syncEditorCategoryItems(
    sourceConfig: LauncherConfig,
    categoryId: string | null,
    preferredItemId?: string | null,
  ): void {
    setEditorCategoryId(categoryId);

    if (!categoryId) {
      setEditorItems([]);
      setEditorOriginalItems([]);
      setEditingItemId(null);
      return;
    }

    const scopedItems = cloneItems(
      sourceConfig.items.filter((item) => item.categoryId === categoryId),
    );
    setEditorItems(scopedItems);
    setEditorOriginalItems(cloneItems(scopedItems));

    const nextEditingItemId =
      preferredItemId && scopedItems.some((item) => item.id === preferredItemId)
        ? preferredItemId
        : scopedItems[0]?.id ?? null;
    setEditingItemId(nextEditingItemId);
  }

  function changeEditorCategory(nextCategoryId: string | null): void {
    if (!config) {
      return;
    }

    if (nextCategoryId === editorCategoryId) {
      return;
    }

    if (editorSaving) {
      return;
    }

    if (editorDirty) {
      const shouldSwitch = window.confirm(
        "Unsaved changes will be lost. Change category?",
      );
      if (!shouldSwitch) {
        return;
      }
    }

    syncEditorCategoryItems(config, nextCategoryId);
  }

  function openRenameModal(): void {
    if (!config || editorSaving || shouldDisableRenameButton) {
      return;
    }

    const labels = getCoreCategoryLabels(config.categories);
    setRenameDraftLabels(labels);
    setRenameModalOpen(true);
  }

  function closeRenameModal(): void {
    if (renameSaving) {
      return;
    }
    setRenameModalOpen(false);
  }

  async function saveRenamedCategoryLabels(): Promise<void> {
    if (!config) {
      return;
    }

    const nextLabels: Record<CoreCategoryId, string> = {
      document: renameDraftLabels.document.trim(),
      game: renameDraftLabels.game.trim(),
      web: renameDraftLabels.web.trim(),
      tool: renameDraftLabels.tool.trim(),
    };

    for (const id of CORE_CATEGORY_ORDER) {
      if (!nextLabels[id]) {
        setErrorModal({
          title: "Rename Failed",
          message: "Category button name cannot be empty.",
        });
        return;
      }
    }

    const uniqueLabels = new Set(Object.values(nextLabels));
    if (uniqueLabels.size !== CORE_CATEGORY_ORDER.length) {
      setErrorModal({
        title: "Rename Failed",
        message: "Category button names must be unique.",
      });
      return;
    }

    const normalizedConfig = ensureCoreCategories(config);
    const renamedConfig: LauncherConfig = {
      ...normalizedConfig,
      categories: normalizedConfig.categories.map((category) => {
        const coreId = toCoreCategoryId(category.id);
        if (!coreId) {
          return category;
        }
        return {
          ...category,
          label: nextLabels[coreId],
        };
      }),
    };

    setRenameSaving(true);
    const result = await window.launcherApi.saveConfig(renamedConfig);
    setRenameSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Rename Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    const savedConfig = ensureCoreCategories(result.data);
    setConfig(savedConfig);
    setRenameModalOpen(false);
    setStatusText("Category button names updated.");

    if (editorOpen && editorCategoryId) {
      syncEditorCategoryItems(savedConfig, editorCategoryId, editingItemId);
    }
  }

  function closeEditor(force = false): void {
    if (editorSaving) {
      return;
    }

    if (!force && editorDirty) {
      const shouldClose = window.confirm("Unsaved changes will be lost. Close editor?");
      if (!shouldClose) {
        return;
      }
    }

    setEditorOpen(false);
    setEditorItems([]);
    setEditorOriginalItems([]);
    setEditorCategoryId(null);
    setEditingItemId(null);
    setDeleteConfirmItem(null);
    setDeleteConfirmCategory(null);
    setRenameModalOpen(false);
    setFolderImportDragActive(false);
    setFolderImportPending(null);
    setFolderImportStrategyPending(null);
  }

  async function closeEditorAndFlush(): Promise<void> {
    if (editorSaving) {
      return;
    }

    if (editorDirty && editorCategoryId) {
      const saved = await saveEditorItems({ silent: true });
      if (!saved) {
        return;
      }
    }

    closeEditor(true);
  }

  function onClickPrimaryAddButton(): void {
    if (!editorCategoryId) {
      void addCategoryFromFolder();
      return;
    }

    void createEditorItem();
  }

  function toCategoryIdCandidate(label: string): string {
    return label.trim().toLowerCase().replace(/\s+/g, "-");
  }

  function toUniqueCategoryId(baseLabel: string, categories: LauncherCategory[]): string {
    const normalizedBase = toCategoryIdCandidate(baseLabel) || `category-${Date.now()}`;
    let candidate = normalizedBase;
    let suffix = 2;
    const usedIds = new Set(categories.map((category) => category.id));

    while (candidate === "all" || usedIds.has(candidate)) {
      candidate = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  function toUniqueItemId(baseName: string, usedIds: Set<string>): string {
    const normalizedBase = toCategoryIdCandidate(baseName) || `item-${Date.now()}`;
    let candidate = normalizedBase;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function prepareFolderImport(
    sourceConfig: LauncherConfig,
    candidates: FolderImportCandidate[],
  ): FolderImportPrepared {
    const nextCategories = [...sourceConfig.categories];
    const nextItems = cloneItems(sourceConfig.items);
    const existingTargets = new Set(
      sourceConfig.items.map((item) => normalizeTargetForComparison(item.target)),
    );
    const usedItemIds = new Set(sourceConfig.items.map((item) => item.id));
    const categoryIdByNormalizedLabel = new Map<string, string>();
    for (const category of nextCategories) {
      categoryIdByNormalizedLabel.set(normalizeText(category.label), category.id);
    }

    let addedItemCount = 0;
    let skippedDuplicateCount = 0;
    let addedCategoryCount = 0;
    let firstImportedCategoryId: string | null = null;

    for (const candidate of candidates) {
      const normalizedTarget = normalizeTargetForComparison(candidate.target);
      if (!normalizedTarget || existingTargets.has(normalizedTarget)) {
        skippedDuplicateCount += 1;
        continue;
      }

      const rawLabel = candidate.categoryLabel.trim() || "Imported";
      const normalizedLabel = normalizeText(rawLabel);
      let categoryId = categoryIdByNormalizedLabel.get(normalizedLabel);
      if (!categoryId) {
        categoryId = toUniqueCategoryId(rawLabel, nextCategories);
        nextCategories.push({ id: categoryId, label: rawLabel });
        categoryIdByNormalizedLabel.set(normalizedLabel, categoryId);
        addedCategoryCount += 1;
      }
      if (!firstImportedCategoryId) {
        firstImportedCategoryId = categoryId;
      }

      const itemName = candidate.name.trim() || inferItemNameFromTarget(candidate.target);
      const itemId = toUniqueItemId(itemName, usedItemIds);
      nextItems.push(
        normalizeItem({
          id: itemId,
          name: itemName,
          categoryId,
          target: candidate.target.trim(),
          workingDir: candidate.workingDir?.trim() || inferWorkingDirFromTarget(candidate.target),
          icon: candidate.icon?.trim() || (isImageLikePath(candidate.target) ? candidate.target : undefined),
        }),
      );
      existingTargets.add(normalizedTarget);
      addedItemCount += 1;
    }

    return {
      nextCategories,
      nextItems,
      addedItemCount,
      skippedDuplicateCount,
      addedCategoryCount,
      firstImportedCategoryId,
    };
  }

  function stageFolderImport(
    sourceConfig: LauncherConfig,
    scanResult: FolderImportScanResult,
    candidates: FolderImportCandidate[],
    source: "picker" | "drop",
  ): void {
    const prepared = prepareFolderImport(sourceConfig, candidates);
    if (prepared.addedItemCount === 0) {
      const duplicateMessage = `No new items were added. Skipped duplicates: ${prepared.skippedDuplicateCount}.`;
      setStatusText(
        duplicateMessage,
      );
      setErrorModal({
        title: "Folder Import",
        message: duplicateMessage,
        severity: "warning",
      });
      return;
    }

    const validationError = validateItems(prepared.nextItems, prepared.nextCategories);
    if (validationError) {
      setErrorModal({
        title: "Folder Import Failed",
        message: validationError,
      });
      return;
    }

    setFolderImportPending({
      scanResult,
      prepared,
      source,
    });
  }

  async function importItemsFromFolderPath(folderPath: string, source: "picker" | "drop"): Promise<void> {
    if (!config) {
      return;
    }

    const scanResult = await window.launcherApi.scanFolderImportTargets(folderPath);
    if (!scanResult) {
      setErrorModal({
        title: "Folder Import Failed",
        message: "Folder scan failed. Please verify the folder path and try again.",
      });
      return;
    }

    if (scanResult.nestedDirectoryCount > 0) {
      setFolderImportStrategyPending({
        scanResult,
        source,
      });
      return;
    }

    stageFolderImport(config, scanResult, scanResult.entries, source);
  }

  function cancelFolderImportStrategy(): void {
    setFolderImportStrategyPending(null);
  }

  function chooseFolderImportStrategy(strategy: "top-level-only" | "per-subfolder"): void {
    if (!config || !folderImportStrategyPending) {
      return;
    }
    const { scanResult, source } = folderImportStrategyPending;
    setFolderImportStrategyPending(null);
    stageFolderImport(
      config,
      scanResult,
      strategy === "top-level-only" ? scanResult.topLevelEntries : scanResult.entries,
      source,
    );
  }

  async function applyPendingFolderImport(): Promise<void> {
    if (!config || !folderImportPending) {
      return;
    }

    const { prepared, scanResult, source } = folderImportPending;
    setEditorSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      categories: prepared.nextCategories,
      items: prepared.nextItems,
    });
    setEditorSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Add Category Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    const savedConfig = ensureCoreCategories(result.data);
    setFolderImportPending(null);
    setConfig(savedConfig);
    if (prepared.firstImportedCategoryId) {
      syncEditorCategoryItems(savedConfig, prepared.firstImportedCategoryId);
    }
    setStatusText(
      [
        `Folder import completed (${source === "drop" ? "drop" : "picker"})`,
        `Added ${prepared.addedItemCount}`,
        `Skipped duplicates ${prepared.skippedDuplicateCount}`,
        `New categories ${prepared.addedCategoryCount}`,
        scanResult.truncated ? "Partial import only" : "",
      ]
        .filter(Boolean)
        .join(" / "),
    );
  }

  async function addCategoryFromFolder(): Promise<void> {
    const selectedFolder = await window.launcherApi.pickLaunchTarget("folder");
    if (!selectedFolder) {
      return;
    }
    await importItemsFromFolderPath(selectedFolder, "picker");
  }

  function getDroppedFolderPath(event: DragEvent<HTMLElement>): string | null {
    const droppedFiles = event.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) {
      return null;
    }
    const rawPath = (droppedFiles[0] as File & { path?: string }).path;
    if (!rawPath || rawPath.trim().length === 0) {
      return null;
    }
    return rawPath;
  }

  async function onEditorFolderDrop(event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    setFolderImportDragActive(false);
    if (editorSaving || renameSaving || folderImportPending) {
      return;
    }
    const droppedPath = getDroppedFolderPath(event);
    if (!droppedPath) {
      return;
    }
    await importItemsFromFolderPath(droppedPath, "drop");
  }

  function onEditorFolderDragOver(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    if (!folderImportDragActive) {
      setFolderImportDragActive(true);
    }
  }

  function onEditorFolderDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setFolderImportDragActive(false);
  }

  async function createEditorItem(): Promise<void> {
    if (!config || !editorCategoryId) {
      return;
    }

    const selectedTarget = await window.launcherApi.pickLaunchTarget("file");
    if (!selectedTarget) {
      return;
    }

    const normalizedTarget = selectedTarget.trim();
    const draft: NewItemDraft = {
      target: normalizedTarget,
      name: inferItemNameFromTarget(normalizedTarget),
      workingDir: inferWorkingDirFromTarget(normalizedTarget),
    };
    await saveNewItemToCategory(editorCategoryId, draft);
  }

  async function saveNewItemToCategory(
    categoryId: string,
    draft: NewItemDraft,
  ): Promise<void> {
    if (!config) {
      return;
    }

    if (categoryId === "all") {
      setErrorModal({
        title: "Add Item Failed",
        message: "Category 'all' is filter-only.",
      });
      return;
    }

    const hasCategory = editorCategoryOptions.some((category) => category.id === categoryId);
    if (!hasCategory) {
      setErrorModal({
        title: "Add Item Failed",
        message: `Unknown category '${categoryId}'.`,
      });
      return;
    }

    const itemId = `item-${Date.now()}`;
    const newItem: LauncherItem = {
      id: itemId,
      name: draft.name,
      categoryId,
      target: draft.target,
      workingDir: draft.workingDir,
      icon: isImageLikePath(draft.target) ? draft.target : undefined,
    };

    const nextScopedItems = [
      ...cloneItems(config.items.filter((item) => item.categoryId === categoryId)),
      newItem,
    ];
    const mergedItems = mergeItemsByCategory(config.items, categoryId, nextScopedItems);

    const validationError = validateItems(mergedItems, editableCategories);
    if (validationError) {
      setErrorModal({
        title: "Add Item Failed",
        message: validationError,
      });
      return;
    }

    setEditorSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      items: mergedItems.map((item) => normalizeItem(item)),
    });
    setEditorSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Add Item Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    setConfig(result.data);
    syncEditorCategoryItems(result.data, categoryId, newItem.id);
    setStatusText(`Added '${newItem.name}'.`);
  }

  async function pickEmptyStateImage(): Promise<void> {
    if (!config) {
      return;
    }

    setEmptyStateMenuPosition(null);
    const selectedImage = await window.launcherApi.pickEmptyStateImage();
    if (!selectedImage) {
      return;
    }

    setEmptyStateImageSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      app: {
        ...config.app,
        emptyStateImage: selectedImage,
      },
    });
    setEmptyStateImageSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Background Save Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    setConfig(result.data);
    setStatusText("Empty-state background updated.");
  }

  async function pickEditingItemIconPath(): Promise<void> {
    if (!editingItem || editorSaving || renameSaving) {
      return;
    }

    const selectedIconPath = await window.launcherApi.pickItemIconPath();
    if (!selectedIconPath) {
      return;
    }

    updateEditingItem({ icon: selectedIconPath });
  }

  function updateEditingItem(patch: Partial<LauncherItem>): void {
    if (!editingItemId) {
      return;
    }
    setEditorItems((current) =>
      current.map((item) => (item.id === editingItemId ? { ...item, ...patch } : item)),
    );
  }

  function deleteItemById(itemId: string): void {
    if (!itemId) {
      return;
    }
    setEditorItems((current) => {
      const nextItems = current.filter((item) => item.id !== itemId);
      setEditingItemId(nextItems[0]?.id ?? null);
      return nextItems;
    });
  }

  function onDeleteEditingItem(): void {
    if (!editingItem) {
      return;
    }
    setDeleteConfirmItem(editingItem);
  }

  function confirmDeleteEditingItem(): void {
    if (!deleteConfirmItem) {
      return;
    }
    deleteItemById(deleteConfirmItem.id);
    setDeleteConfirmItem(null);
  }

  function onDeleteEditorCategory(): void {
    if (!config || !editorCategoryId) {
      return;
    }
    if (isProtectedCategoryId(editorCategoryId)) {
      setErrorModal({
        title: "Delete Category",
        message: "Core category cannot be deleted.",
      });
      return;
    }
    const targetCategory = config.categories.find((category) => category.id === editorCategoryId);
    if (!targetCategory) {
      return;
    }
    if (editorDirty) {
      const proceed = window.confirm(
        "Unsaved item changes in this category will be discarded before category deletion. Continue?",
      );
      if (!proceed) {
        return;
      }
    }
    const itemCount = config.items.filter((item) => item.categoryId === editorCategoryId).length;
    setDeleteConfirmCategory({
      id: editorCategoryId,
      label: targetCategory.label,
      itemCount,
    });
  }

  async function confirmDeleteEditorCategory(): Promise<void> {
    if (!config || !deleteConfirmCategory) {
      return;
    }

    const nextCategories = config.categories.filter((category) => category.id !== deleteConfirmCategory.id);
    const nextItems = config.items.filter((item) => item.categoryId !== deleteConfirmCategory.id);

    setEditorSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      categories: nextCategories,
      items: nextItems,
    });
    setEditorSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Delete Category Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    const savedConfig = ensureCoreCategories(result.data);
    setDeleteConfirmCategory(null);
    setConfig(savedConfig);
    syncEditorCategoryItems(savedConfig, null);
    setStatusText(
      `Deleted category '${deleteConfirmCategory.label}' (removed ${deleteConfirmCategory.itemCount} items).`,
    );
  }

  async function saveEditorItems(options?: { silent?: boolean }): Promise<boolean> {
    if (!config) {
      return false;
    }

    if (!editorCategoryId) {
      setErrorModal({
        title: "Save Failed",
        message: "Select a category first.",
      });
      return false;
    }

    const scopedItems = editorItems.map((item) =>
      normalizeItem({
        ...item,
        categoryId: editorCategoryId,
      }),
    );
    const mergedItems = mergeItemsByCategory(config.items, editorCategoryId, scopedItems);

    const validationError = validateItems(mergedItems, editableCategories);
    if (validationError) {
      setErrorModal({
        title: "Validation Failed",
        message: validationError,
      });
      return false;
    }

    setEditorSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      items: mergedItems,
    });
    setEditorSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Save Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return false;
    }

    setConfig(result.data);
    syncEditorCategoryItems(result.data, editorCategoryId, editingItemId);
    if (!options?.silent) {
      setStatusText(
        `Saved ${scopedItems.length} items${
          editorSelectedCategory ? ` (${editorSelectedCategory.label})` : ""
        }.`,
      );
    }
    return true;
  }

  async function runItem(item: LauncherItem): Promise<void> {
    setLaunchingItemId(item.id);
    setStatusText(`Launching: ${item.name}`);

    const result = await window.launcherApi.launchItem(item.id);
    setLaunchingItemId(null);

    if (result.ok) {
      setStatusText(result.message);
      return;
    }

    setStatusText(`Launch failed: ${item.name}`);
    setErrorModal({
      title: "Launch Failed",
      message: result.error.message,
      details: result.error.details,
    });
  }

  async function quitApp(): Promise<void> {
    if (quitting) {
      return;
    }

    setQuitting(true);
    setStatusText("Exiting app...");

    const fallbackTimer = window.setTimeout(() => {
      window.close();
    }, 1000);

    try {
      await window.launcherApi.quit();
    } catch {
      setStatusText("Exit request failed. Closing window...");
      window.close();
      setQuitting(false);
    } finally {
      window.clearTimeout(fallbackTimer);
    }
  }

  function getFocusedLauncherItem(): LauncherItem | null {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    const focusedItemId = activeElement.dataset.launcherItemId;
    if (!focusedItemId) {
      return null;
    }

    return filteredItems.find((item) => item.id === focusedItemId) ?? null;
  }

  function notifyWidgetBodyInteracted(): void {
    if (currentMode !== "widget") {
      return;
    }

    const now = Date.now();
    if (now - lastBodyInteractionNotifyAtRef.current < 250) {
      return;
    }
    lastBodyInteractionNotifyAtRef.current = now;

    void window.launcherApi.widgetBodyInteracted();
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search, selectedCategoryId]);

  useEffect(() => {
    if (!itemListRef.current) {
      return;
    }
    itemListRef.current.scrollTop = 0;
  }, [search, selectedCategoryId]);

  useEffect(() => {
    if (!config) {
      return;
    }
    const validCategoryIds = new Set([
      ...categoryChips.map((category) => category.id),
      ...extraCategories.map((category) => category.id),
    ]);
    if (selectedCategoryId !== null && !validCategoryIds.has(selectedCategoryId)) {
      setSelectedCategoryId(null);
    }
  }, [categoryChips, config, extraCategories, selectedCategoryId]);

  useEffect(() => {
    if (selectedCategoryId !== null) {
      setEmptyStateMenuPosition(null);
    }
  }, [selectedCategoryId]);

  useEffect(() => {
    if (!editorCategoryId) {
      return;
    }

    const exists = editorCategoryOptions.some(
      (category) => category.id === editorCategoryId,
    );
    if (exists) {
      return;
    }

    setEditorCategoryId(null);
    setEditorItems([]);
    setEditorOriginalItems([]);
    setEditingItemId(null);
  }, [editorCategoryId, editorCategoryOptions]);

  useEffect(() => {
    if (selectedIndex < 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= filteredItems.length && filteredItems.length > 0) {
      setSelectedIndex(filteredItems.length - 1);
    }
  }, [filteredItems.length, selectedIndex]);

  useEffect(() => {
    if (!config) {
      return;
    }
    document.body.dataset.theme = config.app.theme ?? "blue";
    document.body.dataset.mode = currentMode;
  }, [config, currentMode]);

  useEffect(() => {
    if (!editorOpen || !editorCategoryId || !editorDirty || editorSaving) {
      return;
    }
    if (renameModalOpen || deleteConfirmItem || deleteConfirmCategory) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveEditorItems({ silent: true });
    }, EDITOR_AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    editorOpen,
    editorCategoryId,
    editorDirty,
    editorItems,
    editorSaving,
    renameModalOpen,
    deleteConfirmItem,
    deleteConfirmCategory,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Keep Enter launch working even when IME composition state is reported.
      if (event.isComposing && event.key !== "Enter") {
        return;
      }

      if (errorModal && event.key === "Escape") {
        setErrorModal(null);
        event.preventDefault();
        return;
      }

      if (emptyStateMenuPosition && event.key === "Escape") {
        setEmptyStateMenuPosition(null);
        event.preventDefault();
        return;
      }

      if (!config || loading || configError) {
        return;
      }

      if (editorOpen) {
        if (deleteConfirmItem) {
          if (event.key === "Escape") {
            setDeleteConfirmItem(null);
            event.preventDefault();
          }
          return;
        }

        if (deleteConfirmCategory) {
          if (event.key === "Escape") {
            setDeleteConfirmCategory(null);
            event.preventDefault();
          }
          return;
        }

        if (renameModalOpen) {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void saveRenamedCategoryLabels();
            return;
          }

          if (event.key === "Escape") {
            closeRenameModal();
            event.preventDefault();
          }
          return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveEditorItems();
          return;
        }

        if (event.key === "Escape") {
          void closeEditorAndFlush();
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
        setEmptyStateMenuPosition(null);
        return;
      }

      if (filteredItems.length === 0) {
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(filteredItems.length - 1, current + 1));
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }

      const focusedItem = getFocusedLauncherItem();
      const itemToRun = focusedItem ?? selectedItem;
      if (event.key === "Enter" && itemToRun) {
        event.preventDefault();
        void runItem(itemToRun);
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    config,
    loading,
    configError,
    filteredItems,
    selectedItem,
    editorOpen,
    deleteConfirmItem,
    deleteConfirmCategory,
    renameModalOpen,
    errorModal,
    emptyStateMenuPosition,
    editorDirty,
    editorSaving,
    renameSaving,
    deleteConfirmItem,
  ]);

  if (loading) {
    return (
      <main className="loading">
        <h1>mongTang</h1>
        <p>Loading widget...</p>
      </main>
    );
  }

  if (configError) {
    return (
      <main className="config-error">
        <h1>Widget cannot start</h1>
        <p>{configError.message}</p>
        {configError.details && <code>{configError.details}</code>}
        <button type="button" onClick={() => void loadConfig(true)}>
          Retry
        </button>
      </main>
    );
  }

  return (
    <main className="widget-root">
      <section className="widget-shell" onPointerDownCapture={notifyWidgetBodyInteracted}>
        <header className="widget-header">
          <div>
            <h1>{config?.app.title ?? "mongTang"}</h1>
            <p>Desktop Widget Launcher</p>
          </div>
          <div className="header-actions">
            <button type="button" onClick={openEditor}>
              Add / Edit
            </button>
            <button type="button" onClick={() => void loadConfig(true)}>
              Reload
            </button>
            <button type="button" className="exit-btn" onClick={() => void quitApp()} disabled={quitting}>
              {quitting ? "Exiting..." : "Exit"}
            </button>
          </div>
        </header>

        <div className="search-wrap">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search apps, keywords, path"
          />
          <small>Double-click or press Enter to launch</small>
        </div>

        <nav className="category-row" aria-label="Category">
          {categoryChips.map((category) => {
            const selected = category.id === selectedCategoryId;
            return (
              <button
                key={category.id}
                type="button"
                className={`chip ${selected ? "is-selected" : ""}`}
                onClick={() => setSelectedCategoryId((current) => (current === category.id ? null : category.id))}
              >
                {category.label}
              </button>
            );
          })}
        </nav>
        {extraCategories.length > 0 && (
          <div className="extra-category-row">
            <select
              aria-label="Extra category"
              value={
                selectedCategoryId &&
                extraCategories.some((category) => category.id === selectedCategoryId)
                  ? selectedCategoryId
                  : ""
              }
              onChange={(event) => {
                const nextCategoryId = event.target.value.trim();
                setSelectedCategoryId(nextCategoryId.length > 0 ? nextCategoryId : null);
              }}
            >
              <option value="">Select additional category...</option>
              {extraCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <section ref={itemListRef} className="item-list" role="listbox" aria-label="Launcher items">
          {isIdleEmptyState ? (
            <div
              className="empty-state"
              onContextMenu={(event) => {
                event.preventDefault();
                setEmptyStateMenuPosition(
                  clampContextMenuPosition({ x: event.clientX, y: event.clientY }),
                );
              }}
            >
              {emptyStateImageSrc ? (
                <img src={emptyStateImageSrc} alt="Empty state" />
              ) : (
                <div className="empty-state-placeholder">
                  <div className="empty-state-guide-text">
                    <strong>Small Guide</strong>
                    <p>Add / Edit로 항목을 등록하세요.</p>
                    <p>Folder Import로 여러 항목을 추가할 수 있습니다.</p>
                    <p>더블클릭 또는 Enter로 실행할 수 있습니다.</p>
                  </div>
                </div>
              )}
              <div className="empty-state-caption">
                Select a category. Right-click to change the background image.
              </div>
            </div>
          ) : (
            <>
              {filteredItems.length === 0 && (
                <div className="empty">No item matches current filter.</div>
              )}

              {filteredItems.map((item, index) => {
                const selected = index === selectedIndex;
                const launching = item.id === launchingItemId;
                const iconSrc = getIconSrc(item.icon);

                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`item-row ${selected ? "is-selected" : ""} ${launching ? "is-launching" : ""}`}
                    aria-selected={selected}
                    data-launcher-item-id={item.id}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => {
                      setSelectedIndex(index);
                    }}
                    onDoubleClick={() => {
                      setSelectedIndex(index);
                      void runItem(item);
                    }}
                  >
                    <div className="item-icon">
                      {iconSrc ? (
                        <img src={iconSrc} alt="" />
                      ) : (
                        <span aria-hidden="true" />
                      )}
                    </div>
                    <div className="item-content">
                      <strong>{item.name}</strong>
                      <small>{item.target}</small>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </section>

        <footer className="widget-footer">
          <span>{statusText}</span>
          {currentMode === "widget" && (
            <span className="mode-pill">
              {widgetBlurBehavior === "dock-right-edge" ||
              widgetBlurBehavior === "windows-docking"
                ? "Windows docking widget"
                : widgetBlurBehavior === "hide"
                  ? "Auto hide widget"
                  : "Pinned widget"}
            </span>
          )}
        </footer>
      </section>

      {emptyStateMenuPosition && isIdleEmptyState && (
        <div
          className="context-menu-overlay"
          role="presentation"
          onClick={() => setEmptyStateMenuPosition(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="context-menu"
            style={{ left: `${emptyStateMenuPosition.x}px`, top: `${emptyStateMenuPosition.y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={() => void pickEmptyStateImage()} disabled={emptyStateImageSaving}>
              {emptyStateImageSaving ? "Saving..." : "Select background image..."}
            </button>
          </div>
        </div>
      )}

      {editorOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`modal editor-modal ${folderImportDragActive ? "is-folder-drop-active" : ""}`}
            role="dialog"
            aria-modal="true"
            onDragOver={onEditorFolderDragOver}
            onDragLeave={onEditorFolderDragLeave}
            onDrop={(event) => void onEditorFolderDrop(event)}
          >
            <header>
              <h2>Item Add/Edit</h2>
            </header>

            <div className="editor-body">
              <aside className="editor-list">
                <label className="editor-category-select">
                  <span>Category</span>
                  <select
                    value={editorCategoryId ?? ""}
                    onChange={(event) =>
                      changeEditorCategory(event.target.value ? event.target.value : null)
                    }
                    disabled={editorSaving}
                  >
                    <option value="">Select category...</option>
                    {editorCategoryOptions.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label} ({category.id})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="editor-list-actions">
                  <button
                    type="button"
                    onClick={onClickPrimaryAddButton}
                    disabled={
                      editorSaving ||
                      renameSaving
                    }
                  >
                    {primaryAddButtonLabel}
                  </button>
                  <button
                    type="button"
                    onClick={openRenameModal}
                    disabled={
                      editorSaving ||
                      renameSaving ||
                      shouldDisableRenameButton
                    }
                  >
                    Rename Buttons
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={onDeleteEditingItem}
                    disabled={
                      !editingItem ||
                      editorSaving ||
                      renameSaving ||
                      !editorCategoryId
                    }
                  >
                    Delete Item
                  </button>
                </div>
                <div className="editor-drop-row">
                  <div className={`editor-drop-hint ${folderImportDragActive ? "is-active" : ""}`}>
                    Drop a folder here to bulk import nested files.
                  </div>
                  <button
                    type="button"
                    className="editor-close-btn"
                    onClick={() => void closeEditorAndFlush()}
                    disabled={editorSaving}
                  >
                    Close
                  </button>
                </div>
                <div className="editor-list-items">
                  {!editorCategoryId && (
                    <div className="editor-list-placeholder editor-guide">
                      <strong>User Guide</strong>
                      <ol>
                        <li>Select a category from the dropdown above.</li>
                        <li>Use Import Folder to bulk add files.</li>
                        <li>Select an item to edit details on the right.</li>
                      </ol>
                    </div>
                  )}
                  {editorCategoryId && editorItems.length === 0 && (
                    <div className="editor-list-placeholder">
                      No items in this category.
                    </div>
                  )}
                  {editorCategoryId &&
                    editorItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`editor-item-row ${item.id === editingItemId ? "is-selected" : ""}`}
                        onClick={() => setEditingItemId(item.id)}
                      >
                        <span className="editor-item-icon" aria-hidden="true">
                          {getIconSrc(item.icon) ? (
                            <img src={getIconSrc(item.icon)} alt="" />
                          ) : (
                            <span />
                          )}
                        </span>
                        <span className="editor-item-name">{item.name}</span>
                      </button>
                    ))}
                </div>
                {canDeleteEditorCategory && (
                  <button
                    type="button"
                    className="danger editor-category-danger"
                    onClick={onDeleteEditorCategory}
                    disabled={editorSaving || renameSaving}
                  >
                    Delete Category
                  </button>
                )}
              </aside>

              <section className="editor-form">
                {!editorCategoryId && null}
                {editorCategoryId && !editingItem && <p>Select an item.</p>}
                {editorCategoryId && editingItem && (
                  <>
                    <label>
                      <span>ID</span>
                      <input
                        type="text"
                        value={editingItem.id}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          updateEditingItem({ id: nextId });
                          setEditingItemId(nextId);
                        }}
                      />
                    </label>
                    <label>
                      <span>Name</span>
                      <input
                        type="text"
                        value={editingItem.name}
                        onChange={(event) => updateEditingItem({ name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Target</span>
                      <input
                        type="text"
                        value={editingItem.target}
                        onChange={(event) => updateEditingItem({ target: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Args</span>
                      <input
                        type="text"
                        value={typeof editingItem.args === "string" ? editingItem.args : ""}
                        onChange={(event) => updateEditingItem({ args: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Working Dir</span>
                      <input
                        type="text"
                        value={editingItem.workingDir ?? ""}
                        onChange={(event) => updateEditingItem({ workingDir: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Icon Path</span>
                      <div className="editor-input-with-action">
                        <input
                          type="text"
                          value={editingItem.icon ?? ""}
                          onChange={(event) => updateEditingItem({ icon: event.target.value })}
                        />
                        <button
                          type="button"
                          className="icon-picker-btn"
                          onClick={() => void pickEditingItemIconPath()}
                          disabled={editorSaving || renameSaving}
                        >
                          ...
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>Keywords (comma separated)</span>
                      <input
                        type="text"
                        value={keywordsToString(editingItem.keywords)}
                        onChange={(event) =>
                          updateEditingItem({ keywords: parseKeywords(event.target.value) })
                        }
                      />
                    </label>
                  </>
                )}
              </section>
            </div>

          </section>
        </div>
      )}


      {renameModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal rename-modal" role="dialog" aria-modal="true">
            <header>
              <h2>Rename Buttons</h2>
            </header>
            <p>Set display labels for the four main category buttons.</p>
            <div className="rename-form">
              {CORE_CATEGORY_ORDER.map((id) => (
                <label key={id}>
                  <span>
                    {CORE_CATEGORY_DEFAULT_LABELS[id]} ({id})
                  </span>
                  <input
                    type="text"
                    value={renameDraftLabels[id]}
                    onChange={(event) =>
                      setRenameDraftLabels((current) => ({
                        ...current,
                        [id]: event.target.value,
                      }))
                    }
                    disabled={renameSaving}
                  />
                </label>
              ))}
            </div>
            <footer className="editor-footer">
              <button type="button" onClick={closeRenameModal} disabled={renameSaving}>
                Cancel
              </button>
              <button type="button" onClick={() => void saveRenamedCategoryLabels()} disabled={renameSaving}>
                {renameSaving ? "Saving..." : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {folderImportPending && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal modal-warning" role="dialog" aria-modal="true">
            <h2>Confirm Folder Import</h2>
            <p>Proceed with folder bulk import?</p>
            <code>
              {[
                `Scanned folder: ${folderImportPending.scanResult.rootPath}`,
                `New categories: ${folderImportPending.prepared.addedCategoryCount}`,
                `New items: ${folderImportPending.prepared.addedItemCount}`,
                `Skipped duplicates: ${folderImportPending.prepared.skippedDuplicateCount}`,
                folderImportPending.scanResult.truncated ? "Warning: partial import only." : "",
              ]
                .filter(Boolean)
                .join("\n")}
            </code>
            <footer className="editor-footer">
              <button
                type="button"
                onClick={() => setFolderImportPending(null)}
                disabled={editorSaving}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void applyPendingFolderImport()} disabled={editorSaving}>
                {editorSaving ? "Applying..." : "Apply"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {folderImportStrategyPending && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal modal-warning classify-modal" role="dialog" aria-modal="true">
            <h2>Nested Folders Detected</h2>
            <p>Choose how to import items from nested folders.</p>
            <code>
              {[
                `Scanned folder: ${folderImportStrategyPending.scanResult.rootPath}`,
                `Top-level files: ${folderImportStrategyPending.scanResult.topLevelEntries.length}`,
                `Nested folders: ${folderImportStrategyPending.scanResult.nestedDirectoryCount}`,
                `All discovered items: ${folderImportStrategyPending.scanResult.entries.length}`,
              ].join("\n")}
            </code>
            <div className="classify-actions">
              <button
                type="button"
                onClick={() => chooseFolderImportStrategy("top-level-only")}
                disabled={editorSaving}
              >
                Top-level Only
              </button>
              <button
                type="button"
                onClick={() => chooseFolderImportStrategy("per-subfolder")}
                disabled={editorSaving}
              >
                Per Subfolder
              </button>
            </div>
            <footer className="editor-footer">
              <button type="button" onClick={cancelFolderImportStrategy} disabled={editorSaving}>
                Cancel
              </button>
            </footer>
          </section>
        </div>
      )}

      {deleteConfirmItem && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true">
            <h2>Delete Item</h2>
            <p>{`Delete '${deleteConfirmItem.name}' item?`}</p>
            <footer className="editor-footer">
              <button type="button" onClick={() => setDeleteConfirmItem(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={confirmDeleteEditingItem}>
                Delete
              </button>
            </footer>
          </section>
        </div>
      )}

      {deleteConfirmCategory && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal modal-warning" role="alertdialog" aria-modal="true">
            <h2>Delete Category</h2>
            <p>
              {`Delete category '${deleteConfirmCategory.label}' and remove ${deleteConfirmCategory.itemCount} items?`}
            </p>
            <footer className="editor-footer">
              <button type="button" onClick={() => setDeleteConfirmCategory(null)} disabled={editorSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void confirmDeleteEditorCategory()}
                disabled={editorSaving}
              >
                {editorSaving ? "Deleting..." : "Delete Category"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {errorModal && (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`modal ${errorModal.severity === "warning" ? "modal-warning" : ""}`}
            role="alertdialog"
            aria-modal="true"
          >
            <h2>{errorModal.title}</h2>
            <p>{errorModal.message}</p>
            {errorModal.details && <code>{errorModal.details}</code>}
            <button type="button" onClick={() => setErrorModal(null)}>
              Close
            </button>
          </section>
        </div>
      )}
    </main>
  );
}


