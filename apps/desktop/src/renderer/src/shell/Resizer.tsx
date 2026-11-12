// The edge between a side panel and the conversation: drag to resize (the
// pointer turns into a two-way arrow), double-click for the usual width, or
// focus it and use the arrow keys. The sidebar's edge and the file preview's;
// the details panel has a fixed width and no edge.
import { useRef } from 'react';
import { clampPanelWidth, PANEL_LIMITS } from '../../../shared/settings';

export interface ResizerProps {
  /** The sidebar (grows to the right) or the file preview (on the right, grows to the left). */
  side: 'left' | 'preview';
  /** Width the panel is drawn at now. */
  width: number;
  /** While dragging: the width to draw (not saved yet). */
  onPreview(width: number | null): void;
  /** Drag ended or a key was pressed: save this width. */
  onCommit(width: number): void;
  /** The widest it may get in this window now (the preview: until the conversation reaches its narrowest). */
  max?: number;
}

const STEP = 16;

export function Resizer({ side, width, onPreview, onCommit, max }: ResizerProps) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const limits = PANEL_LIMITS[side];
  const top = Math.max(limits.min, Math.min(limits.max, max ?? limits.max));
  const clamp = (w: number) => Math.min(top, clampPanelWidth(side, w));
  // The left panel grows to the right, the right panel to the left.
  const next = (clientX: number) => {
    const s = start.current;
    if (!s) return width;
    const dx = clientX - s.x;
    return clamp(s.w + (side === 'left' ? dx : -dx));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整侧栏宽度' : '调整预览宽度'}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={top}
      tabIndex={0}
      title="拖动调整宽度，双击恢复"
      className={`panel-resizer is-${side === 'left' ? 'left' : 'right'}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (start.current) onPreview(next(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const w = next(e.clientX);
        start.current = null;
        onPreview(null);
        onCommit(w);
      }}
      onPointerCancel={() => {
        start.current = null;
        onPreview(null);
      }}
      onDoubleClick={() => onCommit(clamp(limits.initial))}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const grow = (e.key === 'ArrowRight') === (side === 'left');
        onCommit(clamp(width + (grow ? STEP : -STEP)));
      }}
    />
  );
}
