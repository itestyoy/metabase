import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import api from "metabase/lib/api";
import { useSelector } from "metabase/lib/redux";
import { getUserIsAdmin } from "metabase/selectors/user";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { usePageContext } from "./hooks/usePageContext";
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  DateInput,
  Flex,
  Group,
  Icon,
  Loader,
  Overlay,
  ScrollArea,
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
      if (e.ctrlKey && e.metaKey && e.key === "r") {
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Tab 1: MBQL → SQL                                                        */
/* ═══════════════════════════════════════════════════════════════════════════ */

function MbqlTab() {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setIsLoading(true);
    setResult(null);
    try {
      const mbql = JSON.parse(text);
      const resp = await fetch("/api/dataset/native", {
        method: "POST", headers: apiHeaders(), body: JSON.stringify(mbql),
      });
      if (!resp.ok) {
        setResult({ type: "error", content: `HTTP ${resp.status}: ${await resp.text()}` });
        return;
      }
      const data = await resp.json();
      setResult(data.query
        ? { type: "sql", content: data.query }
        : { type: "json", content: JSON.stringify(data, null, 2) });
    } catch (err) {
      const msg = err instanceof SyntaxError
        ? "Invalid JSON — paste a valid MBQL query object"
        : err instanceof Error ? err.message : "Unknown error";
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
          onChange={e => setInput(e.target.value)}
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
            <CopyButton text={result.content} />
          </Flex>
          <ScrollArea mah={320} scrollbarSize={4}>
            <Code className={S.resultCode} block>{result.content}</Code>
          </ScrollArea>
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
interface CompiledCard { card_id: number; card_name: string; query: string; }

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
  // Entity picker for filtering by card/dashboard
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [isLoadingQueries, setIsLoadingQueries] = useState(false);
  // Selection by row index (works for both card and ad-hoc)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [compiledResults, setCompiledResults] = useState<CompiledCard[]>([]);
  const [isCompiling, setIsCompiling] = useState(false);

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

  const handleEntityPick = useCallback((item: MiniPickerPickableItem) => {
    setEntityPickerOpen(false);
    if (item.model === "dashboard") {
      setDashboardIdFilter(item.id as number);
      setCardIdFilter(null);
      setContextLabel(item.name);
    } else {
      setCardIdFilter(item.id as number);
      setDashboardIdFilter(null);
      setContextLabel(item.name);
    }
  }, []);

  const fetchQueries = useCallback(async () => {
    setIsLoadingQueries(true);
    setQueries([]);
    setSelectedIndices(new Set());
    setCompiledResults([]);
    try {
      const params = new URLSearchParams();
      if (selectedUserId) params.set("user_id", selectedUserId);
      const dateStr = dateValue ? dateValue.toISOString().slice(0, 10) : null;
      if (dateStr) params.set("date", dateStr);
      if (cardIdFilter) params.set("card_id", String(cardIdFilter));
      if (dashboardIdFilter) params.set("dashboard_id", String(dashboardIdFilter));
      params.set("limit", "100");
      const resp = await fetch(`/api/ai-agent/admin/query-history?${params}`, { headers: apiHeaders() });
      const data = await resp.json();
      if (Array.isArray(data)) setQueries(data);
    } catch { /* ignore */ }
    finally { setIsLoadingQueries(false); }
  }, [selectedUserId, dateValue, cardIdFilter, dashboardIdFilter]);

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
      if (Array.isArray(data)) setCompiledResults(data);
    } catch { /* ignore */ }
    finally { setIsCompiling(false); }
  }, [selectedIndices, queries]);

  const allSql = useMemo(
    () => compiledResults.map(r => `-- ${r.card_name} (ID: ${r.card_id})\n${r.query}`).join("\n\n"),
    [compiledResults],
  );

  return (
    <>
      {/* ── Filters ──── */}
      <Flex className={S.filtersBar} gap="sm" align="center" px="md" py={8} wrap="wrap">
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
          onChange={setDateValue}
          clearable
          leftSection={<Icon name="calendar" size={14} />}
          popoverProps={{ withinPortal: true }}
        />
        {/* Entity filter (card/dashboard) via MiniPicker */}
        <MiniPicker
          opened={entityPickerOpen}
          onClose={() => setEntityPickerOpen(false)}
          models={["card", "dashboard"]}
          onChange={handleEntityPick}
          dropdownMt="xs"
        >
          {contextLabel && (cardIdFilter || dashboardIdFilter) ? (
            <Flex align="center" gap={4} className={S.contextChip}
              onClick={() => setEntityPickerOpen(v => !v)}>
              <Icon name={dashboardIdFilter ? "dashboard" : "question"} size={12} />
              <Text size="xs" truncate maw={160}>{contextLabel}</Text>
              <ActionIcon variant="transparent" size="xs"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  setCardIdFilter(null); setDashboardIdFilter(null); setContextLabel(null);
                }}>
                <Icon name="close" size={10} />
              </ActionIcon>
            </Flex>
          ) : (
            <Button size="xs" variant="subtle" c="text-tertiary"
              leftSection={<Icon name="filter" size={12} />}
              onClick={() => setEntityPickerOpen(v => !v)}>
              {t`Card / Dashboard`}
            </Button>
          )}
        </MiniPicker>

        <Button size="xs" variant="filled" onClick={fetchQueries} loading={isLoadingQueries}
          leftSection={<Icon name="search" size={12} />}>
          {t`Search`}
        </Button>
        {selectedIndices.size > 0 && (
          <Button size="xs" variant="light" onClick={compileSelected} loading={isCompiling}
            leftSection={<Icon name="notebook" size={12} />} ml="auto">
            {t`Get SQL`} ({selectedIndices.size})
          </Button>
        )}
      </Flex>

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
          <ScrollArea mah={260} scrollbarSize={4}>
            {queries.map((q, i) => {
              const selectable = q.card_id != null || !!q.raw_query;
              return (
                <UnstyledButton key={`${q.hash}-${i}`} className={S.queryRow}
                  onClick={selectable ? () => toggleIndex(i) : undefined}
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
          </ScrollArea>
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
            <CopyButton text={allSql} />
          </Flex>
          <ScrollArea mah={280} scrollbarSize={4}>
            <Code className={S.resultCode} block>{allSql}</Code>
          </ScrollArea>
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

          {/* ── Tab content ──── */}
          {tab === "mbql" && <MbqlTab />}
          {tab === "queries" && <QueriesTab pageContext={pageCtx} />}
        </Card>
      </Center>
    </Overlay>,
    document.body,
  );
}
