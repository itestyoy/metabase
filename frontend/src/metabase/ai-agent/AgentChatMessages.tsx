import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { t } from "ttag";

import { skipToken, useGetCardQuery, useGetCardQueryQuery } from "metabase/api";
import { Markdown } from "metabase/common/components/Markdown";
import { DataGrid, useDataGridInstance } from "metabase/data-grid";
import type { ColumnOptions } from "metabase/data-grid";
import { serializeCardForUrl } from "metabase/lib/card";
import { useSelector } from "metabase/lib/redux";
import { getMetadata } from "metabase/selectors/metadata";
import {
  ActionIcon,
  Box,
  Button,
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


/**
 * A Link that forces a page refresh when navigating to the current URL.
 * React Router v3 ignores navigation to the same path, so we intercept
 * the click and use push(replace) trick to force remount.
 */
function ForceLink({
  to,
  className,
  style,
  children,
}: {
  to: string;
  className?: string;
  style?: Record<string, unknown>;
  children: ReactNode;
}) {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      const targetPath = to.split("#")[0].split("?")[0];
      const currentPath = window.location.pathname;
      if (targetPath === currentPath) {
        e.preventDefault();
        // Navigate away and back to force React Router to remount
        window.location.href = to;
      }
    },
    [to],
  );

  return (
    <Link to={to} className={className} style={style} onClick={handleClick}>
      {children}
    </Link>
  );
}

const DEFAULT_EXAMPLE_PROMPTS = [
  "What metrics do we have?",
  "Show revenue by month",
  "Find all ad revenue metrics",
];

/* ── Block renderers ─────────────────────────────────────────────────────── */

function CardLinkBlock({ block }: { block: Extract<ContentBlock, { type: "card_link" }> }) {
  return (
    <ForceLink to={`/question/${block.card_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="table2" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </ForceLink>
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
        <ForceLink to={`/question/${block.card_id}`} className={S.blockLink} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8} wrap="nowrap">
            <Icon name={displayIcon} size={16} color="var(--mb-color-brand)" />
            <Text size="sm" fw={500} truncate>
              {block.name}
            </Text>
          </Group>
        </ForceLink>
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
    <ForceLink to={`/dashboard/${block.dashboard_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="dashboard" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </ForceLink>
  );
}

function DocumentLinkBlock({ block }: { block: Extract<ContentBlock, { type: "document_link" }> }) {
  return (
    <ForceLink to={`/document/${block.document_id}`} className={S.blockLink}>
      <Group gap={8} wrap="nowrap">
        <Icon name="document" size={16} color="var(--mb-color-brand)" />
        <Text size="sm" fw={500} truncate>
          {block.name}
        </Text>
      </Group>
    </ForceLink>
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
    <ForceLink to={notebookUrl} className={S.blockLink}>
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
    </ForceLink>
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
      return <EntityAwareText content={block.content} />;
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

/* ── Tool call helpers ──────────────────────────────────────────────────── */

const TOOL_ICON_MAP: Record<string, string> = {
  run_query: "database",
  search_items: "search",
  list_databases: "database",
  get_database_schema: "database",
  get_table_details: "table2",
  list_questions: "question",
  execute_card: "play",
  create_question: "add",
  create_notebook_question: "notebook",
  create_dashboard: "dashboard",
  create_document: "document",
  get_document: "document",
  append_to_document: "document",
  list_metrics: "metric",
  get_metrics_guide: "metric",
  get_card_details: "question",
  get_dashboard_details: "dashboard",
};

function getToolIcon(toolName?: string): string {
  if (!toolName) return "gear";
  return TOOL_ICON_MAP[toolName] ?? "gear";
}

function formatToolName(toolName?: string): string {
  return toolName?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) ?? "Tool";
}

/* ── Single tool call row (used inside the group) ─────────────────────── */

function McpApprovalRow({ message, onDecision }: { message: ChatMessage; onDecision?: (responseId: string, decisions: { id: string; approve: boolean }[]) => void }) {
  const approval = message.mcpApproval;
  const [decided, setDecided] = useState(false);
  if (!approval) return null;

  const handleApprove = () => {
    setDecided(true);
    onDecision?.(approval.responseId, approval.tools.map(t => ({ id: t.id, approve: true })));
  };
  const handleDeny = () => {
    setDecided(true);
    onDecision?.(approval.responseId, approval.tools.map(t => ({ id: t.id, approve: false })));
  };

  return (
    <Box className={S.toolRow} p="xs">
      <Flex align="center" gap={6} mb={6}>
        <Icon name="lock" size={12} color="var(--mb-color-warning)" />
        <Text size="xs" fw={600} c="text-secondary">{t`MCP tool requires approval`}</Text>
      </Flex>
      {approval.tools.map(tool => (
        <Box key={tool.id} mb={4}>
          <Text size="xs" fw={500} c="text-primary">{tool.server_label}: {tool.name}</Text>
          {tool.arguments && (
            <Code block style={{ fontSize: 11, maxHeight: 80, overflow: "auto", marginTop: 2 }}>
              {tool.arguments}
            </Code>
          )}
        </Box>
      ))}
      {!decided ? (
        <Flex gap={6} mt={6}>
          <Button size="xs" color="green" onClick={handleApprove} leftSection={<Icon name="check" size={12} />}>
            {t`Approve`}
          </Button>
          <Button size="xs" color="red" variant="outline" onClick={handleDeny} leftSection={<Icon name="close" size={12} />}>
            {t`Deny`}
          </Button>
        </Flex>
      ) : (
        <Text size="xs" c="text-tertiary" mt={4}>{t`Decision sent`}</Text>
      )}
    </Box>
  );
}

function ToolCallRow({ message }: { message: ChatMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isRunning = message.toolStatus === "running";
  const isError = message.toolStatus === "error";

  return (
    <Box className={S.toolRow}>
      <Group
        className={S.toolRowHeader}
        gap={6}
        align="center"
        wrap="nowrap"
        onClick={message.toolResult ? () => setIsExpanded(v => !v) : undefined}
        style={message.toolResult ? { cursor: "pointer" } : undefined}
      >
        {isRunning ? (
          <Loader size={11} />
        ) : (
          <Icon
            name={isError ? "warning" : "check"}
            size={11}
            color={isError ? "var(--mb-color-error)" : "var(--mb-color-success)"}
          />
        )}
        <Icon name={getToolIcon(message.toolName)} size={12} color="var(--mb-color-text-tertiary)" />
        <Text size="xs" c="text-secondary" lh={1} style={{ flex: 1 }} truncate>
          {formatToolName(message.toolName)}{isRunning ? "…" : ""}
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
        <ScrollArea className={S.toolResultScroll} scrollbarSize={4}>
          <Code className={S.toolResult} block>
            {message.toolResult}
          </Code>
        </ScrollArea>
      )}
    </Box>
  );
}

/* ── Grouped tool calls block ─────────────────────────────────────────── */

function ToolCallGroup({ messages, onMcpApproval }: { messages: ChatMessage[]; onMcpApproval?: (responseId: string, decisions: { id: string; approve: boolean }[]) => void }) {
  const runningCount = messages.filter(m => m.toolStatus === "running").length;
  const errorCount = messages.filter(m => m.toolStatus === "error").length;
  const doneCount = messages.length - runningCount;
  const isAllDone = runningCount === 0;
  const currentTool = !isAllDone
    ? messages.find(m => m.toolStatus === "running")
    : null;

  const [isExpanded, setIsExpanded] = useState(false);
  const showTools = isExpanded;

  const summaryLabel = !isAllDone
    ? t`Running ${formatToolName(currentTool?.toolName)}…`
    : errorCount > 0
      ? t`Used ${messages.length} tools (${errorCount} failed)`
      : t`Used ${messages.length} tools`;

  return (
    <Paper className={S.toolGroup} withBorder radius="sm" p={0}>
      <Group
        className={S.toolGroupHeader}
        gap={6}
        px={10}
        py={6}
        align="center"
        wrap="nowrap"
        onClick={() => setIsExpanded(v => !v)}
        style={{ cursor: "pointer" }}
      >
        {!isAllDone ? (
          <Loader size={12} />
        ) : errorCount > 0 ? (
          <Icon name="warning" size={12} color="var(--mb-color-error)" />
        ) : (
          <Icon name="check" size={12} color="var(--mb-color-success)" />
        )}
        <Text size="xs" c="text-secondary" lh={1} style={{ flex: 1 }}>
          {summaryLabel}
        </Text>
        {isAllDone && (
          <Text size="xs" c="text-tertiary" lh={1}>
            {doneCount}/{messages.length}
          </Text>
        )}
        <Icon
          name={showTools ? "chevronup" : "chevrondown"}
          size={10}
          color="var(--mb-color-text-tertiary)"
        />
      </Group>
      {showTools && (
        <Stack gap={0} className={S.toolGroupBody}>
          {messages.map(msg =>
            msg.mcpApproval
              ? <McpApprovalRow key={msg.id} message={msg} onDecision={onMcpApproval} />
              : <ToolCallRow key={msg.id} message={msg} />,
          )}
        </Stack>
      )}
    </Paper>
  );
}

/* ── Timestamp label ─────────────────────────────────────────────────────── */

function MessageTimestamp({ timestamp }: { timestamp?: string }) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <Text size="xs" c="text-tertiary" className={S.messageTimestamp}>
      {time}
    </Text>
  );
}

/* ── Copy button for assistant messages ─────────────────────────────────── */

function CopyMessageButton({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);

  const textContent = useMemo(() => {
    if (message.content) return message.content;
    if (message.blocks) {
      return message.blocks
        .filter(b => b.type === "text" || b.type === "sql")
        .map(b => (b as { content: string }).content)
        .join("\n\n");
    }
    return "";
  }, [message]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [textContent]);

  if (!textContent) return null;

  return (
    <Tooltip label={copied ? t`Copied!` : t`Copy`}>
      <ActionIcon
        variant="subtle"
        size="xs"
        onClick={handleCopy}
        className={S.copyMessageButton}
        aria-label={t`Copy message`}
      >
        <Icon
          name={copied ? "check" : "copy"}
          size={12}
          color={copied ? "var(--mb-color-success)" : "var(--mb-color-text-tertiary)"}
        />
      </ActionIcon>
    </Tooltip>
  );
}

/* ── Metric link rendering in text ───────────────────────────────────────── */

// Matches all forms:
// ["metric", 42] /* Name */
// Matches ["type", id] /* optional name */ for all entity types
// Supported types: metric, model, question, table, dashboard, document, collection, database
const ENTITY_REF_PATTERN = /`?\["(metric|model|question|table|dashboard|document|collection|database)",\s*(\d+)\]`?(?:\s*\/\*\s*(.+?)\s*\*\/)?/g;

const ENTITY_ROUTES: Record<string, string> = {
  metric: "/metric",
  model: "/model",
  question: "/question",
  table: "/question#", // tables don't have direct routes, link to question
  dashboard: "/dashboard",
  document: "/document",
  collection: "/collection",
  database: "/question#", // databases don't have direct routes
};

const ENTITY_ICONS: Record<string, string> = {
  metric: "metric",
  model: "model",
  question: "question",
  table: "database",
  dashboard: "dashboard",
  document: "document",
  collection: "folder",
  database: "database",
};

// Cache for entity names fetched by ID
const entityNameCache = new Map<string, string>();

function EntityLink({ type, id, name }: { type: string; id: number; name?: string | null }) {
  const cacheKey = `${type}:${id}`;
  const [resolvedName, setResolvedName] = useState<string | null>(
    () => name || entityNameCache.get(cacheKey) || null,
  );

  useEffect(() => {
    if (resolvedName) return;
    // Resolve name via appropriate API based on type
    const apiPath = (type === "metric" || type === "model" || type === "question")
      ? `/api/card/${id}`
      : type === "dashboard" ? `/api/dashboard/${id}`
      : type === "collection" ? `/api/collection/${id}`
      : type === "document" ? `/api/card/${id}`
      : type === "table" ? `/api/table/${id}`
      : null;
    if (!apiPath) { setResolvedName(`${type} #${id}`); return; }
    fetch(apiPath, { headers: { "Content-Type": "application/json" } })
      .then(r => r.json())
      .then(data => {
        const n = (data?.name as string) || (data?.display_name as string) || `${type} #${id}`;
        entityNameCache.set(cacheKey, n);
        setResolvedName(n);
      })
      .catch(() => setResolvedName(`${type} #${id}`));
  }, [id, type, cacheKey, resolvedName]);

  const route = ENTITY_ROUTES[type] ?? "/question";

  return (
    <Link
      to={`${route}/${id}`}
      style={{
        color: "var(--mb-color-brand)",
        textDecoration: "none",
        fontWeight: 600,
        borderBottom: "1px dashed var(--mb-color-brand)",
      }}
    >
      {resolvedName ?? `#${id}`}
    </Link>
  );
}

// Replace entity references like ["metric", 42] /* Name */ with clickable links
function EntityAwareText({ content, className }: { content: string; className?: string }) {
  // Quick check: does content have any entity reference pattern?
  if (!/\["(?:metric|model|question|table|dashboard|document|collection|database)"/.test(content)) {
    return <Markdown className={className}>{content}</Markdown>;
  }

  const refs: { type: string; id: number; name: string | null }[] = [];
  const cleaned = content.replace(new RegExp(ENTITY_REF_PATTERN), (_m, type, id, name) => {
    const i = refs.length;
    refs.push({ type, id: parseInt(id, 10), name: name || null });
    return `\u200B__E${i}__\u200B`;
  });

  if (refs.length === 0) {
    return <Markdown className={className}>{content}</Markdown>;
  }

  const segments = cleaned.split(/\u200B__E(\d+)__\u200B/);
  const parts: ReactNode[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 0) {
      if (segments[i]) parts.push(<Markdown key={`t${i}`} className={className}>{segments[i]}</Markdown>);
    } else {
      const r = refs[parseInt(segments[i], 10)];
      if (r) parts.push(<EntityLink key={`e${i}`} type={r.type} id={r.id} name={r.name} />);
    }
  }
  return <div className={className}>{parts}</div>;
}

/* ── Message bubble ──────────────────────────────────────────────────────── */

function MessageBubble({
  message,
  onSaveAsQuestion,
}: {
  message: ChatMessage;
  onSaveAsQuestion?: (sql: string) => void;
}) {
  // Tools are rendered via ToolCallGroup, not individually
  if (message.role === "tool") {
    return null;
  }

  // Skip the optimistic placeholder added while waiting for the server response
  if (message.content === null && !message.blocks) {
    return null;
  }

  const isUser = message.role === "user";

  if (isUser) {
    return (
      <Flex className={S.messageBubbleRow} justify="flex-end" direction="column" align="flex-end">
        <Paper className={S.userBubble} radius="xl">
          {message.attachedFile && (
            <Flex align="center" gap={4} mb={message.content ? 6 : 0}
              style={{ padding: "2px 4px", background: "var(--mb-color-background-primary)", borderRadius: 6, border: "1px solid var(--mb-color-border)" }}>
              <Icon name="attachment" size={11} color="var(--mb-color-brand)" />
              <Text size="xs" c="brand" fw={500} style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {message.attachedFile.name}
              </Text>
            </Flex>
          )}
          {message.content && <EntityAwareText content={message.content} className={S.userMarkdown} />}
        </Paper>
        <MessageTimestamp timestamp={message.timestamp} />
      </Flex>
    );
  }

  // Assistant message — structured blocks or plain markdown fallback
  const bubbleContent = message.blocks && message.blocks.length > 0 ? (
    <Stack gap={8}>
      {message.blocks.map((block, idx) => (
        <ContentBlockRenderer
          key={idx}
          block={block}
          onSaveAsQuestion={onSaveAsQuestion}
        />
      ))}
    </Stack>
  ) : (
    <Markdown>{message.content ?? ""}</Markdown>
  );

  const hasRichBlock = message.blocks?.some(b => b.type !== "text") ?? false;

  return (
    <Flex className={S.messageBubbleRow} justify="flex-start" direction="column" align="flex-start">
      <Box className={S.assistantBubbleWrapper}>
        <Paper className={`${S.assistantBubble} ${hasRichBlock ? S.assistantBubbleWide : ""}`} radius="xl">
          {bubbleContent}
        </Paper>
        <CopyMessageButton message={message} />
      </Box>
      <MessageTimestamp timestamp={message.timestamp} />
    </Flex>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

interface AgentChatMessagesProps {
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string | null;
  onSelectPrompt?: (prompt: string) => void;
  onSaveAsQuestion?: (sql: string) => void;
  onRetry?: () => void;
  onMcpApproval?: (responseId: string, decisions: { id: string; approve: boolean }[]) => void;
  examplePrompts?: string[];
}

export function AgentChatMessages({
  messages,
  isLoading,
  examplePrompts,
  error,
  onSelectPrompt,
  onSaveAsQuestion,
  onRetry,
  onMcpApproval,
}: AgentChatMessagesProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Track whether user is scrolled to bottom
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const threshold = 40;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll only if user was at bottom
  useEffect(() => {
    if (isAtBottomRef.current && viewportRef.current) {
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
            {(examplePrompts ?? DEFAULT_EXAMPLE_PROMPTS).map(p => (
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
      onScrollPositionChange={handleScroll}
    >
      <Stack className={S.messagesInner} gap={4} p="12px 16px">
        {(() => {
          const elements: React.ReactNode[] = [];
          let i = 0;
          while (i < messages.length) {
            const msg = messages[i];
            if (msg.role === "tool") {
              // Collect consecutive tool messages into a group
              const toolGroup: ChatMessage[] = [];
              while (i < messages.length && messages[i].role === "tool") {
                toolGroup.push(messages[i]);
                i++;
              }
              elements.push(
                <ToolCallGroup key={`tools-${toolGroup[0].id}`} messages={toolGroup} onMcpApproval={onMcpApproval} />,
              );
            } else {
              elements.push(
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onSaveAsQuestion={onSaveAsQuestion}
                />,
              );
              i++;
            }
          }
          return elements;
        })()}
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
        {error && onRetry && (
          <Flex justify="flex-start" className={S.messageBubbleRow}>
            <UnstyledButton className={S.retryButton} onClick={onRetry}>
              <Icon name="refresh" size={14} />
              <Text size="xs" fw={500}>{t`Retry`}</Text>
            </UnstyledButton>
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
