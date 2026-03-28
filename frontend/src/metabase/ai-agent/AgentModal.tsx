import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import api from "metabase/lib/api";
import { ActionIcon, Anchor, Box, Flex, Icon, Menu, Stack, Text, Tooltip } from "metabase/ui";
// Textarea removed — replaced by ComposerInput (contentEditable)

import { AgentChatMessages } from "./AgentChatMessages";
import type { ComposerInputHandle, TemplatePlaceholderType } from "./ComposerInput";
import { ComposerInput } from "./ComposerInput";
import type { MetricItem } from "./MetricSlashMenu";
import { MetricSlashMenu } from "./MetricSlashMenu";
import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import type { AgentContextValue } from "./AgentContextPicker";
import { AgentMcpServers } from "./AgentMcpServers";
import type { SaveLocation } from "./AgentSaveLocationPicker";
import { AgentSaveLocationPicker } from "./AgentSaveLocationPicker";
import { useAgentChat } from "./hooks/useAgentChat";
import { useFloatingPanel } from "./hooks/useFloatingPanel";
import { usePageContext } from "./hooks/usePageContext";
import S from "./AgentModal.module.css";

const PANEL_CONSTRAINTS = {
  minWidth: 320,
  maxWidth: 800,
  minHeight: 510,
  maxHeight: 920,
  appbarHeight: 50,
  minimizedHeight: 52,
  edgeBuffer: 5,
} as const;

type DockMode = "none" | "right" | "bottom";

const DOCK_WIDTH_DEFAULT = 420;
const DOCK_WIDTH_MIN = 320;
const DOCK_WIDTH_MAX = 800;
const DOCK_HEIGHT_DEFAULT = 340;
const DOCK_HEIGHT_MIN = 220;
const DOCK_HEIGHT_MAX = 600;
const INPUT_PANEL_WIDTH_DEFAULT = 440;
const INPUT_PANEL_WIDTH_MIN = 300;
const INPUT_PANEL_WIDTH_MAX = 700;
const DOCK_STORAGE_KEY = "bi-agent-dock";

interface DockState {
  mode: DockMode;
  width: number;
  height: number;
  inputPanelWidth?: number;
}

function readDockState(): DockState {
  try {
    const raw = sessionStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) return { mode: "none", width: DOCK_WIDTH_DEFAULT, height: DOCK_HEIGHT_DEFAULT, inputPanelWidth: INPUT_PANEL_WIDTH_DEFAULT };
    const parsed = JSON.parse(raw);
    // Migrate old format
    if (typeof parsed.isDocked === "boolean") {
      return {
        mode: parsed.isDocked ? "right" : "none",
        width: typeof parsed.width === "number" ? parsed.width : DOCK_WIDTH_DEFAULT,
        height: DOCK_HEIGHT_DEFAULT,
        inputPanelWidth: INPUT_PANEL_WIDTH_DEFAULT,
      };
    }
    return {
      mode: parsed.mode === "right" || parsed.mode === "bottom" ? parsed.mode : "none",
      width: typeof parsed.width === "number" ? parsed.width : DOCK_WIDTH_DEFAULT,
      height: typeof parsed.height === "number" ? parsed.height : DOCK_HEIGHT_DEFAULT,
      inputPanelWidth: typeof parsed.inputPanelWidth === "number" ? parsed.inputPanelWidth : INPUT_PANEL_WIDTH_DEFAULT,
    };
  } catch {
    return { mode: "none", width: DOCK_WIDTH_DEFAULT, height: DOCK_HEIGHT_DEFAULT };
  }
}

function saveDockState(state: DockState) {
  try {
    sessionStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable
  }
}

const CONTEXT_ICON: Record<string, string> = {
  card: "question",
  dataset: "model",
  metric: "metric",
  table: "database",
  dashboard: "dashboard",
  document: "document",
  database: "database",
};

interface AgentModalProps {
  onClose: () => void;
}

export function AgentModal({ onClose }: AgentModalProps) {
  const { panelState, panelStyle, headerProps, resizeHandleProps } =
    useFloatingPanel(PANEL_CONSTRAINTS);

  const [inputText, setInputText] = useState("");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [tipsData, setTipsData] = useState<{
    templates: { icon: string; label: Record<string, string>; template: Record<string, string> }[];
    examples: Record<string, string>[];
    hint: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    fetch("/api/ai-agent/tips", { headers: { "Content-Type": "application/json" } })
      .then(r => r.json())
      .then(setTipsData)
      .catch(() => {});
  }, []);
  const slashMetricsRef = useRef<MetricItem[]>([]);
  const [contexts, setContexts] = useState<AgentContextValue[]>([]);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Template placeholder picker state
  const [activePlaceholder, setActivePlaceholder] = useState<{
    type: TemplatePlaceholderType;
    id: string;
  } | null>(null);
  const [dateRangeMode, setDateRangeMode] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [inputText2, setInputText2] = useState("");
  const [dbList, setDbList] = useState<{ id: number; name: string }[]>([]);
  const [dbListLoaded, setDbListLoaded] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [markdownMode, setMarkdownMode] = useState(false);
  const [saveLocation, setSaveLocation] = useState<SaveLocation | null>(null);
  const [dockMode, setDockMode] = useState<DockMode>(() => readDockState().mode);
  const [dockedWidth, setDockedWidth] = useState(() => readDockState().width);
  const [dockedHeight, setDockedHeight] = useState(() => readDockState().height);
  const [inputPanelWidth, setInputPanelWidth] = useState(() => readDockState().inputPanelWidth ?? INPUT_PANEL_WIDTH_DEFAULT);
  const isDocked = dockMode !== "none";
  const isBottomDock = dockMode === "bottom";
  const isRightDock = dockMode === "right";
  const { messages, isLoading, error, agentSettings, chatCollectionId, chatCollectionName, sendMessage, clearMessages, stopGeneration, retryLastMessage } =
    useAgentChat();
  const composerRef = useRef<ComposerInputHandle>(null);
  const composerDivRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<{ name: string; data: string; mimeType: string } | null>(null);

  // Auto-populate datasource from default_database setting
  useEffect(() => {
    if (agentSettings?.default_database && contexts.length === 0) {
      setContexts(prev => {
        if (prev.some(c => c.model === "database")) return prev;
        return [...prev, {
          id: agentSettings.default_database.id,
          name: agentSettings.default_database.name,
          model: "database",
        }];
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSettings]);

  // When the backend auto-creates a chat collection, show it in the save-location chip
  useEffect(() => {
    if (chatCollectionId && chatCollectionName && !saveLocation) {
      setSaveLocation({ id: chatCollectionId, name: chatCollectionName });
    }
  }, [chatCollectionId, chatCollectionName, saveLocation]);

  // When docked, set CSS variables so the main app content shrinks
  useEffect(() => {
    if (isRightDock) {
      document.documentElement.style.setProperty("--agent-dock-width", `${dockedWidth}px`);
      document.documentElement.style.removeProperty("--agent-dock-height");
    } else if (isBottomDock) {
      document.documentElement.style.setProperty("--agent-dock-height", `${dockedHeight}px`);
      document.documentElement.style.removeProperty("--agent-dock-width");
    } else {
      document.documentElement.style.removeProperty("--agent-dock-width");
      document.documentElement.style.removeProperty("--agent-dock-height");
    }
    return () => {
      document.documentElement.style.removeProperty("--agent-dock-width");
      document.documentElement.style.removeProperty("--agent-dock-height");
    };
  }, [dockMode, dockedWidth, dockedHeight, isRightDock, isBottomDock]);

  // Persist dock state to localStorage
  useEffect(() => {
    saveDockState({ mode: dockMode, width: dockedWidth, height: dockedHeight, inputPanelWidth });
  }, [dockMode, dockedWidth, dockedHeight, inputPanelWidth]);


  // ── Docked edge resize (right dock: left edge, bottom dock: top edge) ──
  const onDockedResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";

      if (isRightDock) {
        const startX = e.clientX;
        const startW = dockedWidth;
        const onMove = (ev: PointerEvent) => {
          const w = Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, startW + (startX - ev.clientX)));
          setDockedWidth(w);
          document.documentElement.style.setProperty("--agent-dock-width", `${w}px`);
        };
        const onUp = (ev: PointerEvent) => {
          el.releasePointerCapture(ev.pointerId);
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          document.body.style.userSelect = "";
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
      } else if (isBottomDock) {
        const startY = e.clientY;
        const startH = dockedHeight;
        const onMove = (ev: PointerEvent) => {
          const h = Math.min(DOCK_HEIGHT_MAX, Math.max(DOCK_HEIGHT_MIN, startH + (startY - ev.clientY)));
          setDockedHeight(h);
          document.documentElement.style.setProperty("--agent-dock-height", `${h}px`);
        };
        const onUp = (ev: PointerEvent) => {
          el.releasePointerCapture(ev.pointerId);
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          document.body.style.userSelect = "";
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
      }
    },
    [isRightDock, isBottomDock, dockedWidth, dockedHeight],
  );

  // ── Input panel left-edge resize (bottom dock only) ──
  const onInputPanelResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = inputPanelWidth;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        const w = Math.min(INPUT_PANEL_WIDTH_MAX, Math.max(INPUT_PANEL_WIDTH_MIN, startW + (startX - ev.clientX)));
        setInputPanelWidth(w);
      };
      const onUp = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [inputPanelWidth],
  );

  const handleClearMessages = useCallback(() => {
    clearMessages();
    setSaveLocation(null);
  }, [clearMessages]);

  // Auto-populate context from current page; re-runs on every SPA navigation.
  // The auto-detected context is always the FIRST item. User-added contexts follow.
  const pageContext = usePageContext();
  const prevPageContextRef = useRef<AgentContextValue | null>(null);
  useEffect(() => {
    if (!pageContext) {
      // Navigated to a page without context — remove previous auto-context if present
      if (prevPageContextRef.current) {
        const prev = prevPageContextRef.current;
        setContexts(cs => cs.filter(c => !(c.model === prev.model && c.id === prev.id)));
        prevPageContextRef.current = null;
      }
      return;
    }
    // Same page context as before — no change
    if (prevPageContextRef.current
        && prevPageContextRef.current.model === pageContext.model
        && prevPageContextRef.current.id === pageContext.id) {
      return;
    }
    setContexts(cs => {
      // Remove previous auto-detected context
      const prev = prevPageContextRef.current;
      const filtered = prev
        ? cs.filter(c => !(c.model === prev.model && c.id === prev.id))
        : cs;
      // Don't add if user already added this exact context manually
      if (filtered.some(c => c.model === pageContext.model && c.id === pageContext.id)) {
        return filtered;
      }
      // Insert auto-context at the beginning
      return [pageContext, ...filtered];
    });
    prevPageContextRef.current = pageContext;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageContext]);

  const handleAddContext = useCallback((item: MiniPickerPickableItem) => {
    const newCtx: AgentContextValue = {
      id: item.id as number,
      name: item.name,
      model: item.model as string,
      db_id: item.model === "table" ? (item as any).db_id : undefined,
    };
    setContexts(prev => {
      if (prev.some(c => c.model === newCtx.model && c.id === newCtx.id)) return prev;
      return [...prev, newCtx];
    });
    setContextPickerOpen(false);
  }, []);

  const handleAddDatabase = useCallback((db: { id: number; name: string }) => {
    setContexts(prev => {
      // Only one database allowed — replace existing
      const withoutDb = prev.filter(c => c.model !== "database");
      return [...withoutDb, { id: db.id, name: db.name, model: "database" }];
    });
    setDbPickerOpen(false);
  }, []);

  // Fetch databases for the add-context menu
  useEffect(() => {
    if ((dbPickerOpen || activePlaceholder?.type === "database") && !dbListLoaded) {
      api
        .GET("/api/database")({})
        .then((data: unknown) => {
          const d = data as { data?: { id: number; name: string }[] };
          setDbList(Array.isArray(d.data) ? d.data : []);
        })
        .catch(() => setDbList([]))
        .finally(() => setDbListLoaded(true));
    }
  }, [dbPickerOpen, dbListLoaded, activePlaceholder]);

  // Auto-focus textarea on mount
  useEffect(() => {
    setTimeout(() => composerRef.current?.focus(), 100);
  }, []);

  // Close slash menu on outside click (but not clicks inside the popup)
  useEffect(() => {
    if (!slashMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-slash-menu]")) return;
      setSlashMenuOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick as EventListener);
    };
  }, [slashMenuOpen]);

  // ── Slash menu (metric picker) ─────────────────────────────────────────
  const handleComposerChange = useCallback((text: string) => {
    setInputText(text);
  }, []);

  const handleSlashQueryChange = useCallback((query: string | null) => {
    if (query !== null) {
      setSlashMenuOpen(true);
      setSlashQuery(query);
      setSlashSelectedIndex(0);
    } else {
      setSlashMenuOpen(false);
    }
  }, []);

  const handleSlashMetricsLoaded = useCallback((metrics: MetricItem[]) => {
    slashMetricsRef.current = metrics;
    setSlashSelectedIndex(0);
  }, []);

  const handleMetricSelect = useCallback(
    (metric: MetricItem) => {
      setSlashMenuOpen(false);
      composerRef.current?.insertMetric(metric);
    },
    [],
  );

  // ── Template placeholder handling ─────────────────────────────────────
  const handleTemplatePlaceholderClick = useCallback(
    (type: TemplatePlaceholderType, id: string) => {
      setActivePlaceholder({ type, id });
    },
    [],
  );

  /** Map placeholder types to MiniPicker model names */
  const PLACEHOLDER_TO_PICKER_MODEL: Record<string, string> = {
    metric: "metric",
    question: "card",
    model: "dataset",
    table: "table",
    dashboard: "dashboard",
    document: "document",
    collection: "collection",
  };

  const handlePlaceholderPicked = useCallback(
    (item: MiniPickerPickableItem) => {
      if (!activePlaceholder) return;
      composerRef.current?.replaceTemplatePlaceholder(
        activePlaceholder.id,
        item.name,
        item.id as number,
      );
      setActivePlaceholder(null);
    },
    [activePlaceholder],
  );

  const handlePlaceholderDbPicked = useCallback(
    (db: { id: number; name: string }) => {
      if (!activePlaceholder) return;
      composerRef.current?.replaceTemplatePlaceholder(
        activePlaceholder.id,
        db.name,
        db.id,
      );
      setActivePlaceholder(null);
    },
    [activePlaceholder],
  );

  // ── File attachment ────────────────────────────────────────────────────
  // MIME types accepted by OpenAI Responses API input_file
  const getMimeType = (filename: string): string => {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      // Text & code
      md: "text/markdown", markdown: "text/markdown",
      txt: "text/plain", text: "text/plain",
      json: "application/json",
      sql: "text/x-sql",
      csv: "text/csv", tsv: "text/tsv",
      html: "text/html", htm: "text/html",
      xml: "text/xml",
      py: "text/x-python", js: "text/javascript",
      ts: "text/x-typescript", jsx: "text/jsx", tsx: "text/tsx",
      css: "text/css",
      yaml: "application/x-yaml", yml: "application/x-yaml",
      toml: "application/toml",
      sh: "text/x-sh", bash: "text/x-bash",
      // Documents
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      rtf: "application/rtf",
      // Spreadsheets
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
    };
    return map[ext] ?? "text/plain";
  };

  const maxFileBytes = agentSettings?.max_file_bytes ?? 200 * 1024;
  const maxFileKb = Math.round(maxFileBytes / 1024);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > maxFileBytes) {
      alert(t`File is too large. Maximum allowed size is ${maxFileKb} KB.`);
      e.target.value = "";
      return;
    }
    const mimeType = getMimeType(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const rawResult = reader.result as string;
      // FileReader.readAsDataURL produces "data:<browser-mime>;base64,<b64>"
      // but browser may misdetect the MIME (e.g. .md → text/plain).
      // Replace with our correct MIME type to match OpenAI's accepted list.
      const b64 = rawResult.split(",")[1];
      const correctedDataUrl = `data:${mimeType};base64,${b64}`;
      setAttachedFile({ name: file.name, data: correctedDataUrl, mimeType });
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-attached
    e.target.value = "";
  }, []);

  // ── Send ───────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = composerRef.current?.serialize()?.trim() ?? inputText.trim();
    if ((!text && !attachedFile) || isLoading) return;

    const langHint = lang === "ru" ? "\n[Respond in Russian]" : "\n[Respond in English]";

    // Extract context and datasource from unified contexts
    const entityContext = contexts.find(c => c.model !== "database") ?? null;
    const dbContext = contexts.find(c => c.model === "database" || c.model === "table") ?? null;

    setInputText("");
    composerRef.current?.clear();
    const fileToSend = attachedFile;
    setAttachedFile(null);
    sendMessage(
      (text || "") + langHint,
      entityContext,
      safeMode,
      saveLocation?.id,
      dbContext ? { type: dbContext.model === "table" ? "table" as const : "database" as const, id: dbContext.id, name: dbContext.name, db_id: dbContext.db_id } : null,
      fileToSend,
    );
    setTimeout(() => composerRef.current?.focus(), 50);
  }, [inputText, contexts, attachedFile, isLoading, sendMessage, safeMode, saveLocation, lang]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (slashMenuOpen) {
        const metrics = slashMetricsRef.current;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIndex((i: number) => (i < metrics.length - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIndex((i: number) => (i > 0 ? i - 1 : metrics.length - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const idx = slashSelectedIndex;
          if (metrics[idx]) {
            handleMetricSelect(metrics[idx]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [slashMenuOpen, slashSelectedIndex, handleMetricSelect, handleSend],
  );

  const handleSelectPrompt = useCallback(
    (prompt: string) => {
      setInputText("");
      const entityContext = contexts.find(c => c.model !== "database") ?? null;
      const dbContext = contexts.find(c => c.model === "database" || c.model === "table") ?? null;
      sendMessage(prompt, entityContext, safeMode, saveLocation?.id, dbContext ? { type: dbContext.model === "table" ? "table" as const : "database" as const, id: dbContext.id, name: dbContext.name, db_id: dbContext.db_id } : null);
    },
    [sendMessage, contexts, safeMode, saveLocation],
  );

  const handleSaveAsQuestion = useCallback(
    (sql: string) => {
      setInputText("");
      const entityContext = contexts.find(c => c.model !== "database") ?? null;
      const dbContext = contexts.find(c => c.model === "database" || c.model === "table") ?? null;
      sendMessage(
        `Save this SQL as a new question in my personal collection:\n\`\`\`sql\n${sql}\n\`\`\``,
        entityContext,
        safeMode,
        saveLocation?.id,
        dbContext ? { type: dbContext.model === "table" ? "table" as const : "database" as const, id: dbContext.id, name: dbContext.name, db_id: dbContext.db_id } : null,
      );
    },
    [sendMessage, contexts, safeMode, saveLocation],
  );

  const { isInteracting } = panelState;
  const isNotConfigured = agentSettings !== null && !agentSettings.configured;

  const modalClassName = [
    S.floatingModal,
    isRightDock && S.floatingModalDocked,
    isBottomDock && S.floatingModalDockedBottom,
    !isDocked && isInteracting && S.floatingModalInteracting,
  ]
    .filter(Boolean)
    .join(" ");

  const modalStyle = isRightDock
    ? { width: dockedWidth }
    : isBottomDock
      ? { height: dockedHeight }
      : panelStyle;

  const modal = (
    <div className={modalClassName} style={modalStyle}>
      {/* ── Docked resize handle ──── */}
      {isRightDock && (
        <div
          className={`${S.resizeHandle} ${S.resizeHandleLeft}`}
          onPointerDown={onDockedResizePointerDown}
        />
      )}
      {isBottomDock && (
        <div
          className={`${S.resizeHandle} ${S.resizeHandleTop}`}
          onPointerDown={onDockedResizePointerDown}
        />
      )}

      {/* ── Resize handles (hidden when minimized or docked) ──── */}
      {!isDocked && (
        <>
          <div
            className={`${S.resizeHandle} ${S.resizeHandleLeft}`}
            onPointerDown={resizeHandleProps("left")}
          />
          <div
            className={`${S.resizeHandle} ${S.resizeHandleTop}`}
            onPointerDown={resizeHandleProps("top")}
          />
          <div
            className={`${S.resizeHandle} ${S.resizeHandleBottomRight}`}
            onPointerDown={resizeHandleProps("bottom-right")}
          />
        </>
      )}

      {/* ── Header ─────────────────────────────────── */}
      <div className={`${S.modalHeader} ${isDocked ? S.modalHeaderDocked : ""} ${isBottomDock ? S.modalHeaderDockedBottom : ""}`} {...(isDocked ? {} : headerProps)}>
        <div className={S.modalHeaderTitle}>
          <Icon name="ai" size={18} c={isDocked ? "var(--mb-color-text-primary)" : "white"} />
          <Text size="sm" fw={600} c={isDocked ? "text-primary" : "white"}>
            {t`BI Agent`}
          </Text>
        </div>

        <div className={S.modalHeaderActions}>
          {messages.length > 0 && (
            <Tooltip label={t`New chat`}>
              <ActionIcon
                variant="transparent"
                c={isDocked ? "var(--mb-color-text-secondary)" : "rgba(255,255,255,0.8)"}
                size="sm"
                onClick={handleClearMessages}
                aria-label={t`New chat`}
              >
                <Icon name="add" size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="transparent"
                c={isDocked ? "var(--mb-color-text-secondary)" : "rgba(255,255,255,0.8)"}
                size="sm"
                aria-label={t`Dock mode`}
              >
                <Icon name={dockMode === "right" ? "chevronright" : dockMode === "bottom" ? "chevrondown" : "expand"} size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Icon name="expand" size={14} />}
                onClick={() => setDockMode("none")}
                fw={dockMode === "none" ? 600 : 400}
                c={dockMode === "none" ? "brand" : undefined}
              >
                {t`Floating`}
              </Menu.Item>
              <Menu.Item
                leftSection={<Icon name="chevronright" size={14} />}
                onClick={() => setDockMode("right")}
                fw={dockMode === "right" ? 600 : 400}
                c={dockMode === "right" ? "brand" : undefined}
              >
                {t`Dock right`}
              </Menu.Item>
              <Menu.Item
                leftSection={<Icon name="chevrondown" size={14} />}
                onClick={() => setDockMode("bottom")}
                fw={dockMode === "bottom" ? 600 : 400}
                c={dockMode === "bottom" ? "brand" : undefined}
              >
                {t`Dock bottom`}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Tooltip label={t`Close`}>
            <ActionIcon
              variant="transparent"
              c={isDocked ? "var(--mb-color-text-secondary)" : "rgba(255,255,255,0.8)"}
              size="sm"
              onClick={onClose}
              aria-label={t`Close`}
            >
              <Icon name="close" size={14} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────── */}
      {(
        <>
          {isNotConfigured ? (
            <Stack align="center" justify="center" p="xl" gap="sm" style={{ flex: 1 }}>
              <Icon name="gear_settings_filled" size={32} color="var(--mb-color-text-tertiary)" />
              <Text size="sm" c="text-secondary" ta="center" fw={500}>
                {t`BI Agent is not configured`}
              </Text>
              <Text size="xs" c="text-tertiary" ta="center">
                {t`Set the OpenAI API key in`}{" "}
                <Anchor href="/admin/settings/ai-agent" size="xs">
                  {t`Admin › Settings › BI Agent`}
                </Anchor>
                {t`, or via environment variable:`}
              </Text>
              <div className={S.envVarBox}>
                <code>MB_AI_AGENT_OPENAI_API_KEY</code>
              </div>
            </Stack>
          ) : (
            <div className={isBottomDock ? S.bodyHorizontal : S.bodyVertical}>
              <AgentChatMessages
                messages={messages}
                isLoading={isLoading}
                error={error}
                onSelectPrompt={handleSelectPrompt}
                onSaveAsQuestion={handleSaveAsQuestion}
                onRetry={retryLastMessage}
                examplePrompts={tipsData?.examples?.map(e => e[lang] ?? e.en ?? "") ?? undefined}
              />

              <div
                className={isBottomDock ? S.inputPanelRight : S.inputPanelBottom}
                style={isBottomDock ? { width: inputPanelWidth } : undefined}
              >
                {isBottomDock && (
                  <div
                    className={`${S.resizeHandle} ${S.resizeHandleLeft}`}
                    onPointerDown={onInputPanelResizePointerDown}
                  />
                )}
                {isBottomDock && (
                  <div className={S.inputPanelIcon}>
                    <Icon name="ai" size={48} />
                  </div>
                )}
                <div className={S.inputArea}>
                  <div ref={composerDivRef} className={S.composer}>
                    {/* Context chips row — always visible so + is accessible */}
                    <div className={S.contextChipsRow}>
                      {contexts.map((ctx, i) => (
                        <Tooltip key={`${ctx.model}-${ctx.id}-${i}`} label={`${ctx.model}: ${ctx.name}`} position="top" withArrow openDelay={400}>
                          <div className={S.contextChipInline}>
                            <Icon name={CONTEXT_ICON[ctx.model] ?? "database"} size={11} />
                            <Text size="xs" lh={1} className={S.contextChipInlineText}>{ctx.name}</Text>
                            <ActionIcon size={14} variant="transparent" onClick={() => setContexts(prev => prev.filter((_, j) => j !== i))}>
                              <Icon name="close" size={9} color="var(--mb-color-brand)" style={{ opacity: 0.6 }} />
                            </ActionIcon>
                          </div>
                        </Tooltip>
                      ))}
                      {attachedFile && (
                        <div className={S.contextChipInline}>
                          <Icon name="attachment" size={11} />
                          <Text size="xs" lh={1} className={S.contextChipInlineText}>{attachedFile.name}</Text>
                          <ActionIcon size={14} variant="transparent" onClick={() => setAttachedFile(null)}>
                            <Icon name="close" size={9} color="var(--mb-color-brand)" style={{ opacity: 0.6 }} />
                          </ActionIcon>
                        </div>
                      )}
                      <AgentMcpServers variant="chip" chipClassName={S.contextChipInline} />
                      {/* Attach: entity, database, file, or template */}
                      <Box className={S.contextAnchorInline}>
                        {dbPickerOpen ? (
                          <Menu opened onClose={() => setDbPickerOpen(false)} position="top-start" shadow="md" width={220}>
                            <Menu.Target>
                              <Tooltip label={t`Attach`} position="top" withArrow>
                                <ActionIcon variant="transparent" size="xs" onClick={() => setDbPickerOpen(false)} className={S.addContextBtn}>
                                  <Icon name="add" size={12} color="var(--mb-color-text-tertiary)" />
                                </ActionIcon>
                              </Tooltip>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>{t`Databases`}</Menu.Label>
                              {dbList.length === 0 ? (
                                <Menu.Item disabled><Text size="xs" c="text-tertiary">{t`Loading…`}</Text></Menu.Item>
                              ) : (
                                dbList.map(db => (
                                  <Menu.Item key={db.id} leftSection={<Icon name="database" size={14} />} onClick={() => handleAddDatabase(db)}>
                                    <Text size="xs" truncate>{db.name}</Text>
                                  </Menu.Item>
                                ))
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        ) : contextPickerOpen ? (
                          <>
                            <ActionIcon variant="transparent" size="xs" onClick={() => setContextPickerOpen(false)} className={S.addContextBtn}>
                              <Icon name="add" size={12} color="var(--mb-color-text-tertiary)" />
                            </ActionIcon>
                            <MiniPicker
                              opened
                              onClose={() => setContextPickerOpen(false)}
                              onChange={handleAddContext}
                              models={["card", "dataset", "metric", "table", "document"]}
                              position="top-start"
                              dropdownMt={-11}
                            />
                          </>
                        ) : templatesOpen ? (
                          <Menu opened onClose={() => setTemplatesOpen(false)} position="top-start" shadow="md" width={260}>
                            <Menu.Target>
                              <Tooltip label={t`Attach`} position="top" withArrow>
                                <ActionIcon variant="transparent" size="xs" onClick={() => setTemplatesOpen(false)} className={S.addContextBtn}>
                                  <Icon name="add" size={12} color="var(--mb-color-text-tertiary)" />
                                </ActionIcon>
                              </Tooltip>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>{t`Templates`}</Menu.Label>
                              {(tipsData?.templates ?? []).map((tip) => {
                                const tipLabel = tip.label[lang] ?? tip.label.en ?? "";
                                const tipTemplate = tip.template[lang] ?? tip.template.en ?? "";
                                return (
                                  <Menu.Item
                                    key={tipLabel}
                                    leftSection={<Icon name={tip.icon as any} size={14} color="var(--mb-color-brand)" />}
                                    onClick={() => {
                                      setTemplatesOpen(false);
                                      composerRef.current?.focus();
                                      composerRef.current?.insertTemplate(tipTemplate);
                                    }}
                                  >
                                    <Text size="xs">{tipLabel}</Text>
                                  </Menu.Item>
                                );
                              })}
                            </Menu.Dropdown>
                          </Menu>
                        ) : (
                          <Menu position="top-start" shadow="md" width={200}>
                            <Menu.Target>
                              <Tooltip label={t`Attach`} position="top" withArrow>
                                <ActionIcon variant="transparent" size="xs" className={S.addContextBtn}>
                                  <Icon name="add" size={12} color="var(--mb-color-text-tertiary)" />
                                </ActionIcon>
                              </Tooltip>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item leftSection={<Icon name="search" size={14} />} onClick={() => setContextPickerOpen(true)}>
                                <Text size="xs">{t`Question, model, table…`}</Text>
                              </Menu.Item>
                              <Menu.Item leftSection={<Icon name="database" size={14} />} onClick={() => setDbPickerOpen(true)}>
                                <Text size="xs">{t`Database`}</Text>
                              </Menu.Item>
                              <Menu.Item leftSection={<Icon name="attachment" size={14} />} onClick={() => fileInputRef.current?.click()}>
                                <Text size="xs">{t`File`}</Text>
                              </Menu.Item>
                              {(tipsData?.templates ?? []).length > 0 && (
                                <>
                                  <Menu.Divider />
                                  <Menu.Item leftSection={<Icon name="list" size={14} />} onClick={() => setTemplatesOpen(true)}>
                                    <Text size="xs">{t`Templates`}</Text>
                                  </Menu.Item>
                                </>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </Box>
                    </div>
                    <ComposerInput
                      ref={composerRef}
                      onChange={handleComposerChange}
                      onKeyDown={handleKeyDown}
                      onSlashQueryChange={handleSlashQueryChange}
                      onTemplatePlaceholderClick={handleTemplatePlaceholderClick}
                      markdownEnabled={markdownMode}
                      placeholder={t`Ask me anything about your data…`}
                      disabled={isLoading}
                      className={S.composerTextarea}
                    />
                    {slashMenuOpen && (
                      <MetricSlashMenu
                        query={slashQuery}
                        selectedIndex={slashSelectedIndex}
                        anchorRef={composerDivRef}
                        onLoaded={handleSlashMetricsLoaded}
                        onSelect={handleMetricSelect}
                        databaseId={contexts.find(c => c.model === "database")?.id ?? contexts.find(c => c.model === "table")?.db_id}
                        tableIds={contexts.filter(c => c.model === "table").map(c => c.id)}
                      />
                    )}
                    {/* Template placeholder picker — entity types */}
                    {activePlaceholder && activePlaceholder.type !== "database" && activePlaceholder.type !== "datetime" && activePlaceholder.type !== "input" && (
                      <MiniPicker
                        opened
                        onClose={() => setActivePlaceholder(null)}
                        onChange={handlePlaceholderPicked}
                        models={[PLACEHOLDER_TO_PICKER_MODEL[activePlaceholder.type] ?? "card"]}
                        position="top-start"
                        dropdownMt={-11}
                      />
                    )}
                    {/* Template placeholder picker — database */}
                    {activePlaceholder?.type === "database" && (
                      <Menu opened onClose={() => setActivePlaceholder(null)} position="top-start" shadow="md" width={220}>
                        <Menu.Target>
                          <span style={{ position: "absolute", bottom: 0, left: 0 }} />
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Label>{t`Select database`}</Menu.Label>
                          {dbList.map(db => (
                            <Menu.Item key={db.id} onClick={() => handlePlaceholderDbPicked(db)}>
                              <Text size="xs">{db.name}</Text>
                            </Menu.Item>
                          ))}
                        </Menu.Dropdown>
                      </Menu>
                    )}
                    {/* Template placeholder picker — datetime */}
                    {activePlaceholder?.type === "datetime" && (
                      <Menu opened onClose={() => { setActivePlaceholder(null); setDateRangeMode(false); }} position="top-start" shadow="md" width={220}>
                        <Menu.Target>
                          <span style={{ position: "absolute", bottom: 0, left: 0 }} />
                        </Menu.Target>
                        <Menu.Dropdown style={{ maxHeight: 320, overflowY: "auto" }}>
                          {!dateRangeMode ? (
                            <>
                              <Menu.Label>{t`Relative`}</Menu.Label>
                              {[
                                { label: t`Today`, value: "today" },
                                { label: t`Yesterday`, value: "yesterday" },
                                { label: t`Last 7 days`, value: "last 7 days" },
                                { label: t`Last 14 days`, value: "last 14 days" },
                                { label: t`Last 30 days`, value: "last 30 days" },
                                { label: t`Last 90 days`, value: "last 90 days" },
                                { label: t`This week`, value: "this week" },
                                { label: t`Last week`, value: "last week" },
                                { label: t`This month`, value: "this month" },
                                { label: t`Last month`, value: "last month" },
                                { label: t`This quarter`, value: "this quarter" },
                                { label: t`Last quarter`, value: "last quarter" },
                                { label: t`This year`, value: "this year" },
                                { label: t`Last year`, value: "last year" },
                              ].map(opt => (
                                <Menu.Item
                                  key={opt.value}
                                  onClick={() => {
                                    composerRef.current?.replaceTemplatePlaceholder(activePlaceholder.id, opt.label);
                                    setActivePlaceholder(null);
                                  }}
                                >
                                  <Text size="xs">{opt.label}</Text>
                                </Menu.Item>
                              ))}
                              <Menu.Divider />
                              <Menu.Label>{t`Custom`}</Menu.Label>
                              <Menu.Item onClick={() => { setDateRangeMode(true); setDateFrom(""); setDateTo(""); }}>
                                <Text size="xs">{t`Date range…`}</Text>
                              </Menu.Item>
                            </>
                          ) : (
                            <Box p="xs">
                              <Text size="xs" fw={600} mb={6}>{t`Date range`}</Text>
                              <Flex direction="column" gap={6}>
                                <input
                                  type="date"
                                  value={dateFrom}
                                  onChange={(e) => setDateFrom(e.target.value)}
                                  style={{ fontSize: 12, padding: "4px 6px", border: "1px solid var(--mb-color-border)", borderRadius: 4, width: "100%" }}
                                />
                                <input
                                  type="date"
                                  value={dateTo}
                                  onChange={(e) => setDateTo(e.target.value)}
                                  style={{ fontSize: 12, padding: "4px 6px", border: "1px solid var(--mb-color-border)", borderRadius: 4, width: "100%" }}
                                />
                                <Flex gap={6}>
                                  <ActionIcon
                                    variant="subtle"
                                    size="sm"
                                    onClick={() => setDateRangeMode(false)}
                                  >
                                    <Icon name="chevronleft" size={14} />
                                  </ActionIcon>
                                  <ActionIcon
                                    variant="filled"
                                    color="brand"
                                    size="sm"
                                    disabled={!dateFrom || !dateTo}
                                    onClick={() => {
                                      composerRef.current?.replaceTemplatePlaceholder(activePlaceholder.id, `${dateFrom} — ${dateTo}`);
                                      setActivePlaceholder(null);
                                      setDateRangeMode(false);
                                    }}
                                    style={{ flex: 1 }}
                                  >
                                    <Text size="xs" c="white">{t`Apply`}</Text>
                                  </ActionIcon>
                                </Flex>
                              </Flex>
                            </Box>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    )}
                    {/* Template placeholder picker — text input */}
                    {activePlaceholder?.type === "input" && (
                      <Menu opened onClose={() => { setActivePlaceholder(null); setInputText2(""); }} position="top-start" shadow="md" width={220}>
                        <Menu.Target>
                          <span style={{ position: "absolute", bottom: 0, left: 0 }} />
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Box p="xs">
                            <Text size="xs" fw={600} mb={6}>{t`Enter value`}</Text>
                            <input
                              type="text"
                              autoFocus
                              value={inputText2}
                              onChange={(e) => setInputText2(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && inputText2.trim()) {
                                  composerRef.current?.replaceTemplatePlaceholder(activePlaceholder.id, inputText2.trim());
                                  setActivePlaceholder(null);
                                  setInputText2("");
                                }
                                e.stopPropagation();
                              }}
                              placeholder={t`Type text…`}
                              style={{ fontSize: 12, padding: "6px 8px", border: "1px solid var(--mb-color-border)", borderRadius: 4, width: "100%", outline: "none" }}
                            />
                            <Flex mt={6} justify="flex-end">
                              <ActionIcon
                                variant="filled"
                                color="brand"
                                size="sm"
                                disabled={!inputText2.trim()}
                                onClick={() => {
                                  composerRef.current?.replaceTemplatePlaceholder(activePlaceholder.id, inputText2.trim());
                                  setActivePlaceholder(null);
                                  setInputText2("");
                                }}
                              >
                                <Icon name="check" size={12} />
                              </ActionIcon>
                            </Flex>
                          </Box>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                    <div className={S.composerFooter}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".md,.txt,.csv,.tsv,.json,.sql,.html,.xml,.py,.js,.ts,.jsx,.tsx,.css,.yaml,.yml,.toml,.sh,.pdf,.docx,.doc,.rtf,.xlsx,.xls"
                        style={{ display: "none" }}
                        onChange={handleFileChange}
                      />
                      <Text size="xs" c="text-tertiary" className={S.inputHint} style={{ flex: 1, minWidth: 0 }}>
                        {t`Enter — send · Shift+Enter — new line · / — metrics · {{ }} — template`}
                      </Text>
                      <Flex gap={2} align="center">
                        {/* ⋮ settings menu */}
                        <Menu position="top-end" shadow="md" width={200} closeOnItemClick={false}>
                          <Menu.Target>
                            <Tooltip label={t`Settings`}>
                              <ActionIcon variant="transparent" size="sm" aria-label={t`Settings`}>
                                <Icon name="gear" size={14} color="var(--mb-color-text-tertiary)" />
                              </ActionIcon>
                            </Tooltip>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Label>{t`Language`}</Menu.Label>
                            <Menu.Item
                              onClick={() => setLang("ru")}
                              rightSection={lang === "ru" ? <Icon name="check" size={12} color="var(--mb-color-brand)" /> : null}
                            >
                              <Text size="xs">Русский</Text>
                            </Menu.Item>
                            <Menu.Item
                              onClick={() => setLang("en")}
                              rightSection={lang === "en" ? <Icon name="check" size={12} color="var(--mb-color-brand)" /> : null}
                            >
                              <Text size="xs">English</Text>
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item
                              onClick={() => setMarkdownMode(v => !v)}
                              rightSection={markdownMode ? <Icon name="check" size={12} color="var(--mb-color-brand)" /> : null}
                              leftSection={<Text size="xs" fw={700} c={markdownMode ? "brand" : "text-tertiary"}>MD</Text>}
                            >
                              <Text size="xs">{t`Markdown formatting`}</Text>
                            </Menu.Item>
                            <Menu.Item
                              onClick={() => setSafeMode((v: boolean) => !v)}
                              rightSection={safeMode ? <Icon name="check" size={12} color="var(--mb-color-success)" /> : null}
                              leftSection={<Icon name="lock" size={14} color={safeMode ? "var(--mb-color-success)" : undefined} />}
                            >
                              <Text size="xs">{t`Safe mode`}</Text>
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                        {isLoading ? (
                          <Tooltip label={t`Stop generating`}>
                            <ActionIcon
                              variant="transparent"
                              size="sm"
                              onClick={stopGeneration}
                              aria-label={t`Stop generating`}
                            >
                              <Icon name="close" size={14} color="var(--mb-color-error)" />
                            </ActionIcon>
                          </Tooltip>
                        ) : (
                          <ActionIcon
                            variant="transparent"
                            size="sm"
                            onClick={handleSend}
                            disabled={!inputText.trim() && !attachedFile}
                            aria-label={t`Send message`}
                          >
                            <Icon
                              name="send"
                              size={14}
                              color={(!inputText.trim() && !attachedFile) ? "var(--mb-color-text-tertiary)" : "var(--mb-color-brand)"}
                            />
                          </ActionIcon>
                        )}
                      </Flex>
                    </div>
                  </div>
                </div>

                {/* ── Bottom bar: save location ── */}
                <div className={`${S.bottomBar} ${isBottomDock ? S.bottomBarVertical : ""}`}>
                  <AgentSaveLocationPicker value={saveLocation} onChange={setSaveLocation} />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
