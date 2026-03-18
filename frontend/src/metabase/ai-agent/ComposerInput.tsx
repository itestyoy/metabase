import {
  forwardRef,
  useCallback,
  useEffect,
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
  /** Serialize content to plain text, converting metric chips to ["metric", ID] */
  serialize: () => string;
  /** Clear all content */
  clear: () => void;
  /** Insert a metric chip at the current cursor position */
  insertMetric: (metric: InlineMetric) => void;
  /** Remove the last "/" character before cursor (used before inserting metric) */
  removeSlashBeforeCursor: () => void;
  /** Get raw text (for checking empty state) */
  getText: () => string;
}

interface ComposerInputProps {
  placeholder?: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onChange?: (text: string) => void;
  onSlashTyped?: () => void;
  className?: string;
}

export const ComposerInput = forwardRef<ComposerInputHandle, ComposerInputProps>(
  function ComposerInput(
    { placeholder, disabled, onKeyDown, onChange, onSlashTyped, className },
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
          // Metric chip
          const metricId = elem.getAttribute("data-metric-id");
          if (metricId) {
            const name = elem.getAttribute("data-metric-name") ?? elem.textContent;
            parts.push(`["metric", ${metricId}] /* ${name} */`);
            return; // don't recurse into chip
          }
          // <br> → newline
          if (elem.tagName === "BR") {
            parts.push("\n");
            return;
          }
          // Block-level elements get newlines (except first)
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
      const el = editorRef.current;
      if (!el) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        el.focus();
      }

      const chip = document.createElement("span");
      chip.className = S.metricChip;
      chip.contentEditable = "false";
      chip.setAttribute("data-metric-id", String(metric.id));
      chip.setAttribute("data-metric-name", metric.name);
      chip.textContent = metric.name;

      // Add × button
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
      const range = sel?.getRangeAt(0);
      if (range) {
        range.deleteContents();
        range.insertNode(chip);
        // Add a space after chip and move cursor there
        const space = document.createTextNode("\u00A0");
        chip.after(space);
        range.setStartAfter(space);
        range.setEndAfter(space);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }

      onChange?.(getText());
    }, [onChange, getText]);

    const removeSlashBeforeCursor = useCallback(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const offset = range.startOffset;

      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
        const text = node.textContent ?? "";
        // Find the "/" before cursor
        const slashPos = text.lastIndexOf("/", offset - 1);
        if (slashPos >= 0) {
          // Remove from slash to cursor (the "/" and any search text after it)
          node.textContent = text.slice(0, slashPos) + text.slice(offset);
          // Restore cursor position
          const newRange = document.createRange();
          newRange.setStart(node, slashPos);
          newRange.setEnd(node, slashPos);
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
      }
    }, []);

    useImperativeHandle(ref, () => ({
      focus,
      serialize,
      clear,
      insertMetric,
      removeSlashBeforeCursor,
      getText,
    }));

    const handleInput = useCallback(() => {
      if (isComposing.current) return;
      const text = getText();
      onChange?.(text);

      // Check if "/" was just typed
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node.nodeType === Node.TEXT_NODE && offset > 0) {
          const char = (node.textContent ?? "")[offset - 1];
          const charBefore = offset > 1 ? (node.textContent ?? "")[offset - 2] : undefined;
          if (
            char === "/" &&
            (offset === 1 || charBefore === " " || charBefore === "\n" || charBefore === "\u00A0")
          ) {
            onSlashTyped?.();
          }
        }
      }
    }, [getText, onChange, onSlashTyped]);

    // Handle paste — strip HTML, keep plain text
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
