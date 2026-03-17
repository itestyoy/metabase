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
  Checkbox,
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

type Tab = "mbql" | "queries";

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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Tab 1: MBQL → SQL                                                        */
/* ═══════════════════════════════════════════════════════════════════════════ */

function MbqlTab() {
  const [input, setInput] = useState("");
  const [formattedInput, setFormattedInput] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Validate JSON before sending to backend
    let mbql: unknown;
    try {
      mbql = JSON.parse(text);
    } catch {
      setResult({ type: "error", content: "Invalid JSON — paste a valid MBQL query object" });
      setFormattedInput(null);
      return;
    }

    setFormattedInput(JSON.stringify(mbql, null, 2));
    setInput("");
    setIsLoading(true);
    setResult(null);
    try {
      const resp = await fetch("/api/dataset/native", {
        method: "POST", headers: apiHeaders(), body: JSON.stringify(mbql),
      });
      if (!resp.ok) {
        setResult({ type: "error", content: `HTTP ${resp.status}: ${await resp.text()}` });
        return;
      }
      const data = await resp.json();
      if (data.query) {
        try {
          setResult({ type: "sql", content: formatSql(data.query, { language: "sql" }) });
        } catch {
          setResult({ type: "sql", content: data.query });
        }
      } else {
        setResult({ type: "json", content: JSON.stringify(data, null, 2) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setResult({ type: "error", content: msg });
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading]);

  return (
    <>
      <Box pos="relative">
        <input ref={inputRef} className={S.input} value={input}
          placeholder={t`Paste MBQL JSON to compile to SQL…`}
          onChange={e => { setInput(e.target.value); setFormattedInput(null); }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        />
        <Stack className={S.iconContainer} align="center" left={36} pos="absolute" top={26}>
          <Icon c="text-primary" name="notebook" />
        </Stack>
      </Box>
      <Flex className={S.hintBar} align="center" justify="space-between" px="md" py={6}>
        <Text size="xs" c="text-tertiary">{t`MBQL → SQL`}</Text>
        <Text size="xs" c="text-tertiary">{t`Enter to run`}</Text>
      </Flex>
      {/* Formatted input JSON */}
      {formattedInput && (
        <Box className={S.formattedInputContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={4}>
            <Text size="xs" fw={500} c="text-tertiary">{t`Input MBQL`}</Text>
            <CopyButton text={formattedInput} />
          </Flex>
          <Box mah={170} className={S.codeEditorScroll}>
            <CodeEditor value={formattedInput} language="json" readOnly lineNumbers={false} className={S.codeEditor} />
          </Box>
        </Box>
      )}
      {isLoading && (
        <Flex align="center" justify="center" p="lg" gap={8}>
          <Loader size="sm" /><Text size="sm" c="text-tertiary">{t`Compiling…`}</Text>
        </Flex>
      )}
      {result && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={6}>
            <Flex align="center" gap={6}>
              <Icon name={result.type === "error" ? "warning" : "check"} size={14}
                color={result.type === "error" ? "var(--mb-color-error)" : "var(--mb-color-success)"} />
              <Text size="xs" fw={500} c={result.type === "error" ? "error" : "text-secondary"}>
                {result.type === "sql" ? "SQL" : result.type === "error" ? t`Error` : "JSON"}
              </Text>
            </Flex>
            <Flex gap={4}>
              {result.type === "sql" && <OpenInEditorButton sql={result.content} />}
              <CopyButton text={result.content} />
            </Flex>
          </Flex>
          <Box mah="min(50vh, 700px)" className={S.codeEditorScroll}>
            <CodeEditor
              value={result.content}
              language={result.type === "sql" ? "sql" : result.type === "json" ? "json" : undefined}
              readOnly
              lineNumbers={result.type === "sql"}
              className={S.codeEditor}
            />
          </Box>
        </Box>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Tab 2: Query Explorer                                                    */
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

function QueriesTab({ pageContext }: { pageContext: PageContext | null }) {
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [dateValue, setDateValue] = useState<Date | null>(() => new Date());
  const [cardIdFilter, setCardIdFilter] = useState<number | null>(
    pageContext?.model === "card" || pageContext?.model === "dataset" || pageContext?.model === "metric"
      ? pageContext.id : null,
  );
  const [dashboardIdFilter, setDashboardIdFilter] = useState<number | null>(
    pageContext?.model === "dashboard" ? pageContext.id : null,
  );
  const [contextLabel, setContextLabel] = useState<string | null>(
    pageContext ? `${pageContext.name}` : null,
  );
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [isLoadingQueries, setIsLoadingQueries] = useState(false);
  // Selection by row index (works for both card and ad-hoc)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [compiledResults, setCompiledResults] = useState<CompiledCard[]>([]);
  const [isCompiling, setIsCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
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

  const fetchQueries = useCallback(async () => {
    setIsLoadingQueries(true);
    setQueries([]);
    setSelectedIndices(new Set());
    setCompiledResults([]);
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
      params.set("limit", "100");
      const resp = await fetch(`/api/ai-agent/admin/query-history?${params}`, { headers: apiHeaders() });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data?.message || data?.error || `HTTP ${resp.status}`);
      } else if (Array.isArray(data)) {
        setQueries(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally { setIsLoadingQueries(false); }
  }, [selectedUserId, dateValue, cardIdFilter, dashboardIdFilter]);

  const handleRowClick = useCallback(async (idx: number) => {
    if (expandedRow === idx) {
      setExpandedRow(null);
      setExpandedDetail(null);
      return;
    }
    const q = queries[idx];
    setExpandedRow(idx);
    setExpandedDetail(null);

    // Fetch detail for any query
    setIsLoadingDetail(true);
    try {
      if (q.card_id) {
        const resp = await fetch(`/api/card/${q.card_id}`, { headers: apiHeaders() });
        const card = await resp.json();
        const dq = card?.dataset_query;
        setExpandedDetail(dq ? JSON.stringify(dq, null, 2) : JSON.stringify(card, null, 2));
      } else if (q.raw_query) {
        try {
          setExpandedDetail(formatSql(q.raw_query, { language: "sql" }));
        } catch {
          setExpandedDetail(q.raw_query);
        }
      } else {
        setExpandedDetail(null);
      }
    } catch {
      setExpandedDetail("Failed to load query details");
    } finally {
      setIsLoadingDetail(false);
    }
  }, [expandedRow, queries]);

  const toggleIndex = useCallback((idx: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  // Selectable: saved questions (card_id) or any query with raw_query
  const selectableIndices = useMemo(
    () => queries.map((q, i) => (q.card_id != null || q.raw_query) ? i : -1).filter(i => i >= 0),
    [queries],
  );

  const toggleAll = useCallback(() => {
    setSelectedIndices(prev =>
      prev.size === selectableIndices.length ? new Set() : new Set(selectableIndices),
    );
  }, [selectableIndices]);

  const compileSelected = useCallback(async () => {
    if (selectedIndices.size === 0) return;
    setIsCompiling(true);
    setCompiledResults([]);
    setError(null);
    try {
      const items = [...selectedIndices].map(idx => {
        const q = queries[idx];
        if (q.card_id) return { card_id: q.card_id };
        return {
          raw_query: q.raw_query,
          label: q.card_name ?? (q.native ? "Ad-hoc SQL" : "Ad-hoc query"),
        };
      });
      const resp = await fetch("/api/ai-agent/admin/compile-queries", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ items }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data?.message || data?.error || `HTTP ${resp.status}`);
      } else if (Array.isArray(data)) {
        setCompiledResults(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compile failed");
    } finally { setIsCompiling(false); }
  }, [selectedIndices, queries]);

  const allSql = useMemo(
    () => compiledResults.map(r => {
      let sql = r.query;
      try { sql = formatSql(sql, { language: "sql" }); } catch { /* keep raw */ }
      return `-- ${r.card_name}${r.card_id ? ` (ID: ${r.card_id})` : ""}\n${sql}`;
    }).join("\n\n"),
    [compiledResults],
  );

  return (
    <>
      {/* ── Filters ──── */}
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

        <Flex gap="xs" ml="auto">
          {selectedIndices.size > 0 && (
            <Button size="xs" variant="light" onClick={compileSelected} loading={isCompiling}
              leftSection={<Icon name="notebook" size={12} />}>
              {t`Get SQL`} ({selectedIndices.size})
            </Button>
          )}
          <Button size="xs" variant="filled" onClick={fetchQueries} loading={isLoadingQueries}
            leftSection={<Icon name="search" size={12} />}>
            {t`Search`}
          </Button>
        </Flex>
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
            <Checkbox size="xs" checked={selectedIndices.size === selectableIndices.length && selectableIndices.length > 0}
              indeterminate={selectedIndices.size > 0 && selectedIndices.size < selectableIndices.length}
              onChange={toggleAll} />
            <Text size="xs" fw={500} c="text-secondary" style={{ flex: 1 }}>{t`Query`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={60} ta="right">{t`Rows`}</Text>
            <Text size="xs" fw={500} c="text-secondary" w={60} ta="right">{t`Time`}</Text>
          </Flex>
          <Box className={S.queryListScroll}>
            {queries.map((q, i) => {
              const selectable = q.card_id != null || !!q.raw_query;
              const isActive = expandedRow === i;
              return (
                <UnstyledButton key={`${q.hash}-${i}`}
                  className={`${S.queryRow} ${isActive ? S.queryRowExpanded : ""}`}
                  onClick={() => handleRowClick(i)}
                >
                  <Flex align="center" px="md" py={5} gap={8}>
                    {selectable ? (
                      <Checkbox size="xs" checked={selectedIndices.has(i)}
                        onChange={() => toggleIndex(i)}
                        onClick={e => e.stopPropagation()} />
                    ) : (
                      <Box w={20} />
                    )}
                    <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" truncate fw={500}>
                        {q.card_name ?? (q.native ? t`Ad-hoc SQL` : t`Ad-hoc query`)}
                      </Text>
                      <Text size="xs" c="text-tertiary" truncate>
                        {q.user_email} · {new Date(q.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        {q.context ? ` · ${q.context}` : ""}
                      </Text>
                    </Flex>
                    <Text size="xs" c="text-secondary" w={60} ta="right">{q.result_rows ?? "—"}</Text>
                    <Text size="xs" c="text-secondary" w={60} ta="right">{q.running_time != null ? `${q.running_time}ms` : "—"}</Text>
                  </Flex>
                </UnstyledButton>
              );
            })}
          </Box>
        </Box>
      )}
      {/* ── Selected row detail (separate section like MBQL tab) ──── */}
      {expandedRow !== null && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={6}>
            <Flex align="center" gap={6}>
              <Icon name={queries[expandedRow]?.raw_query ? "database" : "notebook"} size={14}
                color="var(--mb-color-text-tertiary)" />
              <Text size="xs" fw={500} c="text-secondary">
                {queries[expandedRow]?.card_name ?? (queries[expandedRow]?.native ? t`Ad-hoc SQL` : t`Ad-hoc query`)}
                {queries[expandedRow]?.raw_query ? " — SQL" : " — MBQL"}
              </Text>
            </Flex>
            {expandedDetail && (
              <Flex gap={4}>
                {queries[expandedRow]?.raw_query && !queries[expandedRow]?.card_id && (
                  <OpenInEditorButton sql={expandedDetail} />
                )}
                <CopyButton text={expandedDetail} />
              </Flex>
            )}
          </Flex>
          {isLoadingDetail ? (
            <Flex align="center" justify="center" p="lg" gap={6}>
              <Loader size="xs" /><Text size="xs" c="text-tertiary">{t`Loading…`}</Text>
            </Flex>
          ) : expandedDetail ? (
            <Box mah={200} className={S.codeEditorScroll}>
              <CodeEditor
                value={expandedDetail}
                language={queries[expandedRow]?.raw_query ? "sql" : "json"}
                readOnly
                lineNumbers
                className={S.codeEditor}
              />
            </Box>
          ) : (
            <Text size="xs" c="text-tertiary" p="md">{t`No query data available`}</Text>
          )}
        </Box>
      )}

      {queries.length === 0 && !isLoadingQueries && (
        <Flex align="center" justify="center" p="lg">
          <Text size="sm" c="text-tertiary">{t`Select user and date, then click Search`}</Text>
        </Flex>
      )}

      {/* ── Compiled SQL results ──── */}
      {compiledResults.length > 0 && (
        <Box className={S.resultContainer}>
          <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={6}>
            <Flex align="center" gap={6}>
              <Icon name="check" size={14} color="var(--mb-color-success)" />
              <Text size="xs" fw={500} c="text-secondary">
                {t`SQL for ${compiledResults.length} questions`}
              </Text>
            </Flex>
            <Flex gap={4}>
              <OpenInEditorButton sql={allSql} />
              <CopyButton text={allSql} />
            </Flex>
          </Flex>
          <Box mah="min(50vh, 700px)" className={S.codeEditorScroll}>
            <CodeEditor value={allSql} language="sql" readOnly lineNumbers className={S.codeEditor} />
          </Box>
        </Box>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Main component                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function AdminToolbar({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("mbql");
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
          {/* ── Tabs ──── */}
          <Group className={S.tabBar} gap={0}>
            <UnstyledButton className={`${S.tab} ${tab === "mbql" ? S.tabActive : ""}`}
              onClick={() => setTab("mbql")}>
              <Icon name="notebook" size={14} />
              <Text size="xs" fw={500}>{t`MBQL → SQL`}</Text>
            </UnstyledButton>
            <UnstyledButton className={`${S.tab} ${tab === "queries" ? S.tabActive : ""}`}
              onClick={() => setTab("queries")}>
              <Icon name="database" size={14} />
              <Text size="xs" fw={500}>{t`Query Explorer`}</Text>
            </UnstyledButton>
            <Box style={{ flex: 1 }} />
            <Text size="xs" c="text-tertiary" pr="md">{t`Esc to close`}</Text>
          </Group>

          {/* ── Tab content (both always mounted, hidden via display) ──── */}
          <Box display={tab === "mbql" ? undefined : "none"}><MbqlTab /></Box>
          <Box display={tab === "queries" ? undefined : "none"}><QueriesTab pageContext={pageCtx} /></Box>
        </Card>
      </Center>
    </Overlay>,
    document.body,
  );
}
