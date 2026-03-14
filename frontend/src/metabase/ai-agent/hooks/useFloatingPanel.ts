import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export type ResizeEdge = "left" | "top" | "bottom-right";

export interface PanelConstraints {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** Height of the app bar that the panel must stay below. */
  appbarHeight: number;
  /** Height of the header-only (minimized) state. */
  minimizedHeight: number;
  /** Minimum distance from any viewport edge. */
  edgeBuffer: number;
}

export interface PanelState {
  right: number;
  bottom: number;
  width: number;
  height: number;
  isMinimized: boolean;
  /** True while the user is dragging or resizing — used to disable transitions / text selection. */
  isInteracting: boolean;
}

// ── Reducer actions ──────────────────────────────────────────────────────────

interface DragMoveAction {
  type: "DRAG_MOVE";
  clientX: number;
  clientY: number;
  vw: number;
  vh: number;
  dragOffset: { offsetX: number; offsetY: number };
  constraints: PanelConstraints;
}

interface ResizeMoveAction {
  type: "RESIZE_MOVE";
  clientX: number;
  clientY: number;
  vw: number;
  vh: number;
  resizeOrigin: ResizeOriginData;
  constraints: PanelConstraints;
}

interface ToggleMinimizedAction {
  type: "TOGGLE_MINIMIZED";
  constraints: PanelConstraints;
}

interface SetInteractingAction {
  type: "SET_INTERACTING";
  value: boolean;
}

interface ViewportResizeAction {
  type: "VIEWPORT_RESIZE";
  vw: number;
  vh: number;
  constraints: PanelConstraints;
}

type PanelAction =
  | DragMoveAction
  | ResizeMoveAction
  | ToggleMinimizedAction
  | SetInteractingAction
  | ViewportResizeAction;

// ── Transient interaction data (not render-driving, stored in refs) ──────────

interface DragOffsetData {
  offsetX: number;
  offsetY: number;
}

interface ResizeOriginData {
  fixedRight: number;
  fixedBottom: number;
  fixedLeft: number;
  fixedTop: number;
  edge: ResizeEdge;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const PANEL_STORAGE_KEY = "bi-agent-panel";

function readSavedPanel(): Partial<PanelState> | null {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PanelState>;
  } catch {
    return null;
  }
}

function savePanelState(s: PanelState) {
  try {
    const { isInteracting: _, ...rest } = s;
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // storage unavailable
  }
}

/** Compute initial panel geometry that always fits within the viewport. */
function computeInitialState(c: PanelConstraints): PanelState {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const saved = readSavedPanel();

  const width = clamp(
    saved?.width ?? c.minWidth,
    c.minWidth,
    Math.max(c.minWidth, vw - 2 * c.edgeBuffer),
  );
  const height = clamp(
    saved?.height ?? c.minHeight,
    c.minHeight,
    Math.max(c.minHeight, vh - c.appbarHeight - 2 * c.edgeBuffer),
  );
  const right = clamp(
    saved?.right ?? c.edgeBuffer + 20,
    c.edgeBuffer,
    Math.max(c.edgeBuffer, vw - width - c.edgeBuffer),
  );
  const renderedHeight = (saved?.isMinimized ?? false) ? c.minimizedHeight : height;
  const bottom = clamp(
    saved?.bottom ?? Math.max(c.edgeBuffer, vh - c.appbarHeight - height - c.edgeBuffer),
    c.edgeBuffer,
    Math.max(c.edgeBuffer, vh - renderedHeight - c.appbarHeight - c.edgeBuffer),
  );

  return {
    right,
    bottom,
    width,
    height,
    isMinimized: saved?.isMinimized ?? false,
    isInteracting: false,
  };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "DRAG_MOVE": {
      const { clientX, clientY, vw, vh, dragOffset, constraints: c } = action;
      const renderedHeight = state.isMinimized ? c.minimizedHeight : state.height;
      const modalLeft = clientX - dragOffset.offsetX;
      const modalTop = clientY - dragOffset.offsetY;
      return {
        ...state,
        right: clamp(
          vw - modalLeft - state.width,
          c.edgeBuffer,
          vw - state.width - c.edgeBuffer,
        ),
        bottom: clamp(
          vh - modalTop - renderedHeight,
          c.edgeBuffer,
          vh - renderedHeight - c.appbarHeight - c.edgeBuffer,
        ),
      };
    }

    case "RESIZE_MOVE": {
      const { clientX, clientY, vw, vh, resizeOrigin: r, constraints: c } = action;
      if (r.edge === "left") {
        const maxWidth = Math.min(c.maxWidth, r.fixedRight - c.edgeBuffer);
        const newWidth = clamp(r.fixedRight - clientX, c.minWidth, maxWidth);
        return { ...state, width: newWidth };
      }
      if (r.edge === "top") {
        const maxHeight = Math.min(c.maxHeight, r.fixedBottom - c.appbarHeight - c.edgeBuffer);
        const newHeight = clamp(r.fixedBottom - clientY, c.minHeight, maxHeight);
        return { ...state, height: newHeight };
      }
      // bottom-right: left+top edges fixed, right+bottom follow cursor
      const maxWidth = Math.min(c.maxWidth, vw - c.edgeBuffer - r.fixedLeft);
      const maxHeight = Math.min(c.maxHeight, vh - c.edgeBuffer - r.fixedTop);
      const newWidth = clamp(clientX - r.fixedLeft, c.minWidth, maxWidth);
      const newHeight = clamp(clientY - r.fixedTop, c.minHeight, maxHeight);
      return {
        ...state,
        width: newWidth,
        height: newHeight,
        right: Math.max(c.edgeBuffer, vw - r.fixedLeft - newWidth),
        bottom: Math.max(c.edgeBuffer, vh - r.fixedTop - newHeight),
      };
    }

    case "TOGGLE_MINIMIZED": {
      // Keep the top edge fixed: adjust bottom so the panel collapses/expands upward.
      const c = action.constraints;
      const currentHeight = state.isMinimized ? c.minimizedHeight : state.height;
      const nextHeight = state.isMinimized ? state.height : c.minimizedHeight;
      const newBottom = Math.max(c.edgeBuffer, state.bottom + currentHeight - nextHeight);
      return { ...state, isMinimized: !state.isMinimized, bottom: newBottom };
    }

    case "SET_INTERACTING":
      return state.isInteracting === action.value
        ? state
        : { ...state, isInteracting: action.value };

    case "VIEWPORT_RESIZE": {
      const { vw, vh, constraints: cr } = action;
      const renderedHeight = state.isMinimized ? cr.minimizedHeight : state.height;
      const newWidth = clamp(state.width, cr.minWidth, Math.max(cr.minWidth, vw - 2 * cr.edgeBuffer));
      const newHeight = clamp(state.height, cr.minHeight, Math.max(cr.minHeight, vh - cr.appbarHeight - 2 * cr.edgeBuffer));
      const newRight = clamp(state.right, cr.edgeBuffer, Math.max(cr.edgeBuffer, vw - newWidth - cr.edgeBuffer));
      const newBottom = clamp(state.bottom, cr.edgeBuffer, Math.max(cr.edgeBuffer, vh - renderedHeight - cr.appbarHeight - cr.edgeBuffer));
      if (newWidth === state.width && newHeight === state.height && newRight === state.right && newBottom === state.bottom) {
        return state;
      }
      return { ...state, width: newWidth, height: newHeight, right: newRight, bottom: newBottom };
    }

    default:
      return state;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useFloatingPanel(constraints: PanelConstraints) {
  const c = constraints;
  const [state, dispatch] = useReducer(panelReducer, c, computeInitialState);

  // Persist panel geometry to localStorage so it survives page reloads.
  useEffect(() => {
    if (!state.isInteracting) {
      savePanelState(state);
    }
  }, [state]);

  // Re-clamp position when the browser window is resized.
  useEffect(() => {
    const handleResize = () => {
      dispatch({
        type: "VIEWPORT_RESIZE",
        vw: window.innerWidth,
        vh: window.innerHeight,
        constraints: c,
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [c]);

  // Transient interaction data — never drives rendering directly.
  const dragOffset = useRef<DragOffsetData | null>(null);
  const resizeOrigin = useRef<ResizeOriginData | null>(null);

  // ── Shared pointer handlers ────────────────────────────────────────────

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (dragOffset.current) {
        dispatch({
          type: "DRAG_MOVE",
          clientX: e.clientX,
          clientY: e.clientY,
          vw,
          vh,
          dragOffset: dragOffset.current,
          constraints: c,
        });
        return;
      }

      if (resizeOrigin.current) {
        dispatch({
          type: "RESIZE_MOVE",
          clientX: e.clientX,
          clientY: e.clientY,
          vw,
          vh,
          resizeOrigin: resizeOrigin.current,
          constraints: c,
        });
      }
    },
    [c],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const target = e.currentTarget as Element;
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", onPointerMove as EventListener);
      target.removeEventListener("pointerup", onPointerUp as EventListener);
      dragOffset.current = null;
      resizeOrigin.current = null;
      document.body.style.userSelect = "";
      dispatch({ type: "SET_INTERACTING", value: false });
    },
    [onPointerMove],
  );

  /** Start capturing pointer events on the given element. */
  const startCapture = useCallback(
    (e: React.PointerEvent) => {
      const target = e.currentTarget as Element;
      target.setPointerCapture(e.pointerId);
      target.addEventListener("pointermove", onPointerMove as EventListener);
      target.addEventListener("pointerup", onPointerUp as EventListener);
      document.body.style.userSelect = "none";
      dispatch({ type: "SET_INTERACTING", value: true });
    },
    [onPointerMove, onPointerUp],
  );

  // ── Header drag ────────────────────────────────────────────────────────

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only primary button
      if (e.button !== 0) {
        return;
      }
      // Don't start drag when clicking interactive elements (buttons, links, inputs)
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='button']")) {
        return;
      }
      const renderedHeight = state.isMinimized ? c.minimizedHeight : state.height;
      const modalLeft = window.innerWidth - state.right - state.width;
      const modalTop = window.innerHeight - state.bottom - renderedHeight;
      dragOffset.current = {
        offsetX: e.clientX - modalLeft,
        offsetY: e.clientY - modalTop,
      };
      startCapture(e);
    },
    [state.isMinimized, state.height, state.right, state.bottom, state.width, c, startCapture],
  );

  // ── Resize handles ─────────────────────────────────────────────────────

  const onResizePointerDown = useCallback(
    (edge: ResizeEdge) => (e: React.PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const { right, bottom, width, height } = state;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      resizeOrigin.current = {
        fixedRight: vw - right,
        fixedBottom: vh - bottom,
        fixedLeft: vw - right - width,
        fixedTop: vh - bottom - height,
        edge,
      };
      startCapture(e);
    },
    [state, startCapture],
  );

  // ── Toggle minimized ──────────────────────────────────────────────────

  const toggleMinimized = useCallback(() => {
    dispatch({ type: "TOGGLE_MINIMIZED", constraints: c });
  }, [c]);

  // ── Derived style ──────────────────────────────────────────────────────

  const panelStyle = useMemo(
    (): React.CSSProperties => ({
      right: state.right,
      bottom: state.bottom,
      width: state.width,
      height: state.isMinimized ? undefined : state.height,
    }),
    [state.right, state.bottom, state.width, state.height, state.isMinimized],
  );

  return {
    panelState: state,
    panelStyle,
    headerProps: { onPointerDown: onHeaderPointerDown },
    resizeHandleProps: onResizePointerDown,
    toggleMinimized,
  };
}
