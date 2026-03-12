import { useEffect, useRef } from "react";
import { t } from "ttag";

import Markdown from "metabase/common/components/Markdown";
import { Box, Flex, Icon, Loader, ScrollArea, Text } from "metabase/ui";

import S from "./AgentModal.module.css";
import type { ChatMessage } from "./types";

function ToolCallMessage({ message }: { message: ChatMessage }) {
  const isRunning = message.toolStatus === "running";
  const isError = message.toolStatus === "error";
  const toolLabel =
    message.toolName
      ?.replace(/_/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase()) ?? "Tool";

  return (
    <div className={S.toolMessage}>
      <div className={S.toolHeader}>
        {isRunning ? (
          <Loader size={12} />
        ) : (
          <Icon
            name={isError ? "warning" : "check"}
            size={12}
            color={
              isError
                ? "var(--mb-color-error)"
                : "var(--mb-color-success)"
            }
          />
        )}
        <Text size="xs" c="text-medium" fs="italic">
          {toolLabel}
        </Text>
      </div>
      {!isRunning && message.toolResult && (
        <div className={S.toolResult}>
          {message.toolResult.length > 300
            ? message.toolResult.slice(0, 300) + "…"
            : message.toolResult}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") {
    return <ToolCallMessage message={message} />;
  }

  const isUser = message.role === "user";

  return (
    <div
      className={`${S.messageBubbleRow} ${isUser ? S.messageBubbleRowUser : S.messageBubbleRowAssistant}`}
    >
      {isUser ? (
        <div className={S.userBubble}>{message.content}</div>
      ) : (
        <div className={S.assistantBubble}>
          <Markdown>{message.content ?? ""}</Markdown>
        </div>
      )}
    </div>
  );
}

interface AgentChatMessagesProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

export function AgentChatMessages({
  messages,
  isLoading,
}: AgentChatMessagesProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, isLoading]);

  if (messages.length === 0) {
    return (
      <div className={S.emptyState}>
        <Icon name="ai" size={32} color="var(--mb-color-text-light)" />
        <Text size="sm" c="text-medium" ta="center">
          {t`Ask me to create questions, explore your data, or search for existing reports.`}
        </Text>
        <Text size="xs" c="text-light" ta="center">
          {t`Example: "Create a question showing total orders per day for the last 30 days"`}
        </Text>
      </div>
    );
  }

  return (
    <ScrollArea
      className={S.messagesScroll}
      viewportRef={viewportRef}
      scrollbarSize={6}
    >
      <div className={S.messagesInner}>
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {isLoading && (
          <div className={`${S.messageBubbleRow} ${S.messageBubbleRowAssistant}`}>
            <div className={S.loadingBubble}>
              <Loader size="xs" />
            </div>
          </div>
        )}
        {/* sentinel for auto-scroll via scrollTo */}
      </div>
    </ScrollArea>
  );
}
