import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiResult, LauncherCategory, LauncherConfig, LauncherItem } from "@shared/types";

interface ErrorModal {
  title: string;
  message: string;
  details?: string;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function ensureAllCategory(config: LauncherConfig): LauncherCategory[] {
  if (config.categories.some((category) => category.id === "all")) {
    return config.categories;
  }
  return [{ id: "all", label: "All" }, ...config.categories];
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
  if (/^(https?:\/\/|file:\/\/|data:)/i.test(icon)) {
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

function cloneItems(items: LauncherItem[]): LauncherItem[] {
  return items.map((item) => ({
    ...item,
    args: Array.isArray(item.args) ? [...item.args] : item.args,
    keywords: item.keywords ? [...item.keywords] : undefined,
  }));
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
  const [config, setConfig] = useState<LauncherConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<ErrorModal | null>(null);

  const [search, setSearch] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusText, setStatusText] = useState("Preparing widget...");
  const [launchingItemId, setLaunchingItemId] = useState<string | null>(null);
  const [errorModal, setErrorModal] = useState<ErrorModal | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorItems, setEditorItems] = useState<LauncherItem[]>([]);
  const [editorOriginalItems, setEditorOriginalItems] = useState<LauncherItem[]>([]);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => {
    if (!config) {
      return [];
    }
    return ensureAllCategory(config);
  }, [config]);

  const editableCategories = useMemo(() => config?.categories ?? [], [config]);

  const filteredItems = useMemo(() => {
    if (!config) {
      return [];
    }

    const normalizedSearch = normalizeText(search);

    return config.items.filter((item) => {
      const categoryMatched =
        selectedCategoryId === "all" || item.categoryId === selectedCategoryId;
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

    setConfig(result.data);
    setSelectedCategoryId("all");
    setSelectedIndex(0);
    setStatusText(`Loaded ${result.data.items.length} items.`);
    setLoading(false);
  }

  function openEditor(): void {
    if (!config) {
      return;
    }

    const cloned = cloneItems(config.items);
    setEditorItems(cloned);
    setEditorOriginalItems(cloneItems(cloned));
    setEditingItemId(cloned[0]?.id ?? null);
    setEditorOpen(true);
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
    setEditingItemId(null);
  }

  function createEditorItem(): void {
    const defaultCategory = editableCategories[0]?.id ?? "all";
    const itemId = `item-${Date.now()}`;

    const newItem: LauncherItem = {
      id: itemId,
      name: "New Item",
      categoryId: defaultCategory,
      target: "",
    };

    setEditorItems((current) => [...current, newItem]);
    setEditingItemId(itemId);
  }

  function updateEditingItem(patch: Partial<LauncherItem>): void {
    if (!editingItemId) {
      return;
    }
    setEditorItems((current) =>
      current.map((item) => (item.id === editingItemId ? { ...item, ...patch } : item)),
    );
  }

  function deleteEditingItem(): void {
    if (!editingItemId) {
      return;
    }
    setEditorItems((current) => {
      const nextItems = current.filter((item) => item.id !== editingItemId);
      setEditingItemId(nextItems[0]?.id ?? null);
      return nextItems;
    });
  }

  async function saveEditorItems(): Promise<void> {
    if (!config) {
      return;
    }

    const validationError = validateItems(editorItems, editableCategories);
    if (validationError) {
      setErrorModal({
        title: "Validation Failed",
        message: validationError,
      });
      return;
    }

    setEditorSaving(true);
    const result = await window.launcherApi.saveConfig({
      ...config,
      items: editorItems.map((item) => normalizeItem(item)),
    });
    setEditorSaving(false);

    if (!result.ok) {
      setErrorModal({
        title: "Save Failed",
        message: result.error.message,
        details: result.error.details,
      });
      return;
    }

    setConfig(result.data);
    closeEditor(true);
    setStatusText(`Saved ${result.data.items.length} items.`);
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

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search, selectedCategoryId]);

  useEffect(() => {
    if (!config) {
      return;
    }
    const validCategoryIds = new Set(categories.map((category) => category.id));
    if (!validCategoryIds.has(selectedCategoryId)) {
      setSelectedCategoryId("all");
    }
  }, [categories, config, selectedCategoryId]);

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

      if (!config || loading || configError) {
        return;
      }

      if (editorOpen) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveEditorItems();
          return;
        }

        if (event.key === "Escape") {
          closeEditor();
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
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
    errorModal,
    editorDirty,
    editorSaving,
  ]);

  if (loading) {
    return (
      <main className="loading">
        <h1>Papa Launcher</h1>
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
      <section className="widget-shell">
        <header className="widget-header">
          <div>
            <h1>{config?.app.title ?? "Papa Launcher"}</h1>
            <p>Desktop Widget Launcher</p>
          </div>
          <div className="header-actions">
            <button type="button" onClick={openEditor}>
              Edit
            </button>
            <button type="button" onClick={() => void loadConfig(true)}>
              Reload
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
          {categories.map((category) => {
            const selected = category.id === selectedCategoryId;
            return (
              <button
                key={category.id}
                type="button"
                className={`chip ${selected ? "is-selected" : ""}`}
                onClick={() => setSelectedCategoryId(category.id)}
              >
                {category.label}
              </button>
            );
          })}
        </nav>

        <section className="item-list" role="listbox" aria-label="Launcher items">
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
                    <span>{item.name.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="item-content">
                  <strong>{item.name}</strong>
                  <small>{item.target}</small>
                </div>
              </button>
            );
          })}
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

      {editorOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal editor-modal" role="dialog" aria-modal="true">
            <header>
              <h2>Item Editor</h2>
            </header>

            <div className="editor-body">
              <aside className="editor-list">
                <button type="button" onClick={createEditorItem}>
                  Add Item
                </button>
                <div className="editor-list-items">
                  {editorItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`editor-item-row ${item.id === editingItemId ? "is-selected" : ""}`}
                      onClick={() => setEditingItemId(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </aside>

              <section className="editor-form">
                {!editingItem && <p>Select an item.</p>}
                {editingItem && (
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
                      <span>Category</span>
                      <select
                        value={editingItem.categoryId}
                        onChange={(event) => updateEditingItem({ categoryId: event.target.value })}
                      >
                        {editableCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.label} ({category.id})
                          </option>
                        ))}
                      </select>
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
                      <input
                        type="text"
                        value={editingItem.icon ?? ""}
                        onChange={(event) => updateEditingItem({ icon: event.target.value })}
                      />
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
                    <button type="button" className="danger" onClick={deleteEditingItem}>
                      Delete Item
                    </button>
                  </>
                )}
              </section>
            </div>

            <footer className="editor-footer">
              <button type="button" onClick={() => closeEditor()} disabled={editorSaving}>
                Cancel
              </button>
              <button type="button" onClick={() => void saveEditorItems()} disabled={editorSaving}>
                {editorSaving ? "Saving..." : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {errorModal && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true">
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
