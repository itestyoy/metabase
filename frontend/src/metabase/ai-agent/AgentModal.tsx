import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { ActionIcon, Anchor, Icon, Stack, Text, Textarea, Tooltip } from "metabase/ui";

import { AgentChatMessages } from "./AgentChatMessages";
import type { AgentContextValue } from "./AgentContextPicker";
import { AgentContextPicker } from "./AgentContextPicker";
import { useAgentChat } from "./hooks/useAgentChat";
import { usePageContext } from "./hooks/usePageContext";
import S from "./AgentModal.module.css";

const MIN_WIDTH = 320;
const MAX_WIDTH = 800;
const MIN_HEIGHT = 360;
const MAX_HEIGHT = 920;
const APPBAR_HEIGHT = 50;
const MINIMIZED_HEIGHT = 52;
/** Minimum distance (px) from any viewport edge the modal must maintain. */
const EDGE_BUFFER = 5;

type ResizeEdge = "left" | "top" | "bottom-right";

interface AgentModalProps {
  onClose: () => void;
}

export function AgentModal({ onClose }: AgentModalProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  // Ref mirrors isMinimized so the mousemove closure (deps=[]) can read it without going stale
  const isMinimizedRef = useRef(false);
  const toggleMinimized = useCallback(() => {
    setIsMinimized((m: boolean) => {
      isMinimizedRef.current = !m;
      return !m;
    });
  }, []);
  const [inputText, setInputText] = useState("");
  const [context, setContext] = useState<AgentContextValue | null>(null);
  // Tracks whether the user manually changed the context (vs auto-populated from URL)
  const isContextManual = useRef(false);

  const { messages, isLoading, error, agentSettings, sendMessage, clearMessages } =
    useAgentChat();

  // Auto-populate context from current page; re-runs on every SPA navigation.
  // If the user manually picked a context, don't overwrite it.
  const pageContext = usePageContext();
  useEffect(() => {
    if (!isContextManual.current) {
      setContext(pageContext);
    }
  }, [pageContext]);

  // Wrap setContext to mark manual changes
  const handleContextChange = useCallback((value: AgentContextValue | null) => {
    isContextManual.current = true;
    setContext(value);
  }, []);

  // ── Position (right/bottom anchored) ───────────────────────────────────
  // Open near top-right, just below the AppBar, at minimum size
  const initialBottom = window.innerHeight - APPBAR_HEIGHT - MIN_HEIGHT - EDGE_BUFFER;
  const position = useRef({ right: EDGE_BUFFER + 20, bottom: Math.max(EDGE_BUFFER, initialBottom) });
  const size = useRef({ width: MIN_WIDTH, height: MIN_HEIGHT });

  // dragOrigin: cursor offset from modal's top-left corner at drag start
  const dragOrigin = useRef<{
    offsetX: number; // cursor.x - modal.left
    offsetY: number; // cursor.y - modal.top
  } | null>(null);

  // resizeOrigin: snapshot of fixed edges at resize start
  const resizeOrigin = useRef<{
    // Fixed edges (screen coords, pixels from screen top-left)
    fixedRight: number;  // right edge X = window.innerWidth - right (for left-resize)
    fixedBottom: number; // bottom edge Y = window.innerHeight - bottom (for top-resize)
    fixedLeft: number;   // left edge X (for bottom-right resize)
    fixedTop: number;    // top edge Y (for bottom-right resize)
    edge: ResizeEdge;
  } | null>(null);

  const [, forceRender] = useState(0);

  // ── Drag header ─────────────────────────────────────────────────────────
  // Store cursor offset from modal top-left so the modal doesn't jump on drag start.
  // When minimized the rendered height is MINIMIZED_HEIGHT (header only), not size.current.height.
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    const renderedHeight = isMinimizedRef.current ? MINIMIZED_HEIGHT : size.current.height;
    const modalLeft = window.innerWidth  - position.current.right - size.current.width;
    const modalTop  = window.innerHeight - position.current.bottom - renderedHeight;
    dragOrigin.current = {
      offsetX: e.clientX - modalLeft,
      offsetY: e.clientY - modalTop,
    };
  }, []);

  // ── Resize handles ──────────────────────────────────────────────────────
  const handleResizeMouseDown = useCallback(
    (edge: ResizeEdge) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { right, bottom } = position.current;
      const { width, height } = size.current;
      resizeOrigin.current = {
        fixedRight:  window.innerWidth  - right,          // right edge X in screen coords
        fixedBottom: window.innerHeight - bottom,         // bottom edge Y in screen coords
        fixedLeft:   window.innerWidth  - right - width,  // left edge X in screen coords
        fixedTop:    window.innerHeight - bottom - height,// top edge Y in screen coords
        edge,
      };
    },
    [],
  );

  // ── Global mouse move/up ────────────────────────────────────────────────
  useEffect(() => {
    const clamp = (v: number, min: number, max: number) =>
      Math.min(max, Math.max(min, v));

    const onMouseMove = (e: MouseEvent) => {
      // ── Drag ──────────────────────────────────────────────────────────
      const d = dragOrigin.current;
      if (d) {
        const modalLeft = e.clientX - d.offsetX;
        const modalTop  = e.clientY - d.offsetY;
        const renderedHeight = isMinimizedRef.current ? MINIMIZED_HEIGHT : size.current.height;
        // Clamp so every edge stays within the viewport (with EDGE_BUFFER margin).
        // Top edge must stay below the AppBar.
        position.current = {
          right:  clamp(window.innerWidth  - modalLeft - size.current.width, EDGE_BUFFER, window.innerWidth  - size.current.width  - EDGE_BUFFER),
          bottom: clamp(window.innerHeight - modalTop  - renderedHeight,     EDGE_BUFFER, window.innerHeight - renderedHeight - APPBAR_HEIGHT - EDGE_BUFFER),
        };
        forceRender(n => n + 1);
        return;
      }

      // ── Resize ────────────────────────────────────────────────────────
      const r = resizeOrigin.current;
      if (!r) return;

      if (r.edge === "left") {
        // Right edge fixed; left edge follows cursor; left must stay ≥ EDGE_BUFFER from viewport left
        const maxWidth = Math.min(MAX_WIDTH, r.fixedRight - EDGE_BUFFER);
        const newWidth = clamp(r.fixedRight - e.clientX, MIN_WIDTH, maxWidth);
        size.current = { ...size.current, width: newWidth };
      } else if (r.edge === "top") {
        // Bottom edge fixed; top edge follows cursor; top must stay ≥ APPBAR_HEIGHT + EDGE_BUFFER
        const maxHeight = Math.min(MAX_HEIGHT, r.fixedBottom - APPBAR_HEIGHT - EDGE_BUFFER);
        const newHeight = clamp(r.fixedBottom - e.clientY, MIN_HEIGHT, maxHeight);
        size.current = { ...size.current, height: newHeight };
      } else if (r.edge === "bottom-right") {
        // Left+top edges fixed; right+bottom edges follow cursor
        // Right must stay ≤ viewport right - EDGE_BUFFER; bottom ≤ viewport bottom - EDGE_BUFFER
        const maxWidth  = Math.min(MAX_WIDTH,  window.innerWidth  - EDGE_BUFFER - r.fixedLeft);
        const maxHeight = Math.min(MAX_HEIGHT, window.innerHeight - EDGE_BUFFER - r.fixedTop);
        const newWidth  = clamp(e.clientX - r.fixedLeft, MIN_WIDTH,  maxWidth);
        const newHeight = clamp(e.clientY - r.fixedTop,  MIN_HEIGHT, maxHeight);
        size.current = { width: newWidth, height: newHeight };
        position.current = {
          right:  Math.max(EDGE_BUFFER, window.innerWidth  - r.fixedLeft - newWidth),
          bottom: Math.max(EDGE_BUFFER, window.innerHeight - r.fixedTop  - newHeight),
        };
      }

      forceRender(n => n + 1);
    };

    const onMouseUp = () => {
      dragOrigin.current   = null;
      resizeOrigin.current = null;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ── Send ───────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isLoading) return;
    setInputText("");
    sendMessage(text, context);
  }, [inputText, isLoading, sendMessage, context]);

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
      sendMessage(prompt, context);
    },
    [sendMessage, context],
  );

  const isNotConfigured = agentSettings !== null && !agentSettings.configured;

  const modal = (
    <div
      className={`${S.floatingModal} ${isMinimized ? S.floatingModalMinimized : ""}`}
      style={{
        right: position.current.right,
        bottom: position.current.bottom,
        width: size.current.width,
        height: isMinimized ? undefined : size.current.height,
      }}
    >
      {/* ── Resize handles (hidden when minimized) ──── */}
      {!isMinimized && (
        <>
          <div
            className={`${S.resizeHandle} ${S.resizeHandleLeft}`}
            onMouseDown={handleResizeMouseDown("left")}
          />
          <div
            className={`${S.resizeHandle} ${S.resizeHandleTop}`}
            onMouseDown={handleResizeMouseDown("top")}
          />
          <div
            className={`${S.resizeHandle} ${S.resizeHandleBottomRight}`}
            onMouseDown={handleResizeMouseDown("bottom-right")}
          />
        </>
      )}

      {/* ── Header ─────────────────────────────────── */}
      <div className={S.modalHeader} onMouseDown={handleHeaderMouseDown}>
        <div className={S.modalHeaderTitle}>
          <Icon name="ai" size={18} color="rgba(255,255,255,0.9)" />
          <Text size="sm" fw={600} c="white">
            {t`AI Agent`}
          </Text>
          {agentSettings && (
            <Text size="xs" c="rgba(255,255,255,0.65)">
              {agentSettings.model}
            </Text>
          )}
        </div>

        <div className={S.modalHeaderActions}>
          {!isMinimized && messages.length > 0 && (
            <Tooltip label={t`Clear conversation`}>
              <ActionIcon
                variant="subtle"
                c="rgba(255,255,255,0.8)"
                size="sm"
                onClick={clearMessages}
                aria-label={t`Clear conversation`}
              >
                <Icon name="trash" size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={isMinimized ? t`Expand` : t`Minimize`}>
            <ActionIcon
              variant="subtle"
              c="rgba(255,255,255,0.8)"
              size="sm"
              onClick={toggleMinimized}
              aria-label={isMinimized ? t`Expand` : t`Minimize`}
            >
              <Icon name={isMinimized ? "chevronup" : "chevrondown"} size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t`Close`}>
            <ActionIcon
              variant="subtle"
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
              <Icon name="gear_settings_filled" size={32} color="var(--mb-color-text-light)" />
              <Text size="sm" c="text-medium" ta="center" fw={500}>
                {t`AI Agent is not configured`}
              </Text>
              <Text size="xs" c="text-light" ta="center">
                {t`Set the OpenAI API key in`}{" "}
                <Anchor href="/admin/settings/ai-agent" size="xs">
                  {t`Admin › Settings › AI Agent`}
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
                    <Text size="xs" c="text-light" className={S.inputHint}>
                      {t`Enter to send · Shift+Enter for new line`}
                    </Text>
                    <ActionIcon
                      variant="filled"
                      color="brand"
                      size="sm"
                      radius="xl"
                      onClick={handleSend}
                      disabled={isLoading || !inputText.trim()}
                      aria-label={t`Send message`}
                    >
                      <Icon name="send" size={13} />
                    </ActionIcon>
                  </div>
                </div>
              </div>

              {/* ── Context picker ──────────────────── */}
              <AgentContextPicker value={context} onChange={handleContextChange} />
            </>
          )}
        </>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
