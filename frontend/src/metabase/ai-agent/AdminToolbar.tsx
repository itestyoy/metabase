import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import { CodeEditor } from "metabase/common/components/CodeEditor";
import api from "metabase/lib/api";
import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import { serializeCardForUrl } from "metabase/lib/card";
import { format as formatSql } from "sql-formatter";
import { useSelector } from "metabase/lib/redux";
import { getUserIsAdmin } from "metabase/selectors/user";

import { usePageContext } from "./hooks/usePageContext";
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  DateInput,
  Flex,
  Group,
  Icon,
  Loader,
  Overlay,
  Select,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "metabase/ui";

import S from "./AdminToolbar.module.css";

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Hook — global keyboard shortcut                                          */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function useAdminToolbar() {
  const isAdmin = useSelector(getUserIsAdmin);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey && e.code === "KeyR") {
        e.preventDefault();
        setIsOpen(v => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isAdmin]);

  return { isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false), isAdmin };
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Shared types & helpers                                                   */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface ToolResult {
  type: "sql" | "error" | "json";
  content: string;
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (api.sessionToken) h["X-Metabase-Session"] = api.sessionToken;
  return h;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <Tooltip label={copied ? t`Copied!` : t`Copy`}>
      <ActionIcon variant="subtle" size="xs" onClick={handleCopy}>
        <Icon name={copied ? "check" : "copy"} size={12}
          color={copied ? "var(--mb-color-success)" : "var(--mb-color-text-tertiary)"} />
      </ActionIcon>
    </Tooltip>
  );
}

function buildNativeQuestionUrl(sql: string, databaseId?: number): string {
  const card = {
    dataset_query: {
      type: "native",
      native: { query: sql },
      database: databaseId ?? null,
    },
    display: "table",
    visualization_settings: {},
  };
  return `/question#${serializeCardForUrl(card)}`;
}

function OpenInEditorButton({ sql, databaseId }: { sql: string; databaseId?: number }) {
  const handleClick = useCallback(() => {
    const url = buildNativeQuestionUrl(sql, databaseId);
    window.open(url, "_blank");
  }, [sql, databaseId]);

  return (
    <Tooltip label={t`Open in query editor`}>
      <ActionIcon variant="subtle" size="xs" onClick={handleClick}>
        <Icon name="play" size={12} color="var(--mb-color-brand)" />
      </ActionIcon>
    </Tooltip>
  );
}

function OpenInNotebookButton({ datasetQuery }: { datasetQuery: string }) {
  const handleClick = useCallback(() => {
    try {
      const dq = JSON.parse(datasetQuery);
      const card = {
        dataset_query: dq,
        display: "table",
        visualization_settings: {},
      };
      window.open(`/question/notebook#${serializeCardForUrl(card)}`, "_blank");
    } catch { /* invalid JSON — ignore */ }
  }, [datasetQuery]);

  return (
    <Tooltip label={t`Open in notebook editor`}>
      <ActionIcon variant="subtle" size="xs" onClick={handleClick}>
        <Icon name="notebook" size={12} color="var(--mb-color-brand)" />
      </ActionIcon>
    </Tooltip>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Unified Query Explorer (MBQL input + query history)                      */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface UserOption { id: number; first_name: string; last_name: string; email: string; }
interface QueryRow {
  hash: string;
  started_at: string;
  running_time: number;
  result_rows: number;
  executor_id: number;
  card_id: number | null;
  card_name: string | null;
  user_email: string | null;
  dashboard_id: number | null;
  dashboard_name: string | null;
  database_id: number | null;
  database_name: string | null;
  context: string | null;
  native: boolean;
  raw_query: string | null;
}
interface CompiledCard { card_id: number | null; card_name: string; query: string; }

interface PageContext {
  id: number;
  model: string;
  name: string;
}

function QueryExplorer({ pageContext }: { pageContext: PageContext | null }) {
  // ── MBQL → SQL input state ──
  const [mbqlInput, setMbqlInput] = useState("");
  const [mbqlFormatted, setMbqlFormatted] = useState<string | null>(null);
  const [mbqlLoading, setMbqlLoading] = useState(false);
  const [mbqlResult, setMbqlResult] = useState<ToolResult | null>(null);
  const mbqlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => mbqlInputRef.current?.focus(), 50); }, []);

  const handleMbqlSubmit = useCallback(async () => {
    const text = mbqlInput.trim();
    if (!text || mbqlLoading) return;
    let mbql: unknown;
    try { mbql = JSON.parse(text); } catch {
      setMbqlResult({ type: "error", content: "Invalid JSON — paste a valid MBQL query object" });
      setMbqlFormatted(null);
      return;
    }
    setMbqlFormatted(JSON.stringify(mbql, null, 2));
    setMbqlInput("");
    setMbqlLoading(true);
    setMbqlResult(null);
    try {
      const resp = await fetch("/api/dataset/native", {
        method: "POST", headers: apiHeaders(), body: JSON.stringify(mbql),
      });
      if (!resp.ok) { setMbqlResult({ type: "error", content: `HTTP ${resp.status}: ${await resp.text()}` }); return; }
      const data = await resp.json();
      if (data.query) {
        try { setMbqlResult({ type: "sql", content: formatSql(data.query, { language: "sql" }) }); }
        catch { setMbqlResult({ type: "sql", content: data.query }); }
      } else {
        setMbqlResult({ type: "json", content: JSON.stringify(data, null, 2) });
      }
    } catch (err) {
      setMbqlResult({ type: "error", content: err instanceof Error ? err.message : "Unknown error" });
    } finally { setMbqlLoading(false); }
  }, [mbqlInput, mbqlLoading]);

  // ── Query history state ──
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [dateValue, setDateValue] = useState<Date | null>(() => new Date());
  const [cardIdFilter, setCardIdFilter] = useState<number | null>(null);
  const [dashboardIdFilter, setDashboardIdFilter] = useState<number | null>(null);
  const [contextLabel, setContextLabel] = useState<string | null>(null);
  const contextApplied = useRef(false);

  // Auto-populate filters from page context (runs when context loads async)
  useEffect(() => {
    if (contextApplied.current || !pageContext) return;
    contextApplied.current = true;
    if (pageContext.model === "card" || pageContext.model === "dataset" || pageContext.model === "metric") {
      setCardIdFilter(pageContext.id);
      setContextLabel(pageContext.name);
    } else if (pageContext.model === "dashboard") {
      setDashboardIdFilter(pageContext.id);
      setContextLabel(pageContext.name);
    }
  }, [pageContext]);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [isLoadingQueries, setIsLoadingQueries] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersStale, setFiltersStale] = useState(false);
  // Selected row detail
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [expandedSql, setExpandedSql] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Load users on mount
  useEffect(() => {
    fetch("/api/ai-agent/admin/users", { headers: apiHeaders() })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setUsers(data); })
      .catch(() => {});
  }, []);

  const userOptions = useMemo(
    () => users.map(u => ({
      value: String(u.id),
      label: `${u.first_name} ${u.last_name} (${u.email})`,
    })),
    [users],
  );

  // Entity picker (MiniPicker) state
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);

  const handleEntityPick = useCallback((item: { id: number | string; name: string; model: string }) => {
    setEntityPickerOpen(false);
    if (item.model === "dashboard") {
      setDashboardIdFilter(item.id as number);
      setCardIdFilter(null);
    } else {
      setCardIdFilter(item.id as number);
      setDashboardIdFilter(null);
    }
    setContextLabel(item.name);
  }, []);

  const PAGE_SIZE = 200;

  const doFetch = useCallback(async (before?: string) => {
    setIsLoadingQueries(true);
    setFiltersStale(false);
    if (!before) {
      setQueries([]);
      setExpandedRow(null);
      setExpandedDetail(null);
      setExpandedSql(null);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedUserId) params.set("user_id", selectedUserId);
      const dateStr = dateValue instanceof Date && !isNaN(dateValue.getTime())
        ? dateValue.toISOString().slice(0, 10)
        : null;
      if (dateStr) params.set("date", dateStr);
      if (cardIdFilter) params.set("card_id", String(cardIdFilter));
      if (dashboardIdFilter) params.set("dashboard_id", String(dashboardIdFilter));
      if (before) params.set("before", before);
      params.set("limit", String(PAGE_SIZE));
      const resp = await fetch(`/api/ai-agent/admin/query-history?${params}`, { headers: apiHeaders() });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data?.message || data?.error || `HTTP ${resp.status}`);
      } else if (Array.isArray(data)) {
        setQueries(prev => before ? [...prev, ...data] : data);
        setHasMore(data.length === PAGE_SIZE);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally { setIsLoadingQueries(false); }
  }, [selectedUserId, dateValue, cardIdFilter, dashboardIdFilter]);

  const fetchQueries = useCallback(() => doFetch(), [doFetch]);

  const loadMore = useCallback(() => {
    if (queries.length === 0) return;
    const lastStartedAt = queries[queries.length - 1].started_at;
    doFetch(lastStartedAt);
  }, [queries, doFetch]);

  const handleRowClick = useCallback(async (idx: number) => {
    if (expandedRow === idx) {
      setExpandedRow(null);
      setExpandedDetail(null);
      setExpandedSql(null);
      return;
    }
    const q = queries[idx];
    setExpandedRow(idx);
    setExpandedDetail(null);
    setExpandedSql(null);
    setIsLoadingDetail(true);

    try {
      if (q.card_id) {
        // Saved card: fetch dataset_query JSON + compile to SQL
        const resp = await fetch(`/api/card/${q.card_id}`, { headers: apiHeaders() });
        const card = await resp.json();
        const dq = card?.dataset_query;
        setExpandedDetail(dq ? JSON.stringify(dq, null, 2) : JSON.stringify(card, null, 2));

        // Compile to SQL
        if (dq) {
          try {
            const sqlResp = await fetch("/api/dataset/native", {
              method: "POST", headers: apiHeaders(), body: JSON.stringify(dq),
            });
            const sqlData = await sqlResp.json();
            if (sqlData?.query) {
              try { setExpandedSql(formatSql(sqlData.query, { language: "sql" })); }
              catch { setExpandedSql(sqlData.query); }
            }
          } catch { /* SQL compilation optional */ }
        }
      } else if (q.raw_query) {
        // Ad-hoc: raw SQL is the detail
        try { setExpandedSql(formatSql(q.raw_query, { language: "sql" })); }
        catch { setExpandedSql(q.raw_query); }
      }
    } catch {
      setExpandedDetail("Failed to load query details");
    } finally {
      setIsLoadingDetail(false);
    }
  }, [expandedRow, queries]);


  return (
    <>
      {/* ── MBQL → SQL input ──── */}
      <Box pos="relative">
        <input ref={mbqlInputRef} className={S.input} value={mbqlInput}
          placeholder={t`Paste MBQL JSON to compile to SQL, or search queries below…`}
          onChange={e => { setMbqlInput(e.target.value); setMbqlFormatted(null); }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleMbqlSubmit(); } }}
        />
        <Stack className={S.iconContainer} align="center" left={36} pos="absolute" top={26}>
          <Icon c="text-primary" name="notebook" />
        </Stack>
      </Box>

      {/* ── MBQL formatted input ──── */}
      {mbqlFormatted && (
        <Box className={S.formattedInputContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={4}>
            <Text size="xs" fw={500} c="text-tertiary">{t`Input MBQL`}</Text>
            <Flex gap={4}>
              {mbqlFormatted.includes('"type": "query"') || mbqlFormatted.includes('"type":"query"')
                ? <OpenInNotebookButton datasetQuery={mbqlFormatted} />
                : mbqlFormatted.includes('"type": "native"') || mbqlFormatted.includes('"type":"native"')
                  ? <OpenInEditorButton sql={(() => { try { return JSON.parse(mbqlFormatted)?.native?.query ?? ""; } catch { return ""; } })()} />
                  : null}
              <CopyButton text={mbqlFormatted} />
              <ActionIcon variant="subtle" size="xs" onClick={() => setMbqlFormatted(null)}>
                <Icon name="close" size={10} color="var(--mb-color-text-tertiary)" />
              </ActionIcon>
            </Flex>
          </Flex>
          <Box mah={170} className={S.codeEditorScroll}>
            <CodeEditor value={mbqlFormatted} language="json" readOnly lineNumbers={false} className={S.codeEditor} />
          </Box>
        </Box>
      )}

      {/* ── MBQL compile result ──── */}
      {mbqlLoading && (
        <Flex align="center" justify="center" p="md" gap={8}>
          <Loader size="sm" /><Text size="sm" c="text-tertiary">{t`Compiling…`}</Text>
        </Flex>
      )}
      {mbqlResult && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={6}>
            <Flex align="center" gap={6}>
              <Icon name={mbqlResult.type === "error" ? "warning" : "check"} size={14}
                color={mbqlResult.type === "error" ? "var(--mb-color-error)" : "var(--mb-color-success)"} />
              <Text size="xs" fw={500} c={mbqlResult.type === "error" ? "error" : "text-secondary"}>
                {mbqlResult.type === "sql" ? "SQL" : mbqlResult.type === "error" ? t`Error` : "JSON"}
              </Text>
            </Flex>
            <Flex gap={4}>
              {mbqlResult.type === "sql" && <OpenInEditorButton sql={mbqlResult.content} />}
              <CopyButton text={mbqlResult.content} />
              <ActionIcon variant="subtle" size="xs" onClick={() => setMbqlResult(null)}>
                <Icon name="close" size={10} color="var(--mb-color-text-tertiary)" />
              </ActionIcon>
            </Flex>
          </Flex>
          <Box mah="min(40vh, 500px)" className={S.codeEditorScroll}>
            <CodeEditor value={mbqlResult.content}
              language={mbqlResult.type === "sql" ? "sql" : mbqlResult.type === "json" ? "json" : undefined}
              readOnly lineNumbers={mbqlResult.type === "sql"} className={S.codeEditor} />
          </Box>
        </Box>
      )}

      {/* ── Query history filters ──── */}
      <Flex className={S.filtersBar} gap="sm" align="center" px="md" py={8}>
        <Select
          size="xs"
          w={220}
          placeholder={t`All users`}
          data={userOptions}
          value={selectedUserId}
          onChange={setSelectedUserId}
          clearable
          searchable
          leftSection={<Icon name="person" size={14} />}
          comboboxProps={{ withinPortal: true, position: "bottom-start" }}
        />
        <DateInput
          size="xs"
          w={150}
          placeholder={t`Date`}
          value={dateValue}
          onChange={(v: Date | null) => {
            if (v === null) { setDateValue(null); return; }
            const d = v instanceof Date ? v : new Date(v);
            setDateValue(isNaN(d.getTime()) ? null : d);
          }}
          clearable
          valueFormat="YYYY-MM-DD"
          leftSection={<Icon name="calendar" size={14} />}
          popoverProps={{ withinPortal: true }}
        />
        {/* Entity filter: MiniPicker (no children — trigger is separate) */}
        <Box pos="relative">
          {contextLabel && (cardIdFilter || dashboardIdFilter) ? (
            <Flex align="center" gap={4} className={S.contextChip}>
              <Icon name={dashboardIdFilter ? "dashboard" : "question"} size={12} />
              <Text size="xs" truncate maw={160}>{contextLabel}</Text>
              <ActionIcon variant="transparent" size="xs"
                onClick={() => { setCardIdFilter(null); setDashboardIdFilter(null); setContextLabel(null); }}>
                <Icon name="close" size={10} />
              </ActionIcon>
            </Flex>
          ) : (
            <UnstyledButton
              className={S.entityPickerButton}
              onClick={() => setEntityPickerOpen(o => !o)}
            >
              <Icon name="filter" size={12} color="var(--mb-color-text-tertiary)" />
              <Text size="xs" c="text-tertiary">{t`Card / Dashboard`}</Text>
            </UnstyledButton>
          )}
          <MiniPicker
            opened={entityPickerOpen}
            onClose={() => setEntityPickerOpen(false)}
            models={["card", "dashboard"]}
            onChange={handleEntityPick}
            dropdownMt={4}
            menuDropdownProps={{ style: { zIndex: 400 } }}
          />
        </Box>

        {filtersStale && queries.length > 0 && (
          <Text size="xs" c="warning" ml="auto">{t`Filters changed`}</Text>
        )}
        <Button size="xs" variant="filled" onClick={fetchQueries} loading={isLoadingQueries}
          ml={filtersStale && queries.length > 0 ? undefined : "auto"}
          leftSection={<Icon name="search" size={12} />}>
          {t`Search`}
        </Button>
      </Flex>

      {/* ── Error ──── */}
      {error && (
        <Flex align="center" gap={8} px="md" py={8} className={S.errorBar}>
          <Icon name="warning" size={14} color="var(--mb-color-error)" />
          <Text size="xs" c="error" style={{ flex: 1 }}>{error}</Text>
          <ActionIcon variant="transparent" size="xs" onClick={() => setError(null)}>
            <Icon name="close" size={10} />
          </ActionIcon>
        </Flex>
      )}

      {/* ── Query list ──── */}
      {queries.length > 0 && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" px="md" py={4} gap={8}>
            <Text size="xs" fw={500} c="text-secondary" style={{ flex: 1 }}>{t`Query`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={50}>{t`Type`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={100} truncate>{t`Dashboard`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={80} truncate>{t`Database`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={50} ta="right">{t`Rows`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={55} ta="right">{t`Time`}</Text>
          </Flex>
          <Box className={S.queryListScroll}>
            {queries.map((q, i) => {
              const isActive = expandedRow === i;
              return (
                <UnstyledButton key={`${q.hash}-${i}`}
                  className={`${S.queryRow} ${isActive ? S.queryRowExpanded : ""}`}
                  onClick={() => handleRowClick(i)}
                >
                  <Flex align="center" px="md" py={5} gap={8}>
                    <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" truncate fw={500}>
                        {q.card_name ?? (q.native ? t`Ad-hoc SQL` : t`Ad-hoc query`)}
                      </Text>
                      <Text size="xs" c="text-tertiary" truncate>
                        {q.user_email} · {new Date(q.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        {q.context ? ` · ${q.context}` : ""}
                      </Text>
                    </Flex>
                    <Text size="xs" w={50} c={q.native ? "text-tertiary" : "brand"} fw={500}>
                      {q.native ? "SQL" : "MBQL"}
                    </Text>
                    <Text size="xs" c="text-tertiary" w={100} truncate>{q.dashboard_name ?? "—"}</Text>
                    <Text size="xs" c="text-tertiary" w={80} truncate>{q.database_name ?? "—"}</Text>
                    <Text size="xs" c="text-secondary" w={50} ta="right">{q.result_rows ?? "—"}</Text>
                    <Text size="xs" c="text-secondary" w={55} ta="right">{q.running_time != null ? `${q.running_time}ms` : "—"}</Text>
                  </Flex>
                </UnstyledButton>
              );
            })}
          </Box>
          {hasMore && (
            <Flex justify="center" py={6} className={S.loadMoreBar}>
              <Button size="xs" variant="subtle" onClick={loadMore} loading={isLoadingQueries}
                leftSection={<Icon name="chevrondown" size={12} />}>
                {t`Load more`} ({queries.length} {t`loaded`})
              </Button>
            </Flex>
          )}
        </Box>
      )}
      {/* ── Selected row: actions bar ──── */}
      {expandedRow !== null && queries[expandedRow] && (
        <Flex className={S.actionsBar} gap="xs" align="center" px="md" py={6} wrap="wrap">
          {queries[expandedRow].card_id && (
            <Button size="xs" variant="light" leftSection={<Icon name="question" size={12} />}
              onClick={() => window.open(`/question/${queries[expandedRow]!.card_id}`, "_blank")}>
              {t`Open Card`}
            </Button>
          )}
          {queries[expandedRow].dashboard_id && (
            <Button size="xs" variant="light" leftSection={<Icon name="dashboard" size={12} />}
              onClick={() => window.open(`/dashboard/${queries[expandedRow]!.dashboard_id}`, "_blank")}>
              {t`Open Dashboard`}
            </Button>
          )}
          {!queries[expandedRow].native && expandedDetail && (
            <OpenInNotebookButton datasetQuery={expandedDetail} />
          )}
          {(queries[expandedRow].native || expandedSql) && (
            <OpenInEditorButton sql={expandedSql ?? ""} />
          )}
          <Box style={{ flex: 1 }} />
          {queries[expandedRow].card_id && (
            <Button size="xs" variant="subtle" c="text-tertiary"
              leftSection={<Icon name="filter" size={12} />}
              onClick={() => {
                setCardIdFilter(queries[expandedRow]!.card_id);
                setDashboardIdFilter(null);
                setContextLabel(queries[expandedRow]!.card_name ?? `Card ${queries[expandedRow]!.card_id}`);
                setFiltersStale(true);
              }}>
              {t`Filter by card`}
            </Button>
          )}
          {queries[expandedRow].dashboard_id && (
            <Button size="xs" variant="subtle" c="text-tertiary"
              leftSection={<Icon name="filter" size={12} />}
              onClick={() => {
                setDashboardIdFilter(queries[expandedRow]!.dashboard_id);
                setCardIdFilter(null);
                setContextLabel(queries[expandedRow]!.dashboard_name ?? `Dashboard ${queries[expandedRow]!.dashboard_id}`);
                setFiltersStale(true);
              }}>
              {t`Filter by dashboard`}
            </Button>
          )}
          <ActionIcon variant="subtle" size="xs" onClick={() => { setExpandedRow(null); setExpandedDetail(null); setExpandedSql(null); }}>
            <Icon name="close" size={10} color="var(--mb-color-text-tertiary)" />
          </ActionIcon>
        </Flex>
      )}

      {/* ── Selected row: MBQL / dataset_query (only for saved cards) ──── */}
      {expandedRow !== null && expandedDetail && queries[expandedRow]?.card_id && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={4}>
            <Text size="xs" fw={500} c="text-tertiary">
              {queries[expandedRow]?.native ? "dataset_query (native)" : "dataset_query (MBQL)"}
            </Text>
            <CopyButton text={expandedDetail} />
          </Flex>
          <Box mah={200} className={S.codeEditorScroll}>
            <CodeEditor value={expandedDetail} language="json" readOnly lineNumbers className={S.codeEditor} />
          </Box>
        </Box>
      )}

      {/* ── Selected row: SQL (compiled or raw) ──── */}
      {expandedRow !== null && expandedSql && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={4}>
            <Text size="xs" fw={500} c="text-tertiary">
              {queries[expandedRow]?.card_id ? t`Compiled SQL` : "SQL"}
            </Text>
            <Flex gap={4}>
              <OpenInEditorButton sql={expandedSql} />
              <CopyButton text={expandedSql} />
            </Flex>
          </Flex>
          <Box mah={200} className={S.codeEditorScroll}>
            <CodeEditor value={expandedSql} language="sql" readOnly lineNumbers className={S.codeEditor} />
          </Box>
        </Box>
      )}

      {/* ── Loading detail ──── */}
      {isLoadingDetail && (
        <Flex align="center" justify="center" p="md" gap={6}>
          <Loader size="xs" /><Text size="xs" c="text-tertiary">{t`Loading…`}</Text>
        </Flex>
      )}

      {queries.length === 0 && !isLoadingQueries && (
        <Flex align="center" justify="center" p="lg">
          <Text size="sm" c="text-tertiary">{t`Select user and date, then click Search`}</Text>
        </Flex>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Main component                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function AdminToolbar({ onClose }: { onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const rawPageContext = usePageContext();
  const pageCtx: PageContext | null = rawPageContext && rawPageContext.id
    ? { id: rawPageContext.id, model: rawPageContext.model, name: rawPageContext.name }
    : null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleClickOutside = useCallback(
    (e: React.MouseEvent) => { if (e.target === backdropRef.current) onClose(); },
    [onClose],
  );

  return createPortal(
    <Overlay backgroundOpacity={0.5} ref={backdropRef} onClick={handleClickOutside}>
      <Center pt="8vh">
        <Card w="780px" p="0" bd="1px solid var(--mb-color-border)" className={S.card}>
          {/* ── Tabs (extensible) ──── */}
          <Group className={S.tabBar} gap={0}>
            <UnstyledButton className={`${S.tab} ${S.tabActive}`}>
              <Icon name="database" size={14} />
              <Text size="xs" fw={500}>{t`Query Explorer`}</Text>
            </UnstyledButton>
            <Box style={{ flex: 1 }} />
            <Text size="xs" c="text-tertiary" pr="md">{t`Esc to close`}</Text>
          </Group>

          <QueryExplorer pageContext={pageCtx} />
        </Card>
      </Center>
    </Overlay>,
    document.body,
  );
}
