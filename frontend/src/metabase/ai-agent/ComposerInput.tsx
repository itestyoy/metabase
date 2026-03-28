import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import S from "./ComposerInput.module.css";

export interface InlineMetric {
  id: number;
  name: string;
}

/** Supported template placeholder types */
export type TemplatePlaceholderType =
  | "metric"
  | "question"
  | "model"
  | "table"
  | "dashboard"
  | "document"
  | "database"
  | "collection"
  | "datetime"
  | "input";

const PLACEHOLDER_LABELS: Record<TemplatePlaceholderType, string> = {
  metric: "Metric",
  question: "Question",
  model: "Model",
  table: "Table",
  dashboard: "Dashboard",
  document: "Document",
  database: "Database",
  collection: "Collection",
  datetime: "Date / Period",
  input: "Text…",
};

export interface ComposerInputHandle {
  focus: () => void;
  serialize: () => string;
  clear: () => void;
  insertMetric: (metric: InlineMetric) => void;
  getText: () => string;
  insertTemplate: (text: string) => void;
  replaceTemplatePlaceholder: (placeholderId: string, label: string, resolvedId?: number) => void;
}

interface ComposerInputProps {
  placeholder?: string;
  disabled?: boolean;
  markdownEnabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onChange?: (text: string) => void;
  onSlashQueryChange?: (query: string | null) => void;
  onTemplatePlaceholderClick?: (placeholderType: TemplatePlaceholderType, placeholderId: string) => void;
  className?: string;
}

function getSlashQuery(node: Node, offset: number): string | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  let i = offset - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "/") {
      if (i === 0 || text[i - 1] === " " || text[i - 1] === "\n" || text[i - 1] === "\u00A0") {
        return text.slice(i + 1, offset);
      }
      return null;
    }
    if (ch === "\n") return null;
    i--;
  }
  return null;
}

// ── Markdown inline rendering helpers ───────────────────────────────────

/** Create a rendered markdown element. Click reverts to raw text. */
function createMdElement(
  tag: string,
  cssClass: string,
  content: string,
  raw: string,
  editorEl: HTMLElement,
  onRevert: () => void,
): HTMLElement {
  const el = document.createElement(tag);
  el.className = cssClass;
  el.contentEditable = "false";
  el.setAttribute("data-md-raw", raw);
  el.textContent = content;

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Revert to raw markdown text
    const textNode = document.createTextNode(raw);
    el.replaceWith(textNode);
    // Place cursor at end of reverted text
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(textNode, raw.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    editorEl.focus();
    onRevert();
  });

  return el;
}

/** MD pattern definitions — order matters (** before *) */
const MD_PATTERNS: { re: RegExp; tag: string; cls: string; trigger: string }[] = [
  { re: /\*\*([^*]+)\*\*$/, tag: "strong", cls: "mdBold", trigger: "**" },
  { re: /(?:^|[^*])\*([^*]+)\*$/, tag: "em", cls: "mdItalic", trigger: "*" },
  { re: /~~([^~]+)~~$/, tag: "s", cls: "mdStrike", trigger: "~~" },
  { re: /`([^`]+)`$/, tag: "code", cls: "mdCode", trigger: "`" },
];

// ── Component ───────────────────────────────────────────────────────────

export const ComposerInput = forwardRef<ComposerInputHandle, ComposerInputProps>(
  function ComposerInput(
    { placeholder, disabled, markdownEnabled, onKeyDown, onChange, onSlashQueryChange, onTemplatePlaceholderClick, className },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);

    // Floating toolbar state
    const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(null);

    const getText = useCallback((): string => {
      return editorRef.current?.textContent ?? "";
    }, []);

    const serialize = useCallback((): string => {
      const el = editorRef.current;
      if (!el) return "";

      const parts: string[] = [];
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.textContent ?? "");
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const elem = node as HTMLElement;
          // Markdown rendered element → output raw markdown
          const mdRaw = elem.getAttribute("data-md-raw");
          if (mdRaw) {
            parts.push(mdRaw);
            return;
          }
          // Resolved chip (slash metric or template)
          const resolvedType = elem.getAttribute("data-resolved-type");
          if (resolvedType) {
            const rLabel = elem.getAttribute("data-resolved-label") ?? elem.textContent ?? "";
            const rId = elem.getAttribute("data-resolved-id");
            if (rId) {
              parts.push(`["${resolvedType}", ${rId}] /* ${rLabel} */`);
            } else {
              parts.push(rLabel);
            }
            return;
          }
          // Unfilled template placeholder
          const tplType = elem.getAttribute("data-template-type");
          if (tplType) {
            parts.push(`{{ ${tplType} }}`);
            return;
          }
          if (elem.tagName === "BR") {
            parts.push("\n");
            return;
          }
          if (elem.tagName === "DIV" && elem !== el && parts.length > 0) {
            const lastChar = parts[parts.length - 1];
            if (lastChar && !lastChar.endsWith("\n")) {
              parts.push("\n");
            }
          }
          for (const child of elem.childNodes) {
            walk(child);
          }
        }
      };
      walk(el);
      return parts.join("").trim();
    }, []);

    const clear = useCallback(() => {
      if (editorRef.current) {
        editorRef.current.innerHTML = "";
      }
    }, []);

    const focus = useCallback(() => {
      editorRef.current?.focus();
    }, []);

    // ── Markdown: inline auto-render ──────────────────────────────────

    const revertCallback = useCallback(() => {
      onChange?.(getText());
    }, [onChange, getText]);

    /** Detect completed markdown pattern at cursor and render it */
    const maybeReplaceInlineMarkdown = useCallback(() => {
      if (!markdownEnabled) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const el = editorRef.current;
      if (!el) return;

      const text = node.textContent ?? "";
      const cursor = range.startOffset;
      const before = text.slice(0, cursor);

      for (const { re, tag, cls, trigger } of MD_PATTERNS) {
        // Quick check: text must end with the trigger chars
        if (!before.endsWith(trigger.slice(-1))) continue;
        const m = re.exec(before);
        if (!m) continue;

        const content = m[1] ?? m[2];
        const raw = m[0].startsWith("*") || m[0].startsWith("~") || m[0].startsWith("`") ? m[0] : m[0].slice(1);
        // For italic pattern, the match may include a leading char
        const fullMatch = m[0];
        const leadingExtra = fullMatch.length - raw.length;
        const matchStart = m.index + leadingExtra;
        const matchEnd = cursor;

        const mdEl = createMdElement(tag, S[cls] ?? "", content, raw, el, revertCallback);

        // Split text node
        const afterText = text.slice(matchEnd);
        const beforeText = text.slice(0, matchStart);
        node.textContent = beforeText;

        const parent = node.parentNode!;
        const nextSib = node.nextSibling;
        parent.insertBefore(mdEl, nextSib);

        const trailing = document.createTextNode(afterText || "\u00A0");
        parent.insertBefore(trailing, mdEl.nextSibling);

        // Place cursor after
        const newRange = document.createRange();
        newRange.setStart(trailing, afterText ? 0 : 1);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        break;
      }
    }, [markdownEnabled, revertCallback]);

    // ── Markdown: floating toolbar on selection ────────────────────────

    /** Apply markdown formatting to current selection */
    const applyFormat = useCallback((wrapper: string) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

      const range = sel.getRangeAt(0);
      const selectedText = range.toString();
      if (!selectedText) return;

      const raw = `${wrapper}${selectedText}${wrapper}`;

      // Determine tag and class
      let tag = "span";
      let cls = "";
      if (wrapper === "**") { tag = "strong"; cls = "mdBold"; }
      else if (wrapper === "*") { tag = "em"; cls = "mdItalic"; }
      else if (wrapper === "~~") { tag = "s"; cls = "mdStrike"; }
      else if (wrapper === "`") { tag = "code"; cls = "mdCode"; }

      const mdEl = createMdElement(tag, S[cls] ?? "", selectedText, raw, el, revertCallback);

      range.deleteContents();
      range.insertNode(mdEl);

      // Add space after and place cursor
      const space = document.createTextNode("\u00A0");
      mdEl.after(space);
      const newRange = document.createRange();
      newRange.setStartAfter(space);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      setToolbar(null);
      onChange?.(getText());
    }, [revertCallback, onChange, getText]);

    /** Track text selection to show/hide floating toolbar */
    useEffect(() => {
      if (!markdownEnabled) {
        setToolbar(null);
        return;
      }

      const onSelChange = () => {
        const sel = window.getSelection();
        const el = editorRef.current;
        const wrap = wrapperRef.current;
        if (!sel || !el || !wrap || sel.isCollapsed || sel.rangeCount === 0) {
          setToolbar(null);
          return;
        }
        // Check selection is inside our editor
        if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) {
          setToolbar(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        if (rect.width === 0) {
          setToolbar(null);
          return;
        }
        setToolbar({
          top: rect.top - wrapRect.top - 36,
          left: rect.left - wrapRect.left + rect.width / 2,
        });
      };

      document.addEventListener("selectionchange", onSelChange);
      return () => document.removeEventListener("selectionchange", onSelChange);
    }, [markdownEnabled]);

    // When markdownEnabled toggles OFF, revert all md elements to raw text
    useEffect(() => {
      if (markdownEnabled) return;
      const el = editorRef.current;
      if (!el) return;
      const mdEls = el.querySelectorAll("[data-md-raw]");
      mdEls.forEach(mdEl => {
        const raw = mdEl.getAttribute("data-md-raw") ?? mdEl.textContent ?? "";
        mdEl.replaceWith(document.createTextNode(raw));
      });
      el.normalize(); // merge adjacent text nodes
    }, [markdownEnabled]);

    // ── Metric slash insertion ─────────────────────────────────────────

    const insertMetric = useCallback((metric: InlineMetric) => {
      const el = editorRef.current;
      if (!el) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const offset = range.startOffset;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        let slashPos = offset - 1;
        while (slashPos >= 0 && text[slashPos] !== "/") slashPos--;
        if (slashPos >= 0) {
          node.textContent = text.slice(0, slashPos) + text.slice(offset);
          range.setStart(node, slashPos);
          range.setEnd(node, slashPos);
        }
      }

      const chip = document.createElement("span");
      chip.className = S.resolvedPlaceholder;
      chip.contentEditable = "false";
      chip.setAttribute("data-resolved-type", "metric");
      chip.setAttribute("data-resolved-label", metric.name);
      chip.setAttribute("data-resolved-id", String(metric.id));
      chip.textContent = metric.name;

      chip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slashNode = document.createTextNode("/");
        chip.replaceWith(slashNode);
        const r = document.createRange();
        r.setStartAfter(slashNode);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        el.focus();
        onChange?.(getText());
        onSlashQueryChange?.("");
      });

      range.deleteContents();
      range.insertNode(chip);
      const space = document.createTextNode("\u00A0");
      chip.after(space);
      const newRange = document.createRange();
      newRange.setStartAfter(space);
      newRange.setEndAfter(space);
      sel.removeAllRanges();
      sel.addRange(newRange);

      onChange?.(getText());
    }, [onChange, getText, onSlashQueryChange]);

    // ── Template placeholder chips ────────────────────────────────────

    const createPlaceholderChip = useCallback((varType: TemplatePlaceholderType): HTMLSpanElement => {
      const id = `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const chip = document.createElement("span");
      chip.className = S.templatePlaceholder;
      chip.contentEditable = "false";
      chip.setAttribute("data-template-type", varType);
      chip.setAttribute("data-placeholder-id", id);

      const plus = document.createElement("span");
      plus.className = S.templatePlaceholderIcon;
      plus.textContent = "+";
      chip.appendChild(plus);

      const label = document.createTextNode(PLACEHOLDER_LABELS[varType] ?? varType);
      chip.appendChild(label);

      chip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onTemplatePlaceholderClick?.(varType, id);
      });

      return chip;
    }, [onTemplatePlaceholderClick]);

    const insertTemplate = useCallback((text: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.innerHTML = "";

      const TEMPLATE_RE = /\{\{\s*(\w+)\s*\}\}/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = TEMPLATE_RE.exec(text)) !== null) {
        if (match.index > lastIndex) {
          el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const varName = match[1].toLowerCase() as TemplatePlaceholderType;
        if (varName in PLACEHOLDER_LABELS) {
          el.appendChild(createPlaceholderChip(varName));
        } else {
          el.appendChild(document.createTextNode(match[0]));
        }
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) {
        el.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      onChange?.(getText());
    }, [createPlaceholderChip, onChange, getText]);

    const createResolvedChip = useCallback((varType: string, placeholderId: string, label: string, resolvedId?: number): HTMLSpanElement => {
      const resolved = document.createElement("span");
      resolved.className = S.resolvedPlaceholder;
      resolved.contentEditable = "false";
      resolved.setAttribute("data-resolved-type", varType);
      resolved.setAttribute("data-resolved-label", label);
      resolved.setAttribute("data-placeholder-id", placeholderId);
      resolved.setAttribute("data-template-type", varType);
      if (resolvedId != null) {
        resolved.setAttribute("data-resolved-id", String(resolvedId));
      }
      resolved.textContent = label;

      resolved.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const newPlaceholder = createPlaceholderChip(varType as TemplatePlaceholderType);
        resolved.replaceWith(newPlaceholder);
        onChange?.(getText());
        onTemplatePlaceholderClick?.(varType as TemplatePlaceholderType, newPlaceholder.getAttribute("data-placeholder-id")!);
      });

      return resolved;
    }, [createPlaceholderChip, onChange, getText, onTemplatePlaceholderClick]);

    const replaceTemplatePlaceholder = useCallback((placeholderId: string, label: string, resolvedId?: number) => {
      const el = editorRef.current;
      if (!el) return;
      const chip = el.querySelector(`[data-placeholder-id="${placeholderId}"]`);
      if (!chip) return;

      const varType = chip.getAttribute("data-template-type") ?? "";
      const resolved = createResolvedChip(varType, placeholderId, label, resolvedId);
      chip.replaceWith(resolved);

      onChange?.(getText());
    }, [createResolvedChip, onChange, getText]);

    useImperativeHandle(ref, () => ({
      focus,
      serialize,
      clear,
      insertMetric,
      getText,
      insertTemplate,
      replaceTemplatePlaceholder,
    }));

    // ── Input handlers ────────────────────────────────────────────────

    const maybeReplaceInlineTemplate = useCallback(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent ?? "";
      const cursor = range.startOffset;

      if (cursor < 5 || text.slice(cursor - 2, cursor) !== "}}") return;

      const before = text.slice(0, cursor);
      const matchRe = /\{\{\s*(\w+)\s*\}\}$/;
      const m = matchRe.exec(before);
      if (!m) return;

      const varName = m[1].toLowerCase() as TemplatePlaceholderType;
      if (!(varName in PLACEHOLDER_LABELS)) return;

      const matchStart = m.index;
      const matchEnd = cursor;
      const chip = createPlaceholderChip(varName);
      const afterText = text.slice(matchEnd);
      const beforeText = text.slice(0, matchStart);

      node.textContent = beforeText;
      const parent = node.parentNode!;
      const nextSibling = node.nextSibling;
      parent.insertBefore(chip, nextSibling);
      const trailing = document.createTextNode(afterText || "\u00A0");
      parent.insertBefore(trailing, chip.nextSibling);

      const newRange = document.createRange();
      newRange.setStart(trailing, afterText ? 0 : 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }, [createPlaceholderChip]);

    const handleInput = useCallback(() => {
      if (isComposing.current) return;
      const text = getText();
      onChange?.(text);

      maybeReplaceInlineTemplate();
      maybeReplaceInlineMarkdown();

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const query = getSlashQuery(range.startContainer, range.startOffset);
        onSlashQueryChange?.(query);
      }
    }, [getText, onChange, onSlashQueryChange, maybeReplaceInlineTemplate, maybeReplaceInlineMarkdown]);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");

        const TEMPLATE_RE = /\{\{\s*(\w+)\s*\}\}/;
        if (!TEMPLATE_RE.test(text)) {
          document.execCommand("insertText", false, text);
          return;
        }

        const el = editorRef.current;
        if (!el) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();

        const TEMPLATE_RE_G = /\{\{\s*(\w+)\s*\}\}/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        const frag = document.createDocumentFragment();

        while ((match = TEMPLATE_RE_G.exec(text)) !== null) {
          if (match.index > lastIndex) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          const varName = match[1].toLowerCase() as TemplatePlaceholderType;
          if (varName in PLACEHOLDER_LABELS) {
            frag.appendChild(createPlaceholderChip(varName));
          } else {
            frag.appendChild(document.createTextNode(match[0]));
          }
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        range.insertNode(frag);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);

        onChange?.(getText());
      },
      [createPlaceholderChip, onChange, getText],
    );

    const isEmpty = getText().length === 0;

    return (
      <div ref={wrapperRef} className={`${S.wrapper} ${className ?? ""}`} style={{ position: "relative" }}>
        {/* Floating format toolbar */}
        {toolbar && markdownEnabled && (
          <div
            className={S.floatingToolbar}
            style={{ top: toolbar.top, left: toolbar.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button className={S.fmtBtn} onMouseDown={() => applyFormat("**")} title="Bold">
              <strong>B</strong>
            </button>
            <button className={S.fmtBtn} onMouseDown={() => applyFormat("*")} title="Italic">
              <em>I</em>
            </button>
            <button className={S.fmtBtn} onMouseDown={() => applyFormat("~~")} title="Strikethrough">
              <s>S</s>
            </button>
            <button className={S.fmtBtn} onMouseDown={() => applyFormat("`")} title="Code">
              <code>&lt;/&gt;</code>
            </button>
          </div>
        )}
        <div
          ref={editorRef}
          className={`${S.editor} ${disabled ? S.disabled : ""}`}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => {
            isComposing.current = false;
            handleInput();
          }}
          role="textbox"
          aria-multiline
          aria-placeholder={placeholder}
          data-placeholder={isEmpty ? placeholder : undefined}
        />
      </div>
    );
  },
);
