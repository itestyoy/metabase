import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { ActionIcon, Flex, Icon, Text, Textarea, Tooltip } from "metabase/ui";

import { AgentChatMessages } from "./AgentChatMessages";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { useAgentChat } from "./hooks/useAgentChat";
import S from "./AgentModal.module.css";

interface AgentModalProps {
  onClose: () => void;
}

export function AgentModal({ onClose }: AgentModalProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [inputText, setInputText] = useState("");

  const {
    messages,
    isLoading,
    error,
    settings,
    updateSettings,
    sendMessage,
    clearMessages,
  } = useAgentChat();

  // ── Drag logic ─────────────────────────────────────────────────────────
  const position = useRef({ right: 24, bottom: 80 });
  const dragOrigin = useRef<{
    mouseX: number;
    mouseY: number;
    right: number;
    bottom: number;
  } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // trigger re-render after drag
  const [, forceRender] = useState(0);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isMinimized) return;
      dragOrigin.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        right: position.current.right,
        bottom: position.current.bottom,
      };
    },
    [isMinimized],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const o = dragOrigin.current;
      if (!o) return;
      position.current = {
        right: Math.max(0, o.right - (e.clientX - o.mouseX)),
        bottom: Math.max(0, o.bottom - (e.clientY - o.mouseY)),
      };
      forceRender(n => n + 1);
    };
    const onMouseUp = () => {
      dragOrigin.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ── Send message ───────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isLoading) return;
    setInputText("");
    sendMessage(text);
  }, [inputText, isLoading, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Show settings if no API key yet
  const effectiveShowSettings = showSettings || !settings.openaiApiKey;

  const modal = (
    <div
      ref={modalRef}
      className={`${S.floatingModal} ${isMinimized ? S.floatingModalMinimized : ""}`}
      style={{
        right: position.current.right,
        bottom: position.current.bottom,
      }}
    >
      {/* ── Header ─────────────────────────────────── */}
      <div className={S.modalHeader} onMouseDown={handleHeaderMouseDown}>
        <div className={S.modalHeaderTitle}>
          <Icon name="ai" size={18} color="rgba(255,255,255,0.9)" />
          <Text size="sm" fw={600} c="white">
            {t`AI Agent`}
          </Text>
        </div>

        <div className={S.modalHeaderActions}>
          {!isMinimized && (
            <>
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
              <Tooltip label={t`Settings`}>
                <ActionIcon
                  variant="subtle"
                  c="rgba(255,255,255,0.8)"
                  size="sm"
                  onClick={() => setShowSettings(s => !s)}
                  aria-label={t`Settings`}
                >
                  <Icon name="gear" size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
          <Tooltip label={isMinimized ? t`Expand` : t`Minimize`}>
            <ActionIcon
              variant="subtle"
              c="rgba(255,255,255,0.8)"
              size="sm"
              onClick={() => setIsMinimized(m => !m)}
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
          {effectiveShowSettings ? (
            <AgentSettingsForm
              settings={settings}
              onSave={updateSettings}
              onBack={() => setShowSettings(false)}
            />
          ) : (
            <>
              <AgentChatMessages messages={messages} isLoading={isLoading} />

              {error && (
                <div className={S.errorBanner}>
                  <Text size="xs" c="error">
                    {error}
                  </Text>
                </div>
              )}

              <div className={S.inputArea}>
                <Flex gap="xs" align="flex-end">
                  <div className={S.textareaWrapper}>
                    <Textarea
                      value={inputText}
                      onChange={e => setInputText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t`Ask me to create a question, explore data…`}
                      minRows={1}
                      maxRows={4}
                      autosize
                      disabled={isLoading}
                      size="sm"
                      styles={{
                        input: { borderRadius: 8, resize: "none" },
                      }}
                    />
                  </div>
                  <Tooltip label={t`Send (Enter)`}>
                    <ActionIcon
                      variant="filled"
                      color="brand"
                      size="lg"
                      onClick={handleSend}
                      disabled={isLoading || !inputText.trim()}
                      aria-label={t`Send message`}
                      style={{ flexShrink: 0, marginBottom: 1 }}
                    >
                      <Icon name="send" size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Flex>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
