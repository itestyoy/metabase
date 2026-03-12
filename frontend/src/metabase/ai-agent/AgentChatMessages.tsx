import { useEffect, useRef } from "react";
import { t } from "ttag";

import Markdown from "metabase/common/components/Markdown";
import { Icon, Loader, ScrollArea, Text } from "metabase/ui";

import S from "./AgentModal.module.css";
import type { ChatMessage } from "./types";

const EXAMPLE_PROMPTS = [
  t`Show total orders per day for the last 30 days`,
  t`List all databases I have access to`,
  t`Find dashboards related to revenue`,
  t`Create a question showing monthly active users`,
];

function ToolCallMessage({ message }: { message: ChatMessage }) {
  const isError = message.toolStatus === "error";
  const toolLabel =
    message.toolName
      ?.replace(/_/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase()) ?? "Tool";

  return (
    <div className={S.toolMessage}>
      <div className={S.toolHeader}>
        <Icon
          name={isError ? "warning" : "check"}
          size={12}
          color={isError ? "var(--mb-color-error)" : "var(--mb-color-success)"}
        />
        <Text size="xs" c="text-medium" fs="italic">
          {toolLabel}
        </Text>
      </div>
      {message.toolResult && (
        <div className={S.toolResult}>
          {message.toolResult.length > 200
            ? message.toolResult.slice(0, 200) + "…"
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
  onSelectPrompt?: (prompt: string) => void;
}

export function AgentChatMessages({
  messages,
  isLoading,
  onSelectPrompt,
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
        <Icon name="ai" size={32} color="var(--mb-color-brand)" />
        <Text size="sm" c="text-medium" ta="center" fw={500}>
          {t`What would you like to explore?`}
        </Text>
        {onSelectPrompt && (
          <div className={S.promptChips}>
            {EXAMPLE_PROMPTS.map(p => (
              <button
                key={p}
                className={S.promptChip}
                onClick={() => onSelectPrompt(p)}
                type="button"
              >
                {p}
              </button>
            ))}
          </div>
        )}
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
          <div
            className={`${S.messageBubbleRow} ${S.messageBubbleRowAssistant}`}
          >
            <div className={S.loadingBubble}>
              <Loader size="xs" />
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
