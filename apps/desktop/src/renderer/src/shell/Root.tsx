// Holds the window content and, on top of it until start-up is done, the
// opening animation from @spica/brand. The app renders underneath right away,
// so nothing waits on the animation except the animation itself, and a click
// or key press skips it.
import { useEffect, useState, type ReactNode } from 'react';
import { SpicaSplash } from '@spica/brand/react';

export interface RootProps {
  showSplash: boolean;
  /** Resolves when sessions and settings are loaded. */
  ready: Promise<unknown>;
  version: string;
  children: ReactNode;
}

export function Root({ showSplash, ready, version, children }: RootProps) {
  const [loaded, setLoaded] = useState(false);
  const [splash, setSplash] = useState(showSplash);
  useEffect(() => {
    let alive = true;
    void ready.finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [ready]);
  // A click or any key skips the opening animation: it fades out instead of cutting.
  const [skipping, setSkipping] = useState(false);
  useEffect(() => {
    if (!splash || skipping) return;
    // The key or click that skips is used up here, so it does not also type or click underneath.
    const skip = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      setSkipping(true);
    };
    window.addEventListener('keydown', skip, { capture: true, once: true });
    window.addEventListener('pointerdown', skip, { capture: true, once: true });
    return () => {
      window.removeEventListener('keydown', skip, { capture: true });
      window.removeEventListener('pointerdown', skip, { capture: true });
    };
  }, [splash, skipping]);
  useEffect(() => {
    if (!skipping) return;
    // In case the fade's transitionend never arrives (hidden window, no animation).
    const t = setTimeout(() => setSplash(false), 600);
    return () => clearTimeout(t);
  }, [skipping]);
  const scheme = document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light';
  return (
    <div className="root">
      {children}
      {splash ? (
        <div
          className={skipping ? 'splash-layer is-skipping' : 'splash-layer'}
          onTransitionEnd={(e) => {
            if (skipping && e.target === e.currentTarget) setSplash(false);
          }}
        >
          <SpicaSplash ready={loaded} onDone={() => setSplash(false)} theme={scheme} caption={version ? `v${version}` : undefined} />
        </div>
      ) : null}
    </div>
  );
}
