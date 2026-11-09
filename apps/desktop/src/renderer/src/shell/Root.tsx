// Holds the window content and, on top of it until start-up is done, the
// opening animation from @spica/brand. The app renders underneath right away,
// so nothing waits on the animation except the animation itself, and a click
// or key press skips it.
import { useEffect, useState, type ReactNode } from 'react';
import { SpicaMark, SpicaSplash } from '@spica/brand/react';

export interface RootProps {
  /** full: the brand animation; brief: the mark flashes for under a second; none: straight in. */
  splash: 'full' | 'brief' | 'none';
  /** Resolves when sessions and settings are loaded. */
  ready: Promise<unknown>;
  version: string;
  children: ReactNode;
}

export function Root({ splash: mode, ready, version, children }: RootProps) {
  const [loaded, setLoaded] = useState(false);
  const [splash, setSplash] = useState(mode === 'full');
  const [brief, setBrief] = useState(mode === 'brief');
  useEffect(() => {
    if (!brief) return;
    // Fallback in case animationend does not arrive.
    const t = setTimeout(() => setBrief(false), 1000);
    return () => clearTimeout(t);
  }, [brief]);
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
      {brief ? (
        <div className="splash-brief" onAnimationEnd={() => setBrief(false)} onPointerDown={() => setBrief(false)} aria-hidden>
          <SpicaMark size={72} />
        </div>
      ) : null}
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
