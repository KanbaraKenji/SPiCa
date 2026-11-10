// A picture at full size over the window; Esc or a click closes it.
import { useEffect } from 'react';

export function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="image-viewer" role="dialog" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} />
    </div>
  );
}
