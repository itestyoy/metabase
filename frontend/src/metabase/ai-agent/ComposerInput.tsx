import { Extension, Node, nodeInputRule } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import { EditorBubbleMenu } from "metabase/rich_text_editing/tiptap/components/EditorBubbleMenu/EditorBubbleMenu";
import type { FormattingOptions } from "metabase/rich_text_editing/tiptap/components/EditorBubbleMenu/types";
import { CustomStarterKit } from "metabase/rich_text_editing/tiptap/extensions/CustomStarterKit/CustomStarterKit";

import S from "./ComposerInput.module.css";

// ── Types ────────────────────────────────────────────────────────────────

export interface InlineMetric {
  id: number;
  name: string;
}

export type TemplatePlaceholderType =
  | "metric" | "question" | "model" | "table" | "dashboard"
  | "document" | "database" | "collection" | "datetime" | "input";

const PLACEHOLDER_LABELS: Record<TemplatePlaceholderType, string> = {
  metric: "Metric", question: "Question", model: "Model", table: "Table",
  dashboard: "Dashboard", document: "Document", database: "Database",
  collection: "Collection", datetime: "Date / Period", input: "Text…",
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
  onTemplatePlaceholderClick?: (placeholderType: TemplatePlaceholderType, placeholderId: string, rect?: DOMRect) => void;
  className?: string;
}

// ── Bubble menu config ───────────────────────────────────────────────────

const ALLOWED_FORMATTING: FormattingOptions = {
  bold: true,
  italic: true,
  strikethrough: true,
  h1: true,
  h2: true,
  h3: true,
  inline_code: true,
  code_block: true,
  list: true,
  ordered_list: true,
  quote: true,
};

// ── Custom Tiptap Nodes ──────────────────────────────────────────────────

function genId(): string {
  return `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Unfilled template placeholder chip: +Metric, +Table, etc. */
const TemplatePlaceholderNode = Node.create({
  name: "templatePlaceholder",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      varType: { default: "metric" },
      placeholderId: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-tpl-type]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-tpl-type": HTMLAttributes.varType }, 0];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span");
      dom.className = S.templatePlaceholder;
      dom.contentEditable = "false";

      const plus = document.createElement("span");
      plus.className = S.templatePlaceholderIcon;
      plus.textContent = "+";
      dom.appendChild(plus);

      const label = document.createTextNode(
        PLACEHOLDER_LABELS[node.attrs.varType as TemplatePlaceholderType] ?? node.attrs.varType,
      );
      dom.appendChild(label);

      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ref = editor.storage.composerCallbacks?.ref;
        ref?.current?.onTemplatePlaceholderClick?.(node.attrs.varType, node.attrs.placeholderId, dom.getBoundingClientRect());
      });

      return { dom };
    };
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: /(\{\{\s*(\w+)\s*\}\})$/,
        type: this.type,
        getAttributes: (match) => {
          const varName = (match[2] ?? "").toLowerCase();
          if (!(varName in PLACEHOLDER_LABELS)) return false;
          return { varType: varName, placeholderId: genId() };
        },
      }),
    ];
  },
});

/** Filled/resolved placeholder chip */
const ResolvedPlaceholderNode = Node.create({
  name: "resolvedPlaceholder",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      resolvedType: { default: "metric" },
      label: { default: "" },
      resolvedId: { default: null },
      placeholderId: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-resolved-type]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-resolved-type": HTMLAttributes.resolvedType }, HTMLAttributes.label];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span");
      dom.className = S.resolvedPlaceholder;
      dom.contentEditable = "false";
      dom.textContent = node.attrs.label;

      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Save rect BEFORE replacing (dom will be detached after)
        const rect = dom.getBoundingClientRect();
        const pos = getPos();
        if (pos == null) return;
        const newId = genId();
        const varType = node.attrs.resolvedType;
        editor.chain().focus()
          .deleteRange({ from: pos, to: pos + 1 })
          .insertContentAt(pos, { type: "templatePlaceholder", attrs: { varType, placeholderId: newId } })
          .run();
        const ref = editor.storage.composerCallbacks?.ref;
        ref?.current?.onTemplatePlaceholderClick?.(varType, newId, rect);
      });

      return { dom };
    };
  },
});

/** Extension to store callback refs so NodeViews can access them */
const CallbacksStorage = Extension.create({
  name: "composerCallbacks",
  addStorage() {
    return { ref: null as React.MutableRefObject<Record<string, Function>> | null };
  },
});

// ── Serializer: Tiptap JSON → text with markdown ────────────────────────

interface JSONNode {
  type?: string;
  text?: string;
  marks?: { type: string }[];
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
}

function serializeDoc(doc: JSONNode): string {
  const lines: string[] = [];

  function walkInline(nodes: JSONNode[] | undefined): string {
    if (!nodes) return "";
    return nodes.map(n => {
      if (n.type === "text") {
        let t = n.text ?? "";
        if (n.marks) {
          for (const m of n.marks) {
            if (m.type === "code") t = `\`${t}\``;
            else if (m.type === "bold") t = `**${t}**`;
            else if (m.type === "italic") t = `*${t}*`;
            else if (m.type === "strike") t = `~~${t}~~`;
          }
        }
        return t;
      }
      if (n.type === "templatePlaceholder") {
        return `{{ ${(n.attrs?.varType as string) ?? "input"} }}`;
      }
      if (n.type === "resolvedPlaceholder") {
        const id = n.attrs?.resolvedId;
        const label = (n.attrs?.label as string) ?? "";
        const type = (n.attrs?.resolvedType as string) ?? "";
        if (id != null) return `["${type}", ${id}] /* ${label} */`;
        return label;
      }
      return "";
    }).join("");
  }

  function walkBlock(node: JSONNode, prefix = "") {
    switch (node.type) {
      case "paragraph":
        lines.push(prefix + walkInline(node.content));
        break;
      case "bulletList":
        (node.content ?? []).forEach(li => {
          const inner = (li.content ?? []).map(c => walkInline(c.content)).join("\n");
          lines.push(`${prefix}- ${inner}`);
        });
        break;
      case "orderedList":
        (node.content ?? []).forEach((li, i) => {
          const inner = (li.content ?? []).map(c => walkInline(c.content)).join("\n");
          lines.push(`${prefix}${i + 1}. ${inner}`);
        });
        break;
      case "blockquote":
        (node.content ?? []).forEach(c => walkBlock(c, "> "));
        break;
      case "codeBlock":
        lines.push("```");
        lines.push(walkInline(node.content) || ((node.attrs?.content as string) ?? ""));
        lines.push("```");
        break;
      case "heading": {
        const level = (node.attrs?.level as number) ?? 1;
        lines.push(`${"#".repeat(level)} ${walkInline(node.content)}`);
        break;
      }
      default:
        if (node.content) node.content.forEach(c => walkBlock(c, prefix));
    }
  }

  if (doc.content) doc.content.forEach(c => walkBlock(c));
  return lines.join("\n").trim();
}

// ── Parse template string to Tiptap content ─────────────────────────────

function parseTemplateToContent(text: string): JSONNode {
  const TEMPLATE_RE = /\{\{\s*(\w+)\s*\}\}/g;
  const inlineContent: JSONNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TEMPLATE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      inlineContent.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const varName = match[1].toLowerCase();
    if (varName in PLACEHOLDER_LABELS) {
      inlineContent.push({
        type: "templatePlaceholder",
        attrs: { varType: varName, placeholderId: genId() },
      });
    } else {
      inlineContent.push({ type: "text", text: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    inlineContent.push({ type: "text", text: text.slice(lastIndex) });
  }

  return { type: "doc", content: [{ type: "paragraph", content: inlineContent }] };
}

// ── Component ────────────────────────────────────────────────────────────

export const ComposerInput = forwardRef<ComposerInputHandle, ComposerInputProps>(
  function ComposerInput(
    { placeholder, disabled, markdownEnabled, onKeyDown, onChange, onSlashQueryChange, onTemplatePlaceholderClick, className },
    ref,
  ) {
    // Refs for callbacks so Tiptap NodeViews can access latest versions
    const callbacksRef = useRef({
      onTemplatePlaceholderClick: onTemplatePlaceholderClick as Function | undefined,
      onSlashQueryChange: onSlashQueryChange as Function | undefined,
      onChange: onChange as Function | undefined,
    });
    useEffect(() => {
      callbacksRef.current = { onTemplatePlaceholderClick, onSlashQueryChange, onChange };
    });

    const extensions = useMemo(
      () => [
        CallbacksStorage,
        CustomStarterKit.configure({
          link: false,
          trailingNode: false,
          heading: { levels: [1, 2, 3] },
          horizontalRule: false,
        }),
        Placeholder.configure({ placeholder: placeholder ?? "" }),
        TemplatePlaceholderNode,
        ResolvedPlaceholderNode,
        // Enter sends, Shift+Enter inserts newline
        Extension.create({
          name: "SendOnEnter",
          addKeyboardShortcuts() {
            return {
              Enter: () => {
                // Delegate to parent onKeyDown via a synthetic-like approach
                // Return false to let the default behavior happen (we handle send in AgentModal)
                return false;
              },
            };
          },
        }),
      ],
      [placeholder],
    );

    const editor = useEditor(
      {
        extensions,
        content: "",
        editable: !disabled,
        immediatelyRender: true,
        onUpdate: ({ editor: ed }) => {
          const text = ed.getText();
          callbacksRef.current.onChange?.(text);

          // Slash query detection
          const { from } = ed.state.selection;
          const textBefore = ed.state.doc.textBetween(Math.max(0, from - 100), from, "\0");
          const slashMatch = textBefore.match(/(?:^|[\s\n\0])\/([^\s\n\0]*)$/);
          callbacksRef.current.onSlashQueryChange?.(slashMatch ? slashMatch[1] : null);
        },
      },
      [disabled],
    );

    // Attach callback ref to editor storage
    useEffect(() => {
      if (editor) {
        editor.storage.composerCallbacks = { ref: callbacksRef };
      }
    }, [editor]);

    // ── Handle methods ──────────────────────────────────────────────────

    const getText = useCallback(() => editor?.getText() ?? "", [editor]);

    const serialize = useCallback(() => {
      if (!editor) return "";
      return serializeDoc(editor.getJSON() as JSONNode);
    }, [editor]);

    const clear = useCallback(() => {
      editor?.commands.clearContent(true);
    }, [editor]);

    const focus = useCallback(() => {
      editor?.commands.focus();
    }, [editor]);

    const insertMetric = useCallback(
      (metric: InlineMetric) => {
        if (!editor) return;
        // Remove /query text before cursor
        const { from } = editor.state.selection;
        const textBefore = editor.state.doc.textBetween(Math.max(0, from - 100), from, "\0");
        const slashIdx = textBefore.lastIndexOf("/");
        if (slashIdx >= 0) {
          const deleteFrom = from - (textBefore.length - slashIdx);
          editor.chain().focus()
            .deleteRange({ from: deleteFrom, to: from })
            .insertContent({
              type: "resolvedPlaceholder",
              attrs: { resolvedType: "metric", label: metric.name, resolvedId: metric.id, placeholderId: genId() },
            })
            .insertContent(" ")
            .run();
        }
      },
      [editor],
    );

    const insertTemplate = useCallback(
      (text: string) => {
        if (!editor) return;
        const content = parseTemplateToContent(text);
        editor.chain().focus().setContent(content).run();
      },
      [editor],
    );

    const replaceTemplatePlaceholder = useCallback(
      (placeholderId: string, label: string, resolvedId?: number) => {
        if (!editor) return;
        let targetPos: number | null = null;
        let targetType = "";
        editor.state.doc.descendants((node, pos) => {
          if (
            node.type.name === "templatePlaceholder" &&
            node.attrs.placeholderId === placeholderId
          ) {
            targetPos = pos;
            targetType = node.attrs.varType;
            return false;
          }
        });
        if (targetPos !== null) {
          editor.chain().focus()
            .deleteRange({ from: targetPos, to: targetPos + 1 })
            .insertContentAt(targetPos, {
              type: "resolvedPlaceholder",
              attrs: { resolvedType: targetType, label, resolvedId: resolvedId ?? null, placeholderId },
            })
            .run();
        }
      },
      [editor],
    );

    useImperativeHandle(ref, () => ({
      focus,
      serialize,
      clear,
      insertMetric,
      getText,
      insertTemplate,
      replaceTemplatePlaceholder,
    }));

    if (!editor) return null;

    return (
      <div className={`${S.wrapper} ${className ?? ""}`}>
        <div className={S.editorContent}>
          <EditorContent editor={editor} onKeyDownCapture={onKeyDown} />
        </div>
        {markdownEnabled && (
          <EditorBubbleMenu
            className={S.bubbleMenu}
            editor={editor}
            disallowedNodes={["templatePlaceholder", "resolvedPlaceholder"]}
            allowedFormatting={ALLOWED_FORMATTING}
            options={{ placement: "top" }}
          />
        )}
      </div>
    );
  },
);
