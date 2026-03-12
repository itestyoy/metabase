import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Box, Text } from "metabase/ui";

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

  // Dragging state
  const modalRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    initialRight: number;
    initialBottom: number;
  }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    initialRight: 24,
    initialBottom: 80,
  });
  const [position, setPosition] = useState({ right: 24, bottom: 80 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isMinimized) {
        return;
      }
      dragState.current = {
        isDragging: true,
        startX: e.clientX,
        startY: e.clientY,
        initialRight: position.right,
        initialBottom: position.bottom,
      };
    },
    [isMinimized, position],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds.isDragging) {
        return;
      }
      const deltaX = e.clientX - ds.startX;
      const deltaY = e.clientY - ds.startY;
      setPosition({
        right: Math.max(0, ds.initialRight - deltaX),
        bottom: Math.max(0, ds.initialBottom - deltaY),
      });
    };
    const handleMouseUp = () => {
      dragState.current.isDragging = false;
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isLoading) {
      return;
    }
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

  // Show settings if no API key configured
  const effectiveShowSettings =
    showSettings || !settings.openaiApiKey;

  const modalContent = (
    <div
      ref={modalRef}
      className={`${S.floatingModal} ${isMinimized ? S.floatingModalMinimized : ""}`}
      style={{ right: position.right, bottom: position.bottom }}
    >
      {/* Header */}
      <div className={S.modalHeader} onMouseDown={handleMouseDown}>
        <div className={S.modalHeaderTitle}>
          <span>🤖</span>
          <Text size="sm" fw={600} c="white">
            AI Agent
          </Text>
        </div>
        <div className={S.modalHeaderActions}>
          {!isMinimized && (
            <>
              <button
                className={S.headerIconBtn}
                onClick={clearMessages}
                title="Clear conversation"
              >
                🗑
              </button>
              <button
                className={S.headerIconBtn}
                onClick={() => setShowSettings(s => !s)}
                title="Settings"
              >
                ⚙️
              </button>
            </>
          )}
          <button
            className={S.headerIconBtn}
            onClick={() => setIsMinimized(m => !m)}
            title={isMinimized ? "Expand" : "Minimize"}
          >
            {isMinimized ? "▲" : "▼"}
          </button>
          <button
            className={S.headerIconBtn}
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
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
                <Box className={S.errorBanner}>
                  <Text size="xs">{error}</Text>
                </Box>
              )}

              <div className={S.inputArea}>
                <div className={S.inputRow}>
                  <textarea
                    className={S.textInput}
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask me to create a question, explore data..."
                    rows={1}
                    disabled={isLoading}
                  />
                  <button
                    className={S.sendBtn}
                    onClick={handleSend}
                    disabled={isLoading || !inputText.trim()}
                  >
                    ↑
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );

  return createPortal(modalContent, document.body);
}
