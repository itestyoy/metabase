import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "ttag";

import api from "metabase/lib/api";
import { useSelector } from "metabase/lib/redux";
import { getUserIsAdmin } from "metabase/selectors/user";
import {
  ActionIcon,
  Box,
  Card,
  Center,
  Code,
  Flex,
  Icon,
  Loader,
  Overlay,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "metabase/ui";

import S from "./AdminToolbar.module.css";

/** Global keyboard listener — Ctrl+Shift+K (or Cmd+Shift+K on Mac) */
export function useAdminToolbar() {
  const isAdmin = useSelector(getUserIsAdmin);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "k") {
        e.preventDefault();
        setIsOpen(v => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isAdmin]);

  return { isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false), isAdmin };
}

interface ToolResult {
  type: "sql" | "error" | "json";
  content: string;
}

export function AdminToolbar({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleClickOutside = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setIsLoading(true);
    setResult(null);

    try {
      // Try to parse as MBQL JSON
      const mbql = JSON.parse(text);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (api.sessionToken) {
        headers["X-Metabase-Session"] = api.sessionToken;
      }

      const resp = await fetch("/api/dataset/native", {
        method: "POST",
        headers,
        body: JSON.stringify(mbql),
      });

      if (!resp.ok) {
        const err = await resp.text();
        setResult({ type: "error", content: `HTTP ${resp.status}: ${err}` });
        return;
      }

      const data = await resp.json();

      if (data.query) {
        setResult({ type: "sql", content: data.query });
      } else {
        setResult({ type: "json", content: JSON.stringify(data, null, 2) });
      }
    } catch (err) {
      const msg = err instanceof SyntaxError
        ? "Invalid JSON — paste a valid MBQL query object"
        : err instanceof Error ? err.message : "Unknown error";
      setResult({ type: "error", content: msg });
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard.writeText(result.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [result]);

  return createPortal(
    <Overlay backgroundOpacity={0.5} ref={backdropRef} onClick={handleClickOutside}>
      <Center pt="10vh">
        <Card w="680px" p="0" bd="1px solid var(--mb-color-border)" className={S.card}>
          {/* ── Input ──── */}
          <Box pos="relative">
            <input
              ref={inputRef}
              className={S.input}
              placeholder={t`Paste MBQL JSON to compile to SQL…`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <Stack
              className={S.iconContainer}
              align="center"
              left={36}
              pos="absolute"
              top={26}
            >
              <Icon c="text-primary" name="notebook" />
            </Stack>
          </Box>

          {/* ── Hint bar ──── */}
          <Flex className={S.hintBar} align="center" justify="space-between" px="md" py={6}>
            <Text size="xs" c="text-tertiary">
              {t`MBQL → SQL`}
            </Text>
            <Text size="xs" c="text-tertiary">
              {t`Enter to run · Esc to close`}
            </Text>
          </Flex>

          {/* ── Result ──── */}
          {isLoading && (
            <Flex align="center" justify="center" p="lg" gap={8}>
              <Loader size="sm" />
              <Text size="sm" c="text-tertiary">{t`Compiling…`}</Text>
            </Flex>
          )}

          {result && (
            <Box className={S.resultContainer}>
              <Flex className={S.resultHeader} align="center" justify="space-between" px="md" py={6}>
                <Flex align="center" gap={6}>
                  <Icon
                    name={result.type === "error" ? "warning" : "check"}
                    size={14}
                    color={result.type === "error" ? "var(--mb-color-error)" : "var(--mb-color-success)"}
                  />
                  <Text size="xs" fw={500} c={result.type === "error" ? "error" : "text-secondary"}>
                    {result.type === "sql" ? "SQL" : result.type === "error" ? t`Error` : "JSON"}
                  </Text>
                </Flex>
                <Tooltip label={copied ? t`Copied!` : t`Copy`}>
                  <ActionIcon variant="subtle" size="xs" onClick={handleCopy}>
                    <Icon
                      name={copied ? "check" : "copy"}
                      size={12}
                      color={copied ? "var(--mb-color-success)" : "var(--mb-color-text-tertiary)"}
                    />
                  </ActionIcon>
                </Tooltip>
              </Flex>
              <ScrollArea mah={320} scrollbarSize={4}>
                <Code className={S.resultCode} block>
                  {result.content}
                </Code>
              </ScrollArea>
            </Box>
          )}
        </Card>
      </Center>
    </Overlay>,
    document.body,
  );
}
