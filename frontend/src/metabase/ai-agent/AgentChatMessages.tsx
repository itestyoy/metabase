import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { t } from "ttag";

import Markdown from "metabase/common/components/Markdown";
import { Table, type BaseRow } from "metabase/common/components/Table";
import {
  ActionIcon,
  Box,
  Code,
  Flex,
  Group,
  Icon,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "metabase/ui";

import S from "./AgentModal.module.css";
import type { ChatMessage, ContentBlock } from "./types";

const EXAMPLE_PROMPTS = [
  t`List all tables I have access to`,
  t`Find dashboards related to revenue`,
  t`Create a question showing monthly active users`,
];

/* ── Block renderers ─────────────────────────────────────────────────────── */

function CardLinkBlock({ block }: { block: Extract<ContentBlock, { type: "card_link" }> }) {
  return (
    <Link to={`/question/${block.card_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="table2" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </Link>
  );
}

function DashboardLinkBlock({ block }: { block: Extract<ContentBlock, { type: "dashboard_link" }> }) {
  return (
    <Link to={`/dashboard/${block.dashboard_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="dashboard" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </Link>
  );
}

function SqlBlock({
  block,
  onSaveAsQuestion,
}: {
  block: Extract<ContentBlock, { type: "sql" }>;
  onSaveAsQuestion?: (sql: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(block.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [block.content]);

  return (
    <Box className={S.sqlBlockWrapper}>
      <Group className={S.sqlBlockActions} gap={2}>
        <Tooltip label={copied ? t`Copied!` : t`Copy SQL`}>
          <ActionIcon
            variant="subtle"
            size="xs"
            onClick={handleCopy}
            aria-label={t`Copy SQL`}
          >
            <Icon
              name={copied ? "check" : "copy"}
              size={12}
              color={copied ? "var(--mb-color-success)" : "var(--mb-color-text-tertiary)"}
            />
          </ActionIcon>
        </Tooltip>
        {onSaveAsQuestion && (
          <Tooltip label={t`Save as question`}>
            <ActionIcon
              variant="subtle"
              size="xs"
              onClick={() => onSaveAsQuestion(block.content)}
              aria-label={t`Save as question`}
            >
              <Icon name="add" size={12} color="var(--mb-color-text-tertiary)" />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Code className={S.sqlBlock} block>
        {block.content}
      </Code>
    </Box>
  );
}

function TableBlock({ block }: { block: Extract<ContentBlock, { type: "table" }> }) {
  const columns = block.columns.map(col => ({ name: col, key: col }));
  const rows: BaseRow[] = block.rows.map((row, ri) => {
    const obj: Record<string, unknown> = { id: ri };
    block.columns.forEach((col, ci) => {
      obj[col] = row[ci];
    });
    return obj as BaseRow;
  });

  return (
    <Table
      className={S.agentTable}
      columns={columns}
      rows={rows}
      rowRenderer={(row: BaseRow) => (
        <Box component="tr" key={row.id}>
          {block.columns.map(col => (
            <Box component="td" key={col}>
              <Text size="xs">{row[col] == null ? "" : String(row[col])}</Text>
            </Box>
          ))}
        </Box>
      )}
    />
  );
}

function ContentBlockRenderer({
  block,
  onSaveAsQuestion,
}: {
  block: ContentBlock;
  onSaveAsQuestion?: (sql: string) => void;
}) {
  switch (block.type) {
    case "text":
      return <Markdown>{block.content}</Markdown>;
    case "card_link":
      return <CardLinkBlock block={block} />;
    case "dashboard_link":
      return <DashboardLinkBlock block={block} />;
    case "sql":
      return <SqlBlock block={block} onSaveAsQuestion={onSaveAsQuestion} />;
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
        py={6}
        align="center"
        style={message.toolResult ? { cursor: "pointer" } : undefined}
        onClick={message.toolResult ? () => setIsExpanded((v: boolean) => !v) : undefined}
      >
        <Icon
          name={isError ? "warning" : "check"}
          size={12}
          color={isError ? "var(--mb-color-error)" : "var(--mb-color-success)"}
        />
        <Text size="xs" c="text-secondary" fs="italic" style={{ flex: 1 }}>
          {toolLabel}
        </Text>
        {message.toolResult && (
          <Icon
            name={isExpanded ? "chevronup" : "chevrondown"}
            size={10}
            color="var(--mb-color-text-tertiary)"
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

function MessageBubble({
  message,
  onSaveAsQuestion,
}: {
  message: ChatMessage;
  onSaveAsQuestion?: (sql: string) => void;
}) {
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
              <ContentBlockRenderer
                key={idx}
                block={block}
                onSaveAsQuestion={onSaveAsQuestion}
              />
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
  onSaveAsQuestion?: (sql: string) => void;
}

export function AgentChatMessages({
  messages,
  isLoading,
  onSelectPrompt,
  onSaveAsQuestion,
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
        <Text size="sm" c="text-secondary" ta="center" fw={500}>
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

  // Get suggestions from the last assistant message
  const lastMsg = messages[messages.length - 1];
  const suggestions =
    !isLoading && lastMsg?.role === "assistant" && lastMsg.suggestions?.length
      ? lastMsg.suggestions
      : null;

  return (
    <ScrollArea
      className={S.messagesScroll}
      viewportRef={viewportRef}
      scrollbarSize={6}
    >
      <Stack className={S.messagesInner} gap={4} p="12px 16px">
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onSaveAsQuestion={onSaveAsQuestion}
          />
        ))}
        {isLoading && (
          <Flex justify="flex-start" className={S.messageBubbleRow}>
            <Paper className={S.loadingBubble} radius="xl">
              <Group gap={8} align="center" wrap="nowrap">
                <Loader size="xs" />
                <Text size="xs" c="text-tertiary" fs="italic">
                  {t`Thinking…`}
                </Text>
              </Group>
            </Paper>
          </Flex>
        )}
        {suggestions && onSelectPrompt && (
          <Flex gap={6} wrap="wrap" mt={4}>
            {suggestions.map(s => (
              <UnstyledButton
                key={s}
                className={S.suggestionChip}
                onClick={() => onSelectPrompt(s)}
              >
                {s}
              </UnstyledButton>
            ))}
          </Flex>
        )}
      </Stack>
    </ScrollArea>
  );
}
