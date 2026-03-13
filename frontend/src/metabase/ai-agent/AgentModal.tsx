import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { ActionIcon, Anchor, Icon, Stack, Text, Textarea, Tooltip } from "metabase/ui";

import { AgentChatMessages } from "./AgentChatMessages";
import type { AgentContextValue } from "./AgentContextPicker";
import { AgentContextPicker } from "./AgentContextPicker";
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

interface AgentModalProps {
  onClose: () => void;
}

export function AgentModal({ onClose }: AgentModalProps) {
  const { panelState, panelStyle, headerProps, resizeHandleProps, toggleMinimized } =
    useFloatingPanel(PANEL_CONSTRAINTS);

  const [inputText, setInputText] = useState("");
  const [context, setContext] = useState<AgentContextValue | null>(null);
  const isContextManual = useRef(false);

  const { messages, isLoading, error, agentSettings, sendMessage, clearMessages } =
    useAgentChat();

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

  const handleSaveAsQuestion = useCallback(
    (sql: string) => {
      setInputText("");
      sendMessage(
        `Save this SQL as a new question in my personal collection:\n\`\`\`sql\n${sql}\n\`\`\``,
        context,
      );
    },
    [sendMessage, context],
  );

  const { isMinimized, isInteracting } = panelState;
  const isNotConfigured = agentSettings !== null && !agentSettings.configured;

  const modalClassName = [
    S.floatingModal,
    isMinimized && S.floatingModalMinimized,
    isInteracting && S.floatingModalInteracting,
  ]
    .filter(Boolean)
    .join(" ");

  const modal = (
    <div className={modalClassName} style={panelStyle}>
      {/* ── Resize handles (hidden when minimized) ──── */}
      {!isMinimized && (
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
      <div className={S.modalHeader} {...headerProps}>
        <div className={S.modalHeaderTitle}>
          <Icon name="ai" size={18} c="white" />
          <Text size="sm" fw={600} c="white">
            {t`Chat with BI, supercharged by AI`}
          </Text>
        </div>

        <div className={S.modalHeaderActions}>
          {!isMinimized && messages.length > 0 && (
            <Tooltip label={t`Clear conversation`}>
              <ActionIcon
                variant="transparent"
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
              variant="transparent"
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
                {t`Chat with BI is not configured`}
              </Text>
              <Text size="xs" c="text-tertiary" ta="center">
                {t`Set the OpenAI API key in`}{" "}
                <Anchor href="/admin/settings/ai-agent" size="xs">
                  {t`Admin › Settings › Chat with BI`}
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
