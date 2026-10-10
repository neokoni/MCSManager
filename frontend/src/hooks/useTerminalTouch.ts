import { t } from "@/lang/i18n";
import { toCopy } from "@/tools/copy";
import type { IBuffer, IMarker, Terminal } from "@xterm/xterm";
import { message } from "ant-design-vue";
import { snapSelectionEnd, snapSelectionStart } from "./terminalTouchSelection";

type SelectionEndpoint = "start" | "end";

interface TerminalTouchOptions {
  element: HTMLElement;
  terminal: Terminal;
  canPaste: () => boolean;
}

interface GridMetrics {
  cellHeight: number;
  cellWidth: number;
  hostRect: DOMRect;
  screenRect: DOMRect;
}

interface BoundaryPosition {
  column: number;
  row: number;
}

interface TrackedSelection {
  endColumn: number;
  endMarker: IMarker;
  startColumn: number;
  startMarker: IMarker;
  viewportMarker: IMarker;
}

const MOVE_THRESHOLD = 8;
const LONG_PRESS_DELAY = 500;
const INERTIA_FRICTION = 0.94;
const MAX_INERTIA_VELOCITY = 160;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function getCellClass(chars: string): "space" | "word" | "symbol" {
  if (!chars || /^\s+$/u.test(chars)) return "space";
  if (/^[\p{L}\p{N}_]+$/u.test(chars)) return "word";
  return "symbol";
}

function getCellWidth(buffer: IBuffer, columns: number, index: number): number {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return buffer.getLine(row)?.getCell(column)?.getWidth() ?? 1;
}

function getWordRange(buffer: IBuffer, columns: number, row: number, column: number) {
  const line = buffer.getLine(row);
  if (!line) return { start: row * columns + column, end: row * columns + column + 1 };

  while (column > 0 && line.getCell(column)?.getWidth() === 0) {
    column--;
  }

  const initialCell = line.getCell(column);
  const initialWidth = Math.max(initialCell?.getWidth() ?? 1, 1);
  const cellClass = getCellClass(initialCell?.getChars() ?? "");
  let startColumn = column;
  let endColumn = Math.min(column + initialWidth, columns);

  if (cellClass !== "space") {
    while (startColumn > 0) {
      let previousColumn = startColumn - 1;
      while (previousColumn > 0 && line.getCell(previousColumn)?.getWidth() === 0) {
        previousColumn--;
      }
      const previousCell = line.getCell(previousColumn);
      if (!previousCell || getCellClass(previousCell.getChars()) !== cellClass) break;
      startColumn = previousColumn;
    }

    while (endColumn < columns) {
      const nextCell = line.getCell(endColumn);
      if (!nextCell) break;
      if (nextCell.getWidth() === 0) {
        endColumn++;
        continue;
      }
      if (getCellClass(nextCell.getChars()) !== cellClass) break;
      endColumn = Math.min(endColumn + Math.max(nextCell.getWidth(), 1), columns);
    }
  }

  return {
    start: row * columns + startColumn,
    end: row * columns + endColumn
  };
}

export function attachTerminalTouchControls({
  element,
  terminal,
  canPaste
}: TerminalTouchOptions): () => void {
  const viewport = element.querySelector<HTMLElement>(".xterm-viewport");
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  if (!viewport || !screen) return () => undefined;

  element.classList.add("xterm-touch-host");

  const selectionUi = document.createElement("div");
  selectionUi.className = "xterm-touch-selection-ui";
  selectionUi.hidden = true;

  const startHandle = document.createElement("div");
  startHandle.className = "xterm-touch-selection-handle is-start";
  const endHandle = document.createElement("div");
  endHandle.className = "xterm-touch-selection-handle is-end";
  const handleEndpoints = new Map<HTMLElement, SelectionEndpoint>([
    [startHandle, "start"],
    [endHandle, "end"]
  ]);

  const toolbar = document.createElement("div");
  toolbar.className = "xterm-touch-selection-toolbar";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = t("TXT_CODE_13ae6a93");

  const pasteButton = document.createElement("button");
  pasteButton.type = "button";
  pasteButton.textContent = t("TXT_CODE_43248597");

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = t("TXT_CODE_abedfd03");

  toolbar.append(copyButton, pasteButton, cancelButton);
  selectionUi.append(startHandle, endHandle, toolbar);
  element.appendChild(selectionUi);

  let selectionStart = 0;
  let selectionEnd = 0;
  let selectionViewportY: number | undefined;
  let selectionActive = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let longPressActive = false;
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressAnchorStart = 0;
  let longPressAnchorEnd = 0;
  let lastTouchY = 0;
  let lastMoveTime = 0;
  let velocityY = 0;
  let inertiaFrame: number | undefined;
  let suppressMouseUntil = 0;
  let suppressTouchContextMenuUntil = 0;
  let selectionDismissedByTouch = false;
  let uiUpdateFrame: number | undefined;
  let trackedSelection: TrackedSelection | undefined;

  const getMetrics = (): GridMetrics | undefined => {
    const screenRect = screen.getBoundingClientRect();
    if (!terminal.cols || !terminal.rows || !screenRect.width || !screenRect.height) return;
    return {
      cellWidth: screenRect.width / terminal.cols,
      cellHeight: screenRect.height / terminal.rows,
      hostRect: element.getBoundingClientRect(),
      screenRect
    };
  };

  const getVisualBoundary = (index: number, endpoint: SelectionEndpoint): BoundaryPosition => {
    let row = Math.floor(index / terminal.cols);
    let column = index % terminal.cols;
    if (endpoint === "end" && column === 0 && index > selectionStart) {
      row--;
      column = terminal.cols;
    }
    return { column, row };
  };

  const setHandleEndpoint = (handle: HTMLElement, endpoint: SelectionEndpoint) => {
    handleEndpoints.set(handle, endpoint);
    handle.classList.toggle("is-start", endpoint === "start");
    handle.classList.toggle("is-end", endpoint === "end");
  };

  const resetHandleEndpoints = () => {
    setHandleEndpoint(startHandle, "start");
    setHandleEndpoint(endHandle, "end");
  };

  const swapHandleEndpoints = (draggedHandle: HTMLElement) => {
    const otherHandle = draggedHandle === startHandle ? endHandle : startHandle;
    const nextEndpoint = handleEndpoints.get(draggedHandle) === "start" ? "end" : "start";
    setHandleEndpoint(draggedHandle, nextEndpoint);
    setHandleEndpoint(otherHandle, nextEndpoint === "start" ? "end" : "start");
    return nextEndpoint;
  };

  const getBoundaryClientPosition = (endpoint: SelectionEndpoint) => {
    const metrics = getMetrics();
    if (!metrics) return;
    const index = endpoint === "start" ? selectionStart : selectionEnd;
    const boundary = getVisualBoundary(index, endpoint);
    return {
      x: metrics.screenRect.left + boundary.column * metrics.cellWidth,
      y:
        metrics.screenRect.top +
        (boundary.row - terminal.buffer.active.viewportY + 1) * metrics.cellHeight
    };
  };

  const updateSelectionUi = () => {
    uiUpdateFrame = undefined;
    if (!selectionActive) return;
    const metrics = getMetrics();
    if (!metrics) return;

    const viewportY = terminal.buffer.active.viewportY;
    const positions = [startHandle, endHandle].map((handle) => {
      const endpoint = handleEndpoints.get(handle) ?? "start";
      const index = endpoint === "start" ? selectionStart : selectionEnd;
      const boundary = getVisualBoundary(index, endpoint);
      const visible = boundary.row >= viewportY && boundary.row < viewportY + terminal.rows;
      handle.hidden = !visible;
      const x =
        metrics.screenRect.left - metrics.hostRect.left + boundary.column * metrics.cellWidth;
      const y =
        metrics.screenRect.top -
        metrics.hostRect.top +
        (boundary.row - viewportY + 1) * metrics.cellHeight;
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      return { visible, x, y };
    });

    pasteButton.hidden = !canPaste();

    const visiblePositions = positions.filter((position) => position.visible);
    const toolbarWidth = toolbar.offsetWidth;
    const toolbarHeight = toolbar.offsetHeight;
    const centerX = visiblePositions.length
      ? visiblePositions.reduce((total, position) => total + position.x, 0) /
        visiblePositions.length
      : metrics.screenRect.left - metrics.hostRect.left + metrics.screenRect.width / 2;
    const topY = visiblePositions.length
      ? Math.min(...visiblePositions.map((position) => position.y))
      : metrics.screenRect.top - metrics.hostRect.top;
    const bottomY = visiblePositions.length
      ? Math.max(...visiblePositions.map((position) => position.y))
      : topY;
    const maximumLeft = Math.max(element.clientWidth - toolbarWidth - 4, 4);
    toolbar.style.left = `${clamp(centerX - toolbarWidth / 2, 4, maximumLeft)}px`;
    toolbar.style.top = `${
      topY - toolbarHeight - 10 >= 4
        ? topY - toolbarHeight - 10
        : Math.min(bottomY + 22, element.clientHeight - toolbarHeight - 4)
    }px`;
  };

  const scheduleSelectionUiUpdate = () => {
    if (uiUpdateFrame !== undefined) return;
    uiUpdateFrame = requestAnimationFrame(updateSelectionUi);
  };

  const disposeTrackedSelection = () => {
    if (!trackedSelection) return;
    trackedSelection.viewportMarker.dispose();
    trackedSelection.startMarker.dispose();
    trackedSelection.endMarker.dispose();
    trackedSelection = undefined;
  };

  const trackSelection = () => {
    disposeTrackedSelection();
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal") return;

    const cursorRow = buffer.baseY + buffer.cursorY;
    const endBoundary = getVisualBoundary(selectionEnd, "end");
    trackedSelection = {
      viewportMarker: terminal.registerMarker(buffer.viewportY - cursorRow),
      startMarker: terminal.registerMarker(Math.floor(selectionStart / terminal.cols) - cursorRow),
      startColumn: selectionStart % terminal.cols,
      endMarker: terminal.registerMarker(endBoundary.row - cursorRow),
      endColumn: endBoundary.column
    };
  };

  const applySelection = () => {
    const maximumIndex = terminal.buffer.active.length * terminal.cols;
    selectionStart = clamp(selectionStart, 0, Math.max(maximumIndex - 1, 0));
    selectionEnd = clamp(selectionEnd, selectionStart + 1, maximumIndex);
    terminal.select(
      selectionStart % terminal.cols,
      Math.floor(selectionStart / terminal.cols),
      selectionEnd - selectionStart
    );
    trackSelection();
    scheduleSelectionUiUpdate();
  };

  const clearSelection = () => {
    selectionActive = false;
    selectionViewportY = undefined;
    disposeTrackedSelection();
    selectionUi.hidden = true;
    terminal.clearSelection();
    element.classList.remove("touch-selection-active");
  };

  const beginSelection = (clientX: number, clientY: number) => {
    const metrics = getMetrics();
    if (!metrics) return false;
    const viewportRow = clamp(
      Math.floor((clientY - metrics.screenRect.top) / metrics.cellHeight),
      0,
      terminal.rows - 1
    );
    const row = terminal.buffer.active.viewportY + viewportRow;
    const column = clamp(
      Math.floor((clientX - metrics.screenRect.left) / metrics.cellWidth),
      0,
      terminal.cols - 1
    );
    const range = getWordRange(terminal.buffer.active, terminal.cols, row, column);
    resetHandleEndpoints();
    selectionStart = range.start;
    selectionEnd = range.end;
    longPressAnchorStart = range.start;
    longPressAnchorEnd = range.end;
    selectionViewportY = terminal.buffer.active.viewportY;
    selectionActive = true;
    selectionUi.hidden = false;
    element.classList.add("touch-selection-active");
    applySelection();
    return true;
  };

  const pointToCellRange = (clientX: number, clientY: number) => {
    const metrics = getMetrics();
    if (!metrics) return;
    const viewportRow = clamp(
      Math.floor((clientY - metrics.screenRect.top) / metrics.cellHeight),
      0,
      terminal.rows - 1
    );
    const row = terminal.buffer.active.viewportY + viewportRow;
    const column = clamp(
      Math.floor((clientX - metrics.screenRect.left) / metrics.cellWidth),
      0,
      terminal.cols - 1
    );
    const index = row * terminal.cols + column;
    const start = snapSelectionStart(terminal.buffer.active, terminal.cols, index);
    return {
      start,
      end: snapSelectionEnd(
        terminal.buffer.active,
        terminal.cols,
        start + Math.max(getCellWidth(terminal.buffer.active, terminal.cols, start), 1)
      )
    };
  };

  const pointToBoundaryIndex = (clientX: number, clientY: number, endpoint: SelectionEndpoint) => {
    const metrics = getMetrics();
    if (!metrics) return endpoint === "start" ? selectionStart : selectionEnd;
    const viewportRow = clamp(
      Math.round((clientY - metrics.screenRect.top) / metrics.cellHeight) - 1,
      0,
      terminal.rows - 1
    );
    const row = terminal.buffer.active.viewportY + viewportRow;
    const column = clamp(
      Math.round((clientX - metrics.screenRect.left) / metrics.cellWidth),
      0,
      terminal.cols
    );
    const index = row * terminal.cols + column;
    return endpoint === "start"
      ? snapSelectionStart(terminal.buffer.active, terminal.cols, index)
      : snapSelectionEnd(terminal.buffer.active, terminal.cols, index);
  };

  const stopInertia = () => {
    if (inertiaFrame !== undefined) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = undefined;
    }
    velocityY = 0;
  };

  const clearLongPress = () => {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  };

  const resetTouchState = () => {
    clearLongPress();
    touchMoved = false;
    longPressActive = false;
  };

  const runInertia = () => {
    if (Math.abs(velocityY) < 0.1) {
      inertiaFrame = undefined;
      velocityY = 0;
      return;
    }
    viewport.scrollTop += velocityY;
    velocityY *= INERTIA_FRICTION;
    inertiaFrame = requestAnimationFrame(runInertia);
  };

  const isSelectionUiTarget = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest(".xterm-touch-selection-ui"));

  const handleTouchStart = (event: TouchEvent) => {
    if (isSelectionUiTarget(event.target)) return;
    if (event.touches.length !== 1) {
      resetTouchState();
      stopInertia();
      return;
    }

    event.stopImmediatePropagation();
    suppressTouchContextMenuUntil = Date.now() + LONG_PRESS_DELAY + 1000;
    terminal.blur();
    (document.activeElement as HTMLElement | null)?.blur();
    stopInertia();

    const touch = event.touches[0];
    selectionDismissedByTouch = false;
    if (selectionActive) {
      clearSelection();
      selectionDismissedByTouch = true;
    }

    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    lastTouchY = touch.pageY;
    lastMoveTime = performance.now();
    touchMoved = false;
    longPressActive = false;
    clearLongPress();
    if (!selectionDismissedByTouch) {
      longPressTimer = setTimeout(() => {
        longPressTimer = undefined;
        if (!touchMoved && beginSelection(touchStartX, touchStartY)) {
          longPressActive = true;
        }
      }, LONG_PRESS_DELAY);
    }
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (isSelectionUiTarget(event.target) || event.touches.length !== 1) return;
    event.stopImmediatePropagation();
    const touch = event.touches[0];

    if (longPressActive && selectionActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const range = pointToCellRange(touch.clientX, touch.clientY);
      if (!range) return;
      if (range.start < longPressAnchorStart) {
        selectionStart = range.start;
        selectionEnd = longPressAnchorEnd;
      } else {
        selectionStart = longPressAnchorStart;
        selectionEnd = Math.max(range.end, longPressAnchorEnd);
      }
      applySelection();
      return;
    }

    const distance = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
    if (!touchMoved && distance > MOVE_THRESHOLD) {
      touchMoved = true;
      clearLongPress();
      element.classList.add("touch-scrolling");
      terminal.blur();
    }

    if (touchMoved) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    const now = performance.now();
    const deltaTime = now - lastMoveTime;
    const deltaY = lastTouchY - touch.pageY;
    if (touchMoved) viewport.scrollTop += deltaY;
    if (touchMoved && deltaTime > 0) {
      const nextVelocity = clamp(
        (deltaY / deltaTime) * 16,
        -MAX_INERTIA_VELOCITY,
        MAX_INERTIA_VELOCITY
      );
      velocityY = velocityY * 0.35 + nextVelocity * 0.65;
    }
    lastTouchY = touch.pageY;
    lastMoveTime = now;
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (isSelectionUiTarget(event.target)) return;
    event.stopImmediatePropagation();
    suppressMouseUntil = Date.now() + 700;
    if (selectionActive) {
      stopInertia();
    } else if (touchMoved && !longPressActive) {
      inertiaFrame = requestAnimationFrame(runInertia);
    } else if (!touchMoved && !longPressActive && !selectionDismissedByTouch && canPaste()) {
      terminal.focus();
    }
    element.classList.remove("touch-scrolling");
    resetTouchState();
    selectionDismissedByTouch = false;
  };

  const handleTouchCancel = (event: TouchEvent) => {
    if (isSelectionUiTarget(event.target)) return;
    event.stopImmediatePropagation();
    suppressMouseUntil = Date.now() + 700;
    element.classList.remove("touch-scrolling");
    resetTouchState();
    stopInertia();
  };

  const handleCompatibilityMouseDown = (event: MouseEvent) => {
    if (Date.now() >= suppressMouseUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (Date.now() >= suppressTouchContextMenuUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const handleDocumentTouchStart = (event: TouchEvent) => {
    if (selectionActive && event.target instanceof Node && !element.contains(event.target)) {
      clearSelection();
    }
  };

  const attachHandle = (handle: HTMLElement) => {
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let draggedEndpoint: SelectionEndpoint = "start";

    const handleDragStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      stopInertia();
      draggedEndpoint = handleEndpoints.get(handle) ?? "start";
      const position = getBoundaryClientPosition(draggedEndpoint);
      if (!position) return;
      dragOffsetX = event.touches[0].clientX - position.x;
      dragOffsetY = event.touches[0].clientY - position.y;
      handle.classList.add("is-dragging");
    };

    const handleDragMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !handle.classList.contains("is-dragging")) return;
      event.preventDefault();
      event.stopPropagation();
      const touch = event.touches[0];
      const clientX = touch.clientX - dragOffsetX;
      const clientY = touch.clientY - dragOffsetY;
      const startIndex = pointToBoundaryIndex(clientX, clientY, "start");
      const endIndex = pointToBoundaryIndex(clientX, clientY, "end");
      if (draggedEndpoint === "start" && startIndex > selectionEnd) {
        selectionStart = selectionEnd;
        selectionEnd = Math.max(endIndex, selectionStart + 1);
        draggedEndpoint = swapHandleEndpoints(handle);
      } else if (draggedEndpoint === "end" && endIndex < selectionStart) {
        selectionEnd = selectionStart;
        selectionStart = Math.min(startIndex, selectionEnd - 1);
        draggedEndpoint = swapHandleEndpoints(handle);
      } else if (draggedEndpoint === "start") {
        selectionStart = Math.min(startIndex, selectionEnd - 1);
      } else {
        selectionEnd = Math.max(endIndex, selectionStart + 1);
      }
      applySelection();
    };

    const handleDragEnd = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handle.classList.remove("is-dragging");
    };

    handle.addEventListener("touchstart", handleDragStart, { passive: false });
    handle.addEventListener("touchmove", handleDragMove, { passive: false });
    handle.addEventListener("touchend", handleDragEnd, { passive: false });
    handle.addEventListener("touchcancel", handleDragEnd, { passive: false });

    return () => {
      handle.removeEventListener("touchstart", handleDragStart);
      handle.removeEventListener("touchmove", handleDragMove);
      handle.removeEventListener("touchend", handleDragEnd);
      handle.removeEventListener("touchcancel", handleDragEnd);
    };
  };

  const stopStartHandle = attachHandle(startHandle);
  const stopEndHandle = attachHandle(endHandle);

  const stopToolbarEvent = (event: Event) => event.stopPropagation();
  toolbar.addEventListener("touchstart", stopToolbarEvent);
  toolbar.addEventListener("mousedown", stopToolbarEvent);

  copyButton.addEventListener("click", () => {
    const selection = terminal.getSelection();
    if (selection) void toCopy(selection);
    clearSelection();
  });

  pasteButton.addEventListener("click", async () => {
    if (!canPaste()) return;
    if (!navigator.clipboard?.readText) {
      message.error(t("TXT_CODE_ca07c84c"));
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal.paste(text);
      clearSelection();
    } catch (error: any) {
      if (error?.name === "NotAllowedError") {
        message.error(t("TXT_CODE_2a22c2ff"));
      } else {
        message.error(error?.message ?? t("TXT_CODE_ca07c84c"));
      }
    }
  });

  cancelButton.addEventListener("click", clearSelection);

  element.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
  element.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
  element.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
  element.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: true });
  element.addEventListener("mousedown", handleCompatibilityMouseDown, true);
  element.addEventListener("contextmenu", handleContextMenu, true);
  document.addEventListener("touchstart", handleDocumentTouchStart, {
    capture: true,
    passive: true
  });

  const writeDisposable = terminal.onWriteParsed(() => {
    if (selectionActive && trackedSelection) {
      const { viewportMarker, startMarker, endMarker, startColumn, endColumn } = trackedSelection;
      if (viewportMarker.line < 0 || startMarker.line < 0 || endMarker.line < 0) {
        clearSelection();
        return;
      }

      const nextSelectionStart = startMarker.line * terminal.cols + startColumn;
      const nextSelectionEnd = endMarker.line * terminal.cols + endColumn;
      if (nextSelectionEnd <= nextSelectionStart) {
        clearSelection();
        return;
      }

      if (nextSelectionStart !== selectionStart || nextSelectionEnd !== selectionEnd) {
        selectionStart = nextSelectionStart;
        selectionEnd = nextSelectionEnd;
        terminal.select(
          selectionStart % terminal.cols,
          Math.floor(selectionStart / terminal.cols),
          selectionEnd - selectionStart
        );
      }

      selectionViewportY = viewportMarker.line;
      if (terminal.buffer.active.viewportY !== selectionViewportY) {
        terminal.scrollToLine(selectionViewportY);
      }
    } else if (
      selectionActive &&
      selectionViewportY !== undefined &&
      terminal.buffer.active.viewportY !== selectionViewportY
    ) {
      terminal.scrollToLine(selectionViewportY);
    }
    scheduleSelectionUiUpdate();
  });
  const resizeDisposable = terminal.onResize(() => {
    if (selectionActive) clearSelection();
  });
  const scrollDisposable = terminal.onScroll(scheduleSelectionUiUpdate);
  const selectionDisposable = terminal.onSelectionChange(() => {
    if (selectionActive && !terminal.hasSelection()) clearSelection();
  });

  return () => {
    resetTouchState();
    stopInertia();
    clearSelection();
    if (uiUpdateFrame !== undefined) cancelAnimationFrame(uiUpdateFrame);
    stopStartHandle();
    stopEndHandle();
    writeDisposable.dispose();
    resizeDisposable.dispose();
    scrollDisposable.dispose();
    selectionDisposable.dispose();
    toolbar.removeEventListener("touchstart", stopToolbarEvent);
    toolbar.removeEventListener("mousedown", stopToolbarEvent);
    element.removeEventListener("touchstart", handleTouchStart, true);
    element.removeEventListener("touchmove", handleTouchMove, true);
    element.removeEventListener("touchend", handleTouchEnd, true);
    element.removeEventListener("touchcancel", handleTouchCancel, true);
    element.removeEventListener("mousedown", handleCompatibilityMouseDown, true);
    element.removeEventListener("contextmenu", handleContextMenu, true);
    document.removeEventListener("touchstart", handleDocumentTouchStart, true);
    element.classList.remove("xterm-touch-host", "touch-selection-active", "touch-scrolling");
    selectionUi.remove();
  };
}
