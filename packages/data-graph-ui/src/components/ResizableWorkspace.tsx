import { Children, useEffect, useRef, useState, type ReactNode } from "react";

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 320;
const STORAGE_KEY = "sql-static-lineage:detail-panel-width";

export function maxDetailWidth(workspaceWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(960, workspaceWidth - 260 - 320 - 8 - 3));
}
export function clampDetailWidth(width: number, maximum: number): number {
  return Math.round(
    Math.max(
      MIN_WIDTH,
      Math.min(maximum, Number.isFinite(width) ? width : DEFAULT_WIDTH),
    ),
  );
}
export function draggedDetailWidth(
  initial: number,
  startX: number,
  currentX: number,
  maximum: number,
): number {
  return clampDetailWidth(initial + startX - currentX, maximum);
}

function savedWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_WIDTH : clampDetailWidth(Number(raw), 960);
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** Left navigation, graph canvas, and a resizable detail column. */
export function ResizableWorkspace({ children }: { children: ReactNode }) {
  const panels = Children.toArray(children);
  const workspace = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const [width, setWidth] = useState(savedWidth);
  const [maximum, setMaximum] = useState(960);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const update = () => {
      const max = maxDetailWidth(element.getBoundingClientRect().width);
      setMaximum(max);
      setWidth((value) => clampDetailWidth(value, max));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      /* Optional preference. */
    }
  }, [width]);

  const stopDragging = () => {
    drag.current = null;
    setDragging(false);
  };
  return (
    <div
      ref={workspace}
      className={`workspace ${dragging ? "resizing" : ""}`}
      style={{ gridTemplateColumns: `260px minmax(320px, 1fr) 8px ${width}px` }}
    >
      {panels[0]}
      {panels[1]}
      <div
        className="detail-resize-handle"
        role="separator"
        aria-label="调整详情面板宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        tabIndex={0}
        title="拖动调整宽度；方向键微调；双击恢复默认"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId === event.pointerId)
            setWidth(
              draggedDetailWidth(start.width, start.x, event.clientX, maximum),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          stopDragging();
        }}
        onPointerCancel={stopDragging}
        onLostPointerCapture={stopDragging}
        onDoubleClick={() => setWidth(clampDetailWidth(DEFAULT_WIDTH, maximum))}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          setWidth((value) =>
            clampDetailWidth(
              event.key === "Home"
                ? MIN_WIDTH
                : event.key === "End"
                  ? maximum
                  : value + (event.key === "ArrowLeft" ? 20 : -20),
              maximum,
            ),
          );
        }}
      />
      {panels[2]}
    </div>
  );
}
