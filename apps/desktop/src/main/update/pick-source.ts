// Choosing among several addresses for one source (deploy.json's updateSource, or a pluginSources entry's location,
// written as a list): the same files on more than one server, so a company can put a near one first and keep a far
// one as the fallback. Checks are unchanged whichever is used (latest.yml's sha512, index.json's sha256).
//
// The seam is orderSources: it gets the addresses as written and returns them in the order to try. It only keeps
// that order now. A build that wants to choose by network, by measured speed or by the user's office replaces it
// there (it may be made async: firstWorking already awaits each try); nothing else needs to change.

/** In which order to try the addresses of one source. Now: as written in deploy.json. */
export function orderSources(places: readonly string[]): string[] {
  return places.filter((p, i) => p && places.indexOf(p) === i);
}

/**
 * Tries the addresses in orderSources' order; the first whose attempt succeeds gives the result (and which address
 * it was). All failing: the first address's error is thrown, so what is said is about the one meant first.
 */
export async function firstWorking<T>(places: readonly string[], attempt: (place: string) => Promise<T>): Promise<{ place: string; value: T }> {
  const order = orderSources(places);
  if (!order.length) throw new Error('no address');
  let first: unknown;
  for (const place of order) {
    try {
      return { place, value: await attempt(place) };
    } catch (err) {
      first ??= err;
    }
  }
  throw first;
}
