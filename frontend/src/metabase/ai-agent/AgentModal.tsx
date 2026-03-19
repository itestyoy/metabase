import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { ActionIcon, Anchor, Box, Flex, Icon, Menu, Popover, Stack, Text, Tooltip } from "metabase/ui";
// Textarea removed — replaced by ComposerInput (contentEditable)

import { AgentChatMessages } from "./AgentChatMessages";
import type { ComposerInputHandle } from "./ComposerInput";
import { ComposerInput } from "./ComposerInput";
import type { MetricItem } from "./MetricSlashMenu";
import { MetricSlashMenu } from "./MetricSlashMenu";
import type { AgentContextValue } from "./AgentContextPicker";
import { AgentContextPicker } from "./AgentContextPicker";
import type { AgentDatasource } from "./AgentDatasourcePicker";
import { AgentDatasourcePicker } from "./AgentDatasourcePicker";
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
  const [tipsOpen, setTipsOpen] = useState(false);
  const slashMetricsRef = useRef<MetricItem[]>([]);
  const [context, setContext] = useState<AgentContextValue | null>(null);
  const [datasource, setDatasource] = useState<AgentDatasource | null>(null);
  const isDatasourceManual = useRef(false);
  const [safeMode, setSafeMode] = useState(false);
  const [saveLocation, setSaveLocation] = useState<SaveLocation | null>(null);
  const [dockMode, setDockMode] = useState<DockMode>(() => readDockState().mode);
  const [dockedWidth, setDockedWidth] = useState(() => readDockState().width);
  const [dockedHeight, setDockedHeight] = useState(() => readDockState().height);
  const [inputPanelWidth, setInputPanelWidth] = useState(() => readDockState().inputPanelWidth ?? INPUT_PANEL_WIDTH_DEFAULT);
  const isDocked = dockMode !== "none";
  const isBottomDock = dockMode === "bottom";
  const isRightDock = dockMode === "right";
  const isContextManual = useRef(false);

  const { messages, isLoading, error, agentSettings, chatCollectionId, chatCollectionName, sendMessage, clearMessages, stopGeneration, retryLastMessage } =
    useAgentChat();
  const composerRef = useRef<ComposerInputHandle>(null);
  const composerDivRef = useRef<HTMLDivElement>(null);

  // Auto-populate datasource from default_database setting
  useEffect(() => {
    if (!isDatasourceManual.current && agentSettings?.default_database) {
      setDatasource({
        type: "database",
        id: agentSettings.default_database.id,
        name: agentSettings.default_database.name,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSettings?.default_database]);

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
  const pageContext = usePageContext();
  useEffect(() => {
    if (!isContextManual.current) {
      setContext(pageContext);
    }
  }, [pageContext]);

  const handleContextChange = useCallback((value: AgentContextValue | null) => {
    isContextManual.current = true;
    setContext(value);
  }, []);

  const handleDatasourceChange = useCallback((value: AgentDatasource | null) => {
    isDatasourceManual.current = true;
    setDatasource(value);
  }, []);

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

  // ── Send ───────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = composerRef.current?.serialize()?.trim() ?? inputText.trim();
    if (!text || isLoading) return;

    setInputText("");
    composerRef.current?.clear();
    sendMessage(text, context, safeMode, saveLocation?.id, datasource);
    setTimeout(() => composerRef.current?.focus(), 50);
  }, [inputText, isLoading, sendMessage, context, safeMode, saveLocation, datasource]);

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
      sendMessage(prompt, context, safeMode, saveLocation?.id, datasource);
    },
    [sendMessage, context, safeMode, saveLocation, datasource],
  );

  const handleSaveAsQuestion = useCallback(
    (sql: string) => {
      setInputText("");
      sendMessage(
        `Save this SQL as a new question in my personal collection:\n\`\`\`sql\n${sql}\n\`\`\``,
        context,
        safeMode,
        saveLocation?.id,
        datasource,
      );
    },
    [sendMessage, context, safeMode, saveLocation],
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
                    <ComposerInput
                      ref={composerRef}
                      onChange={handleComposerChange}
                      onKeyDown={handleKeyDown}
                      onSlashQueryChange={handleSlashQueryChange}
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
                        datasourceId={datasource?.id}
                      />
                    )}
                    <div className={S.composerFooter}>
                      <Text size="xs" c="text-tertiary" className={S.inputHint}>
                        {t`Enter to send · Shift+Enter for new line · / for metrics`}
                      </Text>
                      <Flex gap={2} align="center">
                        <Popover position="top-end" shadow="md" width={280} opened={tipsOpen} onChange={setTipsOpen}>
                          <Popover.Target>
                            <ActionIcon variant="transparent" size="sm" aria-label={t`Tips`} onClick={() => setTipsOpen(o => !o)}>
                              <Icon name="info" size={14} color="var(--mb-color-text-tertiary)" />
                            </ActionIcon>
                          </Popover.Target>
                          <Popover.Dropdown p="xs">
                            <Text size="xs" fw={600} c="text-secondary" mb={6}>{t`Templates`}</Text>
                            <Stack gap={2}>
                              {[
                                { icon: "line" as const, label: t`Chart`, template: "Show {metric} by {dimension} for the last {period}" },
                                { icon: "table2" as const, label: t`Compare`, template: "Compare {metric_A} vs {metric_B} by {dimension}" },
                                { icon: "filter" as const, label: t`Filter`, template: "Show {metric} where {field} is {value}" },
                                { icon: "bolt" as const, label: t`Investigate`, template: "Why did {metric} change in {period}? Break down by {dimension}" },
                                { icon: "dashboard" as const, label: t`Dashboard`, template: "Create a dashboard: {metric_1} by {dim_1}, {metric_2} by {dim_2}" },
                                { icon: "document" as const, label: t`Report`, template: "Create a report analyzing {topic} for {period}" },
                                { icon: "search" as const, label: t`Find`, template: "Find all metrics related to {keyword}" },
                                { icon: "sum" as const, label: t`Ratio`, template: "Calculate {metric_A} / {metric_B} by {dimension}" },
                              ].map(tip => (
                                <Flex
                                  key={tip.label}
                                  align="center"
                                  gap={8}
                                  px={8}
                                  py={5}
                                  style={{ borderRadius: 6, cursor: "pointer", transition: "background 0.1s" }}
                                  className={S.tipItem}
                                  onClick={() => {
                                    setTipsOpen(false);
                                    composerRef.current?.focus();
                                    document.execCommand("insertText", false, tip.template);
                                    // Select first placeholder so user can type over it
                                    setTimeout(() => {
                                      const el = (composerRef.current as unknown as { getText?: () => string })?.getText?.() ?? "";
                                      const match = el.match(/\{(\w+)\}/);
                                      if (match) {
                                        const sel = window.getSelection();
                                        if (sel && sel.rangeCount > 0) {
                                          const range = sel.getRangeAt(0);
                                          const node = range.startContainer;
                                          if (node.nodeType === Node.TEXT_NODE) {
                                            const text = node.textContent ?? "";
                                            const idx = text.indexOf(match[0]);
                                            if (idx >= 0) {
                                              range.setStart(node, idx);
                                              range.setEnd(node, idx + match[0].length);
                                              sel.removeAllRanges();
                                              sel.addRange(range);
                                            }
                                          }
                                        }
                                      }
                                    }, 50);
                                  }}
                                >
                                  <Icon name={tip.icon} size={13} color="var(--mb-color-brand)" style={{ flexShrink: 0 }} />
                                  <Box style={{ flex: 1, minWidth: 0 }}>
                                    <Text size="xs" fw={500} c="text-primary">{tip.label}</Text>
                                    <Text size="xs" c="text-tertiary" truncate>{tip.template}</Text>
                                  </Box>
                                </Flex>
                              ))}
                            </Stack>
                            <Box mt={8} pt={6} style={{ borderTop: "1px solid var(--mb-color-border)" }}>
                              <Text size="xs" c="text-tertiary" lh={1.4}>
                                {t`Replace {placeholders} with your values. Type / to insert metrics.`}
                              </Text>
                            </Box>
                          </Popover.Dropdown>
                        </Popover>
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
                            disabled={!inputText.trim()}
                            aria-label={t`Send message`}
                          >
                            <Icon
                              name="send"
                              size={14}
                              color={!inputText.trim() ? "var(--mb-color-text-tertiary)" : "var(--mb-color-brand)"}
                            />
                          </ActionIcon>
                        )}
                      </Flex>
                    </div>
                  </div>
                </div>

                {/* ── Bottom bar: context, save location, safe mode ── */}
                <div className={`${S.bottomBar} ${isBottomDock ? S.bottomBarVertical : ""}`}>
                  <Tooltip label={safeMode ? t`Safe mode ON — write tools disabled` : t`Safe mode OFF — all tools enabled`}>
                    <ActionIcon
                      variant={safeMode ? "light" : "subtle"}
                      color={safeMode ? "green" : "gray"}
                      size="sm"
                      onClick={() => setSafeMode((v: boolean) => !v)}
                      aria-label={t`Toggle safe mode`}
                    >
                      <Icon name="lock" size={14} color={safeMode ? "var(--mb-color-success)" : undefined} />
                    </ActionIcon>
                  </Tooltip>
                  <div className={S.bottomBarDivider} />
                  <AgentContextPicker value={context} onChange={handleContextChange} />
                  <AgentDatasourcePicker value={datasource} onChange={handleDatasourceChange} />
                  <AgentSaveLocationPicker value={saveLocation} onChange={setSaveLocation} />
                  <AgentMcpServers />
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
