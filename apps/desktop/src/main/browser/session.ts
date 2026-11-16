// The built-in browser's session and its <webview>s: browser/policy.ts's rules applied where Electron asks.
// Typed against the few members used, so tests can pass plain objects.
import type { WebContents } from "electron";
import { blocksLocalRequest, lockWebview, navigable, permits } from "./policy";

interface RequestDetails {
  url: string;
  resourceType: string;
  webContents?: { getURL(): string } | undefined;
}

/** The parts of Electron's Session the browser sets up. */
export interface BrowserSessionLike {
  setPermissionRequestHandler(
    h: (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    h: (wc: unknown, permission: string) => boolean,
  ): void;
  setDevicePermissionHandler(h: () => boolean): void;
  webRequest: {
    onBeforeRequest(
      listener: (
        details: RequestDetails,
        callback: (r: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
  on(
    event: "will-download",
    listener: (e: unknown, item: DownloadItemLike) => void,
  ): unknown;
}

export interface DownloadItemLike {
  getFilename(): string;
  getTotalBytes(): number;
  getURL(): string;
  getSavePath(): string;
}

export interface BrowserSessionOptions {
  /** One line for the app's log (requests stopped, downloads). */
  log?: (line: string) => void;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}…` : u.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Sets up the browser's session once: every permission refused, requests from an outside page into this machine
 * or the local network stopped, downloads left to Electron's own save prompt (no save path is set here, so each
 * one asks where to save; nothing is saved or opened on its own).
 */
export function setupBrowserSession(
  ses: BrowserSessionLike,
  o: BrowserSessionOptions = {},
): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    o.log?.(`browser: permission refused (${permission})`);
    callback(permits(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => permits(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const top =
      details.resourceType === "mainFrame"
        ? undefined
        : details.webContents?.getURL();
    const cancel = blocksLocalRequest(details.url, top);
    if (cancel)
      o.log?.(
        `browser: request to a local address stopped (${shortUrl(details.url)} from ${shortUrl(top ?? "")})`,
      );
    callback({ cancel });
  });
  ses.on("will-download", (_e, item) => {
    o.log?.(
      `browser: download asked (${item.getFilename()}, ${item.getTotalBytes()} bytes, ${shortUrl(item.getURL())})`,
    );
  });
}

/** A guest page (a <webview>'s WebContents): the parts the browser wires. */
export type GuestLike = Pick<
  WebContents,
  "getURL" | "setWindowOpenHandler" | "on"
>;
export interface WebviewOptions {
  /** A page asked for a new window (a link with target=_blank, window.open): it opens as a new tab instead. */
  openTab(url: string, opener: GuestLike): void;
  log?: (line: string) => void;
}

/** Locks every <webview> the app window attaches and wires its page's new windows and navigations. */
export function guardWebviews(
  host: Pick<WebContents, "on">,
  o: WebviewOptions,
): void {
  host.on("will-attach-webview", (e, prefs, params) => {
    if (
      !lockWebview(
        prefs as unknown as Record<string, unknown>,
        params as unknown as Record<string, unknown>,
      )
    ) {
      o.log?.(
        `browser: webview refused (${shortUrl(String(params.src ?? ""))})`,
      );
      e.preventDefault();
    }
  });
  host.on("did-attach-webview", (_e, guest) => wireGuest(guest, o));
}

export function wireGuest(guest: GuestLike, o: WebviewOptions): void {
  guest.setWindowOpenHandler(({ url }) => {
    if (navigable(url) && url !== "about:blank") o.openTab(url, guest);
    return { action: "deny" };
  });
  // Navigations the page starts (links, scripts, forms); an address the person types is loaded, not navigated here.
  const check = (e: { preventDefault(): void }, url: string) => {
    if (
      !navigable(url) ||
      blocksLocalRequest(url, guest.getURL() || undefined)
    ) {
      o.log?.(`browser: navigation stopped (${shortUrl(url)})`);
      e.preventDefault();
    }
  };
  guest.on("will-navigate", check);
  guest.on("will-redirect", check);
}
