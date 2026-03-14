import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { ActionIcon, Anchor, Icon, Stack, Text, Textarea, Tooltip } from "metabase/ui";

import { AgentChatMessages } from "./AgentChatMessages";
import type { AgentContextValue } from "./AgentContextPicker";
import { AgentContextPicker } from "./AgentContextPicker";
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

const DOCK_WIDTH_DEFAULT = 420;
const DOCK_WIDTH_MIN = 320;
const DOCK_WIDTH_MAX = 800;

interface AgentModalProps {
  onClose: () => void;
}

export function AgentModal({ onClose }: AgentModalProps) {
  const { panelState, panelStyle, headerProps, resizeHandleProps, toggleMinimized } =
    useFloatingPanel(PANEL_CONSTRAINTS);

  const [inputText, setInputText] = useState("");
  const [context, setContext] = useState<AgentContextValue | null>(null);
  const [safeMode, setSafeMode] = useState(false);
  const [saveLocation, setSaveLocation] = useState<SaveLocation | null>(null);
  const [isDocked, setIsDocked] = useState(false);
  const [dockedWidth, setDockedWidth] = useState(DOCK_WIDTH_DEFAULT);
  const isContextManual = useRef(false);

  const { messages, isLoading, error, agentSettings, chatCollectionId, chatCollectionName, sendMessage, clearMessages } =
    useAgentChat();

  // When the backend auto-creates a chat collection, show it in the save-location chip
  useEffect(() => {
    if (chatCollectionId && chatCollectionName && !saveLocation) {
      setSaveLocation({ id: chatCollectionId, name: chatCollectionName });
    }
  }, [chatCollectionId, chatCollectionName, saveLocation]);

  // When docked, set a CSS variable so the main app content shrinks to make room
  useEffect(() => {
    if (isDocked) {
      document.documentElement.style.setProperty("--agent-dock-width", `${dockedWidth}px`);
    } else {
      document.documentElement.style.removeProperty("--agent-dock-width");
    }
    return () => {
      document.documentElement.style.removeProperty("--agent-dock-width");
    };
  }, [isDocked]);

  const toggleDocked = useCallback(() => {
    setIsDocked((d: boolean) => !d);
  }, []);

  // ── Docked left-edge resize ─────────────────────────────────────────
  const onDockedResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = dockedWidth;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        const delta = startX - ev.clientX;
        const w = Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, startWidth + delta));
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
    },
    [dockedWidth],
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

  // ── Send ───────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isLoading) return;
    setInputText("");
    sendMessage(text, context, safeMode, saveLocation?.id);
  }, [inputText, isLoading, sendMessage, context, safeMode, saveLocation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleSelectPrompt = useCallback(
    (prompt: string) => {
      setInputText("");
      sendMessage(prompt, context, safeMode, saveLocation?.id);
    },
    [sendMessage, context, safeMode, saveLocation],
  );

  const handleSaveAsQuestion = useCallback(
    (sql: string) => {
      setInputText("");
      sendMessage(
        `Save this SQL as a new question in my personal collection:\n\`\`\`sql\n${sql}\n\`\`\``,
        context,
        safeMode,
        saveLocation?.id,
      );
    },
    [sendMessage, context, safeMode, saveLocation],
  );

  const { isMinimized, isInteracting } = panelState;
  const isNotConfigured = agentSettings !== null && !agentSettings.configured;

  const modalClassName = [
    S.floatingModal,
    isDocked && S.floatingModalDocked,
    !isDocked && isMinimized && S.floatingModalMinimized,
    !isDocked && isInteracting && S.floatingModalInteracting,
  ]
    .filter(Boolean)
    .join(" ");

  const modal = (
    <div className={modalClassName} style={isDocked ? { width: dockedWidth } : panelStyle}>
      {/* ── Docked left resize handle ──── */}
      {isDocked && (
        <div
          className={`${S.resizeHandle} ${S.resizeHandleLeft}`}
          onPointerDown={onDockedResizePointerDown}
        />
      )}

      {/* ── Resize handles (hidden when minimized or docked) ──── */}
      {!isMinimized && !isDocked && (
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
      <div className={`${S.modalHeader} ${isDocked ? S.modalHeaderDocked : ""}`} {...(isDocked ? {} : headerProps)}>
        <div className={S.modalHeaderTitle}>
          <Icon name="ai" size={18} c="white" />
          <Text size="sm" fw={600} c="white">
            {t`BI Agent`}
          </Text>
        </div>

        <div className={S.modalHeaderActions}>
          {!isMinimized && messages.length > 0 && (
            <Tooltip label={t`Clear conversation`}>
              <ActionIcon
                variant="transparent"
                c="rgba(255,255,255,0.8)"
                size="sm"
                onClick={handleClearMessages}
                aria-label={t`Clear conversation`}
              >
                <Icon name="trash" size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={isDocked ? t`Undock` : t`Dock to right`}>
            <ActionIcon
              variant="transparent"
              c="rgba(255,255,255,0.8)"
              size="sm"
              onClick={toggleDocked}
              aria-label={isDocked ? t`Undock` : t`Dock to right`}
            >
              <Icon name={isDocked ? "sidebar_open" : "sidebar_closed"} size={14} />
            </ActionIcon>
          </Tooltip>
          {!isDocked && (
            <Tooltip label={isMinimized ? t`Expand` : t`Minimize`}>
              <ActionIcon
                variant="transparent"
                c="rgba(255,255,255,0.8)"
                size="sm"
                onClick={toggleMinimized}
                aria-label={isMinimized ? t`Expand` : t`Minimize`}
              >
                <Icon name={isMinimized ? "chevronup" : "chevrondown"} size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={t`Close`}>
            <ActionIcon
              variant="transparent"
              c="rgba(255,255,255,0.8)"
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
      {!isMinimized && (
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
            <>
              <AgentChatMessages
                messages={messages}
                isLoading={isLoading}
                onSelectPrompt={handleSelectPrompt}
                onSaveAsQuestion={handleSaveAsQuestion}
              />

              {error && (
                <div className={S.errorBanner}>
                  <Text size="xs" c="error">
                    {error}
                  </Text>
                </div>
              )}

              <div className={S.inputArea}>
                <div className={S.composer}>
                  <Textarea
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t`Ask me anything about your data…`}
                    minRows={1}
                    maxRows={5}
                    autosize
                    disabled={isLoading}
                    variant="unstyled"
                    size="sm"
                    className={S.composerTextarea}
                  />
                  <div className={S.composerFooter}>
                    <Text size="xs" c="text-tertiary" className={S.inputHint}>
                      {t`Enter to send · Shift+Enter for new line`}
                    </Text>
                    <ActionIcon
                      variant="transparent"
                      size="sm"
                      onClick={handleSend}
                      disabled={isLoading || !inputText.trim()}
                      aria-label={t`Send message`}
                    >
                      <Icon
                        name="send"
                        size={14}
                        color={
                          isLoading || !inputText.trim()
                            ? "var(--mb-color-text-tertiary)"
                            : "var(--mb-color-brand)"
                        }
                      />
                    </ActionIcon>
                  </div>
                </div>
              </div>

              {/* ── Bottom bar: safe mode, context, save location ── */}
              <div className={S.bottomBar}>
                <Tooltip label={safeMode ? t`Safe mode ON — write tools disabled` : t`Safe mode OFF — all tools enabled`}>
                  <ActionIcon
                    variant={safeMode ? "filled" : "subtle"}
                    color={safeMode ? "green" : "gray"}
                    size="sm"
                    onClick={() => setSafeMode(v => !v)}
                    aria-label={t`Toggle safe mode`}
                    className={S.safeModeButton}
                  >
                    <Icon name="lock" size={14} />
                  </ActionIcon>
                </Tooltip>
                <div className={S.bottomBarRow}>
                  <AgentContextPicker value={context} onChange={handleContextChange} />
                  <AgentSaveLocationPicker value={saveLocation} onChange={setSaveLocation} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
