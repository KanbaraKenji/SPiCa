// Holds the window content and, on top of it until start-up is done, the
// opening animation from @spica/brand. The app renders underneath right away,
// so nothing waits on the animation except the animation itself.
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
  const scheme = document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light';
  return (
    <div className="root">
      {children}
      {splash ? (
        <div className="splash-layer">
          <SpicaSplash ready={loaded} onDone={() => setSplash(false)} theme={scheme} caption={version ? `v${version}` : undefined} />
        </div>
      ) : null}
    </div>
  );
}
