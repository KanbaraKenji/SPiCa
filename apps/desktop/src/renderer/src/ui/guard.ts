// One submit at a time: a second click (or Enter) while the first is still
// running is dropped, not queued. Checked on a ref, so clicks that come before
// React has drawn the button disabled cannot slip through either.
//   const run = useGuard();
//   const save = () => run(async () => { ... });
import { useCallback, useRef } from "react";

export function useGuard(): <R>(
  fn: () => Promise<R>,
) => Promise<R | undefined> {
  const running = useRef(false);
  return useCallback(
    async <R>(fn: () => Promise<R>): Promise<R | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      try {
        return await fn();
      } finally {
        running.current = false;
      }
    },
    [],
  );
}
