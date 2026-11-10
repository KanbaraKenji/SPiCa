// A picture at full size over the window; Esc or a click closes it, and the
// keyboard stays with it while it is open (useModal).
import { useRef } from 'react';
import { useModal } from './useModal';

export function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose);
  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} ref={box} onClick={onClose}>
      <img src={url} alt={name} />
    </div>
  );
}
