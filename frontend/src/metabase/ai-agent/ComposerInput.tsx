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
  insertMetric: (metric: InlineMetric) => void;
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
    // Saved cursor range — captured when "/" is typed, restored when metric is inserted
    const savedRange = useRef<Range | null>(null);

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
      savedRange.current = null;
    }, []);

    const focus = useCallback(() => {
      editorRef.current?.focus();
    }, []);

    const insertMetric = useCallback((metric: InlineMetric) => {
      const el = editorRef.current;
      if (!el) return;

      // Restore saved cursor position (from when "/" was typed)
      const range = savedRange.current;
      if (!range) {
        // Fallback: append to end
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const fallbackRange = document.createRange();
          fallbackRange.selectNodeContents(el);
          fallbackRange.collapse(false);
          sel.removeAllRanges();
          sel.addRange(fallbackRange);
        }
      } else {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      // Now remove the "/" before cursor
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const curRange = sel.getRangeAt(0);
        const node = curRange.startContainer;
        const offset = curRange.startOffset;

        if (node.nodeType === Node.TEXT_NODE && offset > 0) {
          const text = node.textContent ?? "";
          const slashPos = text.lastIndexOf("/", offset - 1);
          if (slashPos >= 0) {
            node.textContent = text.slice(0, slashPos) + text.slice(offset);
            const newRange = document.createRange();
            newRange.setStart(node, slashPos);
            newRange.setEnd(node, slashPos);
            sel.removeAllRanges();
            sel.addRange(newRange);
          }
        }
      }

      // Create chip element
      const chip = document.createElement("span");
      chip.className = S.metricChip;
      chip.contentEditable = "false";
      chip.setAttribute("data-metric-id", String(metric.id));
      chip.setAttribute("data-metric-name", metric.name);
      chip.textContent = metric.name;

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

      // Insert chip at cursor
      const sel2 = window.getSelection();
      if (sel2 && sel2.rangeCount > 0) {
        const insertRange = sel2.getRangeAt(0);
        insertRange.deleteContents();
        insertRange.insertNode(chip);
        const space = document.createTextNode("\u00A0");
        chip.after(space);
        insertRange.setStartAfter(space);
        insertRange.setEndAfter(space);
        sel2.removeAllRanges();
        sel2.addRange(insertRange);
      }

      savedRange.current = null;
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

      // Check if "/" was just typed — save cursor position
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
            savedRange.current = range.cloneRange();
            onSlashTyped?.();
          }
        }
      }
    }, [getText, onChange, onSlashTyped]);

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
