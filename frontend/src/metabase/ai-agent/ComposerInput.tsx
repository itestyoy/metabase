import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";

import S from "./ComposerInput.module.css";

export interface InlineMetric {
  id: number;
  name: string;
}

export interface ComposerInputHandle {
  focus: () => void;
  serialize: () => string;
  clear: () => void;
  /** Insert metric chip, replacing "/query" text before cursor. Focus stays in editor. */
  insertMetric: (metric: InlineMetric) => void;
  getText: () => string;
}

interface ComposerInputProps {
  placeholder?: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onChange?: (text: string) => void;
  /** Called when slash query changes. null = no active slash command. */
  onSlashQueryChange?: (query: string | null) => void;
  className?: string;
}

/**
 * Extract slash-command query from a text node at cursor position.
 * Returns text after "/" or null if not in a slash command.
 */
function getSlashQuery(node: Node, offset: number): string | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  // Walk backwards from cursor to find "/"
  let i = offset - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "/") {
      if (i === 0 || text[i - 1] === " " || text[i - 1] === "\n" || text[i - 1] === "\u00A0") {
        return text.slice(i + 1, offset);
      }
      return null;
    }
    if (ch === " " || ch === "\n") return null;
    i--;
  }
  return null;
}

export const ComposerInput = forwardRef<ComposerInputHandle, ComposerInputProps>(
  function ComposerInput(
    { placeholder, disabled, onKeyDown, onChange, onSlashQueryChange, className },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);

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
          const metricId = elem.getAttribute("data-metric-id");
          if (metricId) {
            const name = elem.getAttribute("data-metric-name") ?? elem.textContent;
            parts.push(`["metric", ${metricId}] /* ${name} */`);
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

    const insertMetric = useCallback((metric: InlineMetric) => {
      // Focus is ALREADY in this editor (never lost), so getSelection works directly
      const el = editorRef.current;
      if (!el) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const offset = range.startOffset;

      // Remove "/query" text before cursor
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        let slashPos = offset - 1;
        while (slashPos >= 0 && text[slashPos] !== "/") {
          slashPos--;
        }
        if (slashPos >= 0) {
          node.textContent = text.slice(0, slashPos) + text.slice(offset);
          range.setStart(node, slashPos);
          range.setEnd(node, slashPos);
        }
      }

      // Create chip
      const chip = document.createElement("span");
      chip.className = S.metricChip;
      chip.contentEditable = "false";
      chip.setAttribute("data-metric-id", String(metric.id));
      chip.setAttribute("data-metric-name", metric.name);

      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("width", "12");
      icon.setAttribute("height", "12");
      icon.style.flexShrink = "0";
      icon.innerHTML = '<path fill-rule="evenodd" clip-rule="evenodd" d="M10.562 5.499 12.25 3.81v8.439H3.81L5.5 10.562l.915.915 1.063-1.063-.915-.915.937-.937.915.915 1.063-1.063-.915-.915.937-.937.915.915 1.063-1.063-.915-.915Zm3.188-2.775c0-.935-1.131-1.404-1.793-.742l-9.975 9.976c-.662.661-.193 1.792.742 1.792H13.75V2.724Z" fill="currentColor"/>';
      chip.appendChild(icon);

      const label = document.createTextNode(metric.name);
      chip.appendChild(label);

      const closeBtn = document.createElement("span");
      closeBtn.className = S.metricChipClose;
      closeBtn.textContent = "×";
      closeBtn.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        chip.remove();
        onChange?.(getText());
      });
      chip.appendChild(closeBtn);

      // Insert at cursor
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
    }, [onChange, getText]);

    useImperativeHandle(ref, () => ({
      focus,
      serialize,
      clear,
      insertMetric,
      getText,
    }));

    const handleInput = useCallback(() => {
      if (isComposing.current) return;
      const text = getText();
      onChange?.(text);

      // Detect slash query for metric picker
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const query = getSlashQuery(range.startContainer, range.startOffset);
        onSlashQueryChange?.(query);
      }
    }, [getText, onChange, onSlashQueryChange]);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      },
      [],
    );

    const isEmpty = getText().length === 0;

    return (
      <div className={`${S.wrapper} ${className ?? ""}`}>
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
