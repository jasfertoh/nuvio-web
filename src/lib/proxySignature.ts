/**
 * Signatures for media-proxy URLs.
 *
 * The proxy fetches whatever URL it is handed, so it will not do that for
 * anyone who cannot show a session first. A signature covers one source URL
 * and an expiry, and the proxy mints it only for a caller the stack's own auth
 * service recognises.
 *
 * Minted once per source and then held, because the same source is asked about
 * several times over - its tracks, its subtitles, the playback itself - and a
 * round trip before each of those would be latency in the one place this app
 * has spent the most effort removing.
 */
type Signature = { exp: number; sig: string };

/**
 * Who can mint one. Registered by the account layer rather than imported from
 * it: minting needs a session, which only that layer has, while this module is
 * reached from the URL builders - and a dependency the other way would drag
 * the whole backend client into anything that builds a proxy URL.
 */
type Minter = (url: string) => Promise<Signature | null>;
let mint: Minter = async () => null;

export function registerProxySigner(minter: Minter): void {
  mint = minter;
}

const signatures = new Map<string, Signature>();
const inFlight = new Map<string, Promise<void>>();

/** Dropped a little early, so a signature is never used as it expires. */
const EARLY_SECONDS = 60;

function usable(entry: Signature | undefined): entry is Signature {
  return Boolean(entry && entry.exp - EARLY_SECONDS > Date.now() / 1000);
}

/**
 * Have a signature ready for this source. Safe to call repeatedly; the work
 * happens once. A failure is not thrown on: the proxy accepts unsigned
 * requests until it is switched to requiring them, and playback failing
 * because a signature could not be minted would be the worse outcome.
 */
export async function ensureProxySignature(sourceUrl: string): Promise<void> {
  if (!sourceUrl || usable(signatures.get(sourceUrl))) return;
  const running = inFlight.get(sourceUrl);
  if (running) return running;
  const work = mint(sourceUrl)
    .then((signed) => {
      if (signed?.sig) signatures.set(sourceUrl, signed);
    })
    .catch(() => {
      // Left unsigned; see above.
    })
    .finally(() => {
      inFlight.delete(sourceUrl);
    });
  inFlight.set(sourceUrl, work);
  return work;
}

/**
 * The query fragment to append, or "" if there is nothing yet. Deliberately
 * synchronous: the URL builders it serves are called while composing an
 * element's src, which cannot wait.
 */
export function proxySignatureQuery(sourceUrl: string): string {
  const entry = signatures.get(sourceUrl);
  if (!usable(entry)) return "";
  return `&exp=${entry.exp}&sig=${encodeURIComponent(entry.sig)}`;
}

/** Signing out should not leave one profile's signatures for the next. */
export function forgetProxySignatures(): void {
  signatures.clear();
  inFlight.clear();
}
