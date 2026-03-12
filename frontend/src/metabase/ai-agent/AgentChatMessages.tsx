import { useEffect, useRef, useState } from "react";
import { t } from "ttag";

import Markdown from "metabase/common/components/Markdown";
import {
  Anchor,
  Code,
  Flex,
  Group,
  Icon,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "metabase/ui";

import S from "./AgentModal.module.css";
import type { ChatMessage, ContentBlock } from "./types";

const EXAMPLE_PROMPTS = [
  t`Show total orders per day for the last 30 days`,
  t`List all databases I have access to`,
  t`Find dashboards related to revenue`,
  t`Create a question showing monthly active users`,
];

/* ── Block renderers ─────────────────────────────────────────────────────── */

function CardLinkBlock({ block }: { block: Extract<ContentBlock, { type: "card_link" }> }) {
  return (
    <Anchor
      href={`/question/${block.card_id}`}
      className={S.blockLink}
      underline="never"
    >
      <Group gap={8} wrap="nowrap">
        <Icon name="table2" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </Anchor>
  );
}

function DashboardLinkBlock({ block }: { block: Extract<ContentBlock, { type: "dashboard_link" }> }) {
  return (
    <Anchor
      href={`/dashboard/${block.dashboard_id}`}
      className={S.blockLink}
      underline="never"
    >
      <Group gap={8} wrap="nowrap">
        <Icon name="dashboard" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </Anchor>
  );
}

function SqlBlock({ block }: { block: Extract<ContentBlock, { type: "sql" }> }) {
  return (
    <Code className={S.sqlBlock} block>
      {block.content}
    </Code>
  );
}

function TableBlock({ block }: { block: Extract<ContentBlock, { type: "table" }> }) {
  const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|");
  const header = `| ${block.columns.map(esc).join(" | ")} |`;
  const divider = `| ${block.columns.map(() => "---").join(" | ")} |`;
  const rows = block.rows
    .map(r => `| ${r.map(esc).join(" | ")} |`)
    .join("\n");
  return <Markdown>{`${header}\n${divider}\n${rows}`}</Markdown>;
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <Markdown>{block.content}</Markdown>;
    case "card_link":
      return <CardLinkBlock block={block} />;
    case "dashboard_link":
      return <DashboardLinkBlock block={block} />;
    case "sql":
      return <SqlBlock block={block} />;
    case "table":
      return <TableBlock block={block} />;
    default:
      return null;
  }
}

/* ── Tool call message ───────────────────────────────────────────────────── */

function ToolCallMessage({ message }: { message: ChatMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isError = message.toolStatus === "error";
  const toolLabel =
    message.toolName
      ?.replace(/_/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase()) ?? "Tool";

  return (
    <Paper
      className={S.toolMessage}
      withBorder
      radius="sm"
      p={0}
    >
      <Group
        className={S.toolHeader}
        gap={6}
        px={10}
        pt={6}
        pb={message.toolResult ? 2 : 6}
        style={message.toolResult ? { cursor: "pointer" } : undefined}
        onClick={message.toolResult ? () => setIsExpanded((v: boolean) => !v) : undefined}
      >
        <Icon
          name={isError ? "warning" : "check"}
          size={12}
          color={isError ? "var(--mb-color-error)" : "var(--mb-color-success)"}
        />
        <Text size="xs" c="text-medium" fs="italic" style={{ flex: 1 }}>
          {toolLabel}
        </Text>
        {message.toolResult && (
          <Icon
            name={isExpanded ? "chevronup" : "chevrondown"}
            size={10}
            color="var(--mb-color-text-light)"
          />
        )}
      </Group>
      {message.toolResult && isExpanded && (
        <Code className={S.toolResult} block>
          {message.toolResult}
        </Code>
      )}
    </Paper>
  );
}

/* ── Message bubble ──────────────────────────────────────────────────────── */

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") {
    return <ToolCallMessage message={message} />;
  }

  // Skip the optimistic placeholder added while waiting for the server response
  if (message.content === null && !message.blocks) {
    return null;
  }

  const isUser = message.role === "user";

  if (isUser) {
    return (
      <Flex className={S.messageBubbleRow} justify="flex-end">
        <Paper className={S.userBubble} radius="xl">
          <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {message.content}
          </Text>
        </Paper>
      </Flex>
    );
  }

  // Assistant message — structured blocks or plain markdown fallback
  if (message.blocks && message.blocks.length > 0) {
    return (
      <Flex className={S.messageBubbleRow} justify="flex-start">
        <Paper className={S.assistantBubble} radius="xl">
          <Stack gap={8}>
            {message.blocks.map((block, idx) => (
              <ContentBlockRenderer key={idx} block={block} />
            ))}
          </Stack>
        </Paper>
      </Flex>
    );
  }

  return (
    <Flex className={S.messageBubbleRow} justify="flex-start">
      <Paper className={S.assistantBubble} radius="xl">
        <Markdown>{message.content ?? ""}</Markdown>
      </Paper>
    </Flex>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

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
      <Stack className={S.emptyState} align="center" justify="center" gap="sm">
        <Icon name="ai" size={32} color="var(--mb-color-brand)" />
        <Text size="sm" c="text-medium" ta="center" fw={500}>
          {t`What would you like to explore?`}
        </Text>
        {onSelectPrompt && (
          <Stack className={S.promptChips} gap={6} w="100%">
            {EXAMPLE_PROMPTS.map(p => (
              <UnstyledButton
                key={p}
                className={S.promptChip}
                onClick={() => onSelectPrompt(p)}
              >
                {p}
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <ScrollArea
      className={S.messagesScroll}
      viewportRef={viewportRef}
      scrollbarSize={6}
    >
      <Stack className={S.messagesInner} gap={4} p="12px 16px">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {isLoading && (
          <Flex justify="flex-start" className={S.messageBubbleRow}>
            <Paper className={S.loadingBubble} radius="xl">
              <Loader size="xs" />
            </Paper>
          </Flex>
        )}
      </Stack>
    </ScrollArea>
  );
}
