import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { t } from "ttag";

import { skipToken, useGetCardQuery, useGetCardQueryQuery } from "metabase/api";
import Markdown from "metabase/common/components/Markdown";
import { DataGrid, useDataGridInstance } from "metabase/data-grid";
import type { ColumnOptions } from "metabase/data-grid";
import { serializeCardForUrl } from "metabase/lib/card";
import { useSelector } from "metabase/lib/redux";
import { getMetadata } from "metabase/selectors/metadata";
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
import Visualization from "metabase/visualizations/components/Visualization";

import S from "./AgentModal.module.css";
import type { ChatMessage, ContentBlock } from "./types";

const EXAMPLE_PROMPTS = [
  t`Investigate why revenue dropped last week`,
  t`Create a dashboard with key sales metrics`,
  t`Build a report on monthly active users`,
  t`Find all questions related to orders`,
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

function CardPreviewVisualization({ cardId }: { cardId: number }) {
  const { data: card, isLoading: isLoadingCard } = useGetCardQuery({ id: cardId });
  const { data: dataset, isLoading: isLoadingDataset } = useGetCardQueryQuery(
    card ? { cardId } : skipToken,
  );
  const metadata = useSelector(getMetadata);

  if (isLoadingCard || isLoadingDataset) {
    return (
      <Flex align="center" justify="center" h={160}>
        <Loader size="sm" />
      </Flex>
    );
  }

  if (!card || !dataset?.data) {
    return (
      <Flex align="center" justify="center" h={160}>
        <Text size="xs" c="text-tertiary">{t`Could not load preview`}</Text>
      </Flex>
    );
  }

  const series = [{ card, data: dataset.data, started_at: dataset.started_at }];

  return (
    <Box h={200} style={{ pointerEvents: "none" }}>
      <Visualization
        rawSeries={series}
        metadata={metadata}
        isDashboard={false}
        isQueryBuilder={false}
        showTitle={false}
      />
    </Box>
  );
}

function CardPreviewBlock({ block }: { block: Extract<ContentBlock, { type: "card_preview" }> }) {
  const [showPreview, setShowPreview] = useState(false);
  const displayIcon = block.display === "line" || block.display === "area"
    ? "line"
    : block.display === "bar" || block.display === "row"
      ? "bar"
      : block.display === "pie"
        ? "pie"
        : "table2";

  return (
    <Box>
      <Group gap={0} wrap="nowrap" className={S.cardPreviewRow}>
        <Link to={`/question/${block.card_id}`} className={S.blockLink} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8} wrap="nowrap">
            <Icon name={displayIcon} size={16} color="var(--mb-color-brand)" />
            <Text size="sm" fw={500} truncate>
              {block.name}
            </Text>
          </Group>
        </Link>
        <Tooltip label={showPreview ? t`Hide preview` : t`Preview`}>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => setShowPreview(v => !v)}
            aria-label={showPreview ? t`Hide preview` : t`Preview`}
            className={S.previewButton}
          >
            <Icon
              name={showPreview ? "chevronup" : "eye_outline"}
              size={14}
              color={showPreview ? "var(--mb-color-brand)" : "var(--mb-color-text-tertiary)"}
            />
          </ActionIcon>
        </Tooltip>
      </Group>
      {showPreview && (
        <Box className={S.cardPreviewFrame}>
          <CardPreviewVisualization cardId={block.card_id} />
        </Box>
      )}
    </Box>
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

function DocumentLinkBlock({ block }: { block: Extract<ContentBlock, { type: "document_link" }> }) {
  return (
    <Link to={`/document/${block.document_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="document" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </Link>
  );
}

function NotebookLinkBlock({ block }: { block: Extract<ContentBlock, { type: "notebook_link" }> }) {
  const notebookUrl = useMemo(() => {
    const card = {
      name: block.name,
      display: block.display || "table",
      visualization_settings: {},
      dataset_query: block.dataset_query,
    };
    return `/question/notebook#${serializeCardForUrl(card)}`;
  }, [block.name, block.display, block.dataset_query]);

  const displayIcon = block.display === "line" || block.display === "area"
    ? "line"
    : block.display === "bar" || block.display === "row"
      ? "bar"
      : block.display === "pie"
        ? "pie"
        : "table2";

  return (
    <Link to={notebookUrl} className={S.blockLink}>
      <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Icon name={displayIcon} size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
      <Group gap={4} wrap="nowrap" style={{ flexShrink: 0, marginLeft: "auto" }}>
        <Icon name="notebook" size={12} color="var(--mb-color-text-tertiary)" />
        <Text size="xs" c="text-tertiary">
          {t`Open in notebook`}
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

/** Detect the dominant type of a column from its values. */
function detectColumnType(rows: unknown[][], ci: number): "number" | "date" | "text" {
  let numCount = 0;
  let dateCount = 0;
  let total = 0;
  for (const row of rows) {
    const v = row[ci];
    if (v == null || v === "") continue;
    total++;
    if (typeof v === "number") { numCount++; continue; }
    const s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s)) { numCount++; continue; }
    // ISO date patterns: 2024-01-15, 2024-01-15T10:30:00, etc.
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { dateCount++; continue; }
  }
  if (total === 0) return "text";
  if (numCount / total > 0.7) return "number";
  if (dateCount / total > 0.7) return "date";
  return "text";
}

/** Format a cell value based on detected column type. */
function formatCell(value: unknown, colType: "number" | "date" | "text"): string {
  if (value == null) return "—";
  if (colType === "number") {
    const n = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(n)) return String(value);
    // Integers stay as-is; floats get up to 2 decimal places
    if (Number.isInteger(n)) return n.toLocaleString("en-US");
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (colType === "date") {
    const s = String(value);
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      // Date only (no time component or midnight)
      if (s.length <= 10 || /T00:00:00/.test(s)) {
        return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      }
      // Date + time
      return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
        + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return s;
    }
  }
  return String(value);
}

type RowRecord = Record<string, unknown>;

function TableBlock({ block }: { block: Extract<ContentBlock, { type: "table" }> }) {
  const colTypes = useMemo(
    () => block.columns.map((_, ci) => detectColumnType(block.rows, ci)),
    [block.columns, block.rows],
  );

  const data: RowRecord[] = useMemo(
    () => block.rows.map(row => {
      const obj: RowRecord = {};
      block.columns.forEach((col, ci) => { obj[col] = row[ci]; });
      return obj;
    }),
    [block.columns, block.rows],
  );

  const columnsOptions: ColumnOptions<RowRecord>[] = useMemo(
    () => block.columns.map((col, ci) => ({
      id: col,
      name: col,
      accessorFn: (row: RowRecord) => row[col],
      align: colTypes[ci] === "number" ? "right" as const : undefined,
      formatter: (value: unknown) => formatCell(value, colTypes[ci]),
    })),
    [block.columns, colTypes],
  );

  const gridInstance = useDataGridInstance({
    data,
    columnsOptions,
    rowId: { variant: "indexExpand", expandedIndex: undefined },
  });

  if (block.rows.length === 0) {
    return (
      <Flex align="center" justify="center" gap={8} p="md" className={S.tableEmpty}>
        <Icon name="table2" size={16} color="var(--mb-color-text-tertiary)" />
        <Text size="xs" c="text-tertiary">{t`No results`}</Text>
      </Flex>
    );
  }

  return (
    <Box className={S.tableWrapper}>
      <DataGrid
        {...gridInstance}
        showRowsCount
        rowsTruncated={block.rows.length > 50 ? block.rows.length - 50 : undefined}
      />
    </Box>
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
    case "card_preview":
      return <CardPreviewBlock block={block} />;
    case "dashboard_link":
      return <DashboardLinkBlock block={block} />;
    case "document_link":
      return <DocumentLinkBlock block={block} />;
    case "notebook_link":
      return <NotebookLinkBlock block={block} />;
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
          <Markdown className={S.userMarkdown}>{message.content ?? ""}</Markdown>
        </Paper>
      </Flex>
    );
  }

  // Assistant message — structured blocks or plain markdown fallback
  if (message.blocks && message.blocks.length > 0) {
    const hasRichBlock = message.blocks.some(
      b => b.type !== "text",
    );
    return (
      <Flex className={S.messageBubbleRow} justify="flex-start">
        <Paper className={`${S.assistantBubble} ${hasRichBlock ? S.assistantBubbleWide : ""}`} radius="xl">
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
