// Holds the window content and, on top of it until start-up is done, the
// opening animation from @spica/brand. The app renders underneath right away,
// so nothing waits on the animation except the animation itself, and a click
// or key press skips it.
import { useEffect, useState, type ReactNode } from 'react';
import { SpicaMark, SpicaSplash } from '@spica/brand/react';
import { SPLASH_FINISH_AFTER } from '@spica/brand';
import { wordmarkProps } from '../app-wordmark';

/**
 * The full opening plays about this long however fast start-up is (he asked for
 * ~10 s on 2026-11-10: on a fresh install loading took no time and it flashed by).
 * Only the loading part is held longer; the finish after it is the brand's own.
 */
export const SPLASH_TOTAL_MS = 10_000;
/** How long the loading part runs at least before the finish starts. */
export const SPLASH_LOADING_AT_LEAST_MS = Math.max(0, SPLASH_TOTAL_MS - Math.round(SPLASH_FINISH_AFTER * 1000));

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
    // The full version waits out its loading part even when start-up is already done.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const atLeast = mode === 'full' ? new Promise<void>((r) => (timer = setTimeout(r, SPLASH_LOADING_AT_LEAST_MS))) : Promise.resolve();
    void Promise.allSettled([ready, atLeast]).then(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready, mode]);
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
          <SpicaSplash ready={loaded} onDone={() => setSplash(false)} theme={scheme} caption={version ? `v${version}` : undefined} {...wordmarkProps} />
        </div>
      ) : null}
    </div>
  );
}
