import { useEffect, useRef } from "react";

import { Box, Flex, Loader, Text } from "metabase/ui";

import type { ChatMessage } from "./types";
import S from "./AgentModal.module.css";

interface AgentChatMessagesProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

function ToolCallMessage({ message }: { message: ChatMessage }) {
  const icon =
    message.toolStatus === "running"
      ? "⏳"
      : message.toolStatus === "error"
        ? "❌"
        : "✅";

  const toolLabel =
    message.toolName?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) ??
    "Tool";

  return (
    <Flex align="flex-start" gap="xs" className={S.toolMessage}>
      <Text size="sm" c="dimmed">
        {icon} <em>{toolLabel}</em>
        {message.toolStatus === "running" && (
          <Loader size="xs" ml="xs" display="inline-block" />
        )}
      </Text>
      {message.toolStatus !== "running" && message.toolResult && (
        <Box className={S.toolResult}>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
            {message.toolResult.length > 400
              ? message.toolResult.slice(0, 400) + "…"
              : message.toolResult}
          </Text>
        </Box>
      )}
    </Flex>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") {
    return <ToolCallMessage message={message} />;
  }

  const isUser = message.role === "user";

  return (
    <Flex
      justify={isUser ? "flex-end" : "flex-start"}
      mb="xs"
    >
      <Box className={isUser ? S.userBubble : S.assistantBubble}>
        <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {message.content}
        </Text>
      </Box>
    </Flex>
  );
}

export function AgentChatMessages({
  messages,
  isLoading,
}: AgentChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <Flex
        flex="1"
        align="center"
        justify="center"
        direction="column"
        gap="sm"
        p="lg"
        className={S.emptyState}
      >
        <Text size="xl">🤖</Text>
        <Text size="sm" c="dimmed" ta="center">
          Ask me to create questions, explore your data, or search for existing
          reports.
        </Text>
        <Text size="xs" c="dimmed" ta="center">
          Example: "Create a question showing total orders per day for the last
          30 days"
        </Text>
      </Flex>
    );
  }

  return (
    <Box className={S.messagesContainer}>
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isLoading && (
        <Flex justify="flex-start" mb="xs">
          <Box className={S.assistantBubble}>
            <Loader size="xs" />
          </Box>
        </Flex>
      )}
      <div ref={bottomRef} />
    </Box>
  );
}
