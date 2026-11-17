// A page's own zoom when it is not 100% (Ctrl + wheel, Ctrl + plus / minus in the page; main/browser/page-zoom.ts):
// 125% in the page's row, pressed: back to 100%. At 100%: nothing.
import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { DEFAULT_ZOOM, zoomLabel } from '../../../shared/zoom';
import { t } from '../../../shared/i18n';

export type PageZoomBridge = Pick<DesktopBridge['browser'], 'zoom' | 'onZoom'>;

export function ZoomMark({ zoom: bridge, wcId }: { zoom: PageZoomBridge; wcId: number | null }) {
  const [zoom, setZoom] = useState<{ wcId: number | null; value: number }>({ wcId, value: DEFAULT_ZOOM });
  useEffect(() => {
    if (wcId === null) return undefined;
    let live = true;
    void bridge.zoom(wcId, 'get').then((value) => live && setZoom({ wcId, value }));
    const off = bridge.onZoom((z) => {
      if (z.wcId === wcId) setZoom({ wcId, value: z.zoom });
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge, wcId]);
  const value = zoom.wcId === wcId ? zoom.value : DEFAULT_ZOOM;
  if (wcId === null || Math.abs(value - DEFAULT_ZOOM) < 0.001) return null;
  return (
    <button type="button" className="btn btn-small zoom-mark num" onClick={() => void bridge.zoom(wcId, 'reset').then((v) => setZoom({ wcId, value: v }))} title={t('重置缩放')} aria-label={t('重置缩放（{zoom}）', { zoom: zoomLabel(value) })}>
      {zoomLabel(value)}
    </button>
  );
}
