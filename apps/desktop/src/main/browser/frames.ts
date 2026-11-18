// The frames inside a page (iframes), for the agent's tools: read, find and act on what is in them. The page itself
// is read in Electron's isolated world (snapshot.ts); a frame is reached through the DevTools protocol: an isolated
// world of our own in it (Page.createIsolatedWorld, the page's scripts cannot see it), and for a frame of another
// site, which runs in its own process, the protocol session attached to it (Target.setAutoAttach, flatten).
// Where a frame sits in the page (to click what is in it) is its owner element's box, frame by frame up to the top.
import type { AgentPage } from './agent';

export interface FrameInfo {
  /** Stable while the frame lives: its frame id. */
  frameId: string;
  /** The protocol session it is reached in (undefined: the page's own). */
  sessionId?: string;
  /** Its parent frame and the session that one is in. */
  parentFrameId: string;
  parentSessionId?: string;
  url: string;
  /** 1 for a frame in the page, 2 for a frame in that frame, … */
  depth: number;
}

interface TreeNode {
  frame: { id: string; url: string; urlFragment?: string };
  childFrames?: TreeNode[];
}

/** Most frames read in one page (ads and trackers come in dozens). */
export const FRAME_LIMIT = 20;
/** Frames deeper than this are left out. */
const DEPTH_LIMIT = 4;
const WORLD = 'spica-agent';

/** What the box script returns: where the frame's content starts in its parent's viewport, and whether it shows. */
const OWNER_BOX = `function () {
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  const shown = r.width >= 2 && r.height >= 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  return { x: r.left + this.clientLeft + (parseFloat(s.paddingLeft) || 0), y: r.top + this.clientTop + (parseFloat(s.paddingTop) || 0), shown };
}`;

const SCROLL_OWNER = `function () { this.scrollIntoView({ block: 'center', inline: 'center' }); }`;

/** One page's frames (kept per page: the sessions of other-process frames, our world in each frame). */
export class PageFrames {
  readonly #page: AgentPage;
  /** Sessions of frames in other processes, by their frame id (= target id). */
  readonly #sessions = new Map<string, string>();
  /** Our world in each frame: `${sessionId}|${frameId}` → execution context id. */
  readonly #worlds = new Map<string, number>();
  #mainFrameId = '';
  #ready: Promise<void> | null = null;

  constructor(page: AgentPage) {
    this.#page = page;
    page.onCdp?.((method, params) => {
      if (method === 'Target.attachedToTarget') {
        const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
        const sid = String(params.sessionId ?? '');
        if (info?.type === 'iframe' && info.targetId && sid) {
          this.#sessions.set(info.targetId, sid);
          // its own frames in yet other processes, and our hooks for the console and network there
          void page.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => undefined);
          for (const l of this.#attachedListeners) l(sid);
        }
      } else if (method === 'Target.detachedFromTarget') {
        const sid = String(params.sessionId ?? '');
        for (const [frame, s] of this.#sessions) if (s === sid) this.#sessions.delete(frame);
        for (const k of [...this.#worlds.keys()]) if (k.startsWith(`${sid}|`)) this.#worlds.delete(k);
      }
    });
    // attached again (after a detach): the sessions start over
    page.onAttached?.(async () => {
      this.#sessions.clear();
      this.#worlds.clear();
      this.#ready = null;
    });
  }

  readonly #attachedListeners = new Set<(sessionId: string) => void>();

  /** Told of each protocol session of a frame in another process, as it is attached. */
  onFrameSession(l: (sessionId: string) => void): void {
    this.#attachedListeners.add(l);
  }

  async #init(): Promise<void> {
    this.#ready ??= this.#page.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).then(
      () => undefined,
      () => {
        this.#ready = null;
      },
    );
    return this.#ready;
  }

  /** The page's frames (not the page itself), in document order, at most FRAME_LIMIT. */
  async list(): Promise<FrameInfo[]> {
    await this.#init();
    const out: FrameInfo[] = [];
    const tree = (await this.#page.cdp('Page.getFrameTree').catch(() => undefined)) as { frameTree?: TreeNode } | undefined;
    const root = tree?.frameTree;
    if (!root?.frame?.id) return out;
    this.#mainFrameId = root.frame.id;
    const walk = async (node: TreeNode, sessionId: string | undefined, depth: number): Promise<void> => {
      for (const child of node.childFrames ?? []) {
        if (out.length >= FRAME_LIMIT) return;
        const own = this.#sessions.get(child.frame.id);
        const info: FrameInfo = { frameId: child.frame.id, ...(own ? { sessionId: own } : sessionId ? { sessionId } : {}), parentFrameId: node.frame.id, ...(sessionId ? { parentSessionId: sessionId } : {}), url: child.frame.url + (child.frame.urlFragment ?? ''), depth };
        out.push(info);
        if (depth >= DEPTH_LIMIT) continue;
        if (own) {
          // a frame in another process: its own tree, from its own session
          const sub = (await this.#page.cdp('Page.getFrameTree', undefined, own).catch(() => undefined)) as { frameTree?: TreeNode } | undefined;
          if (sub?.frameTree) await walk(sub.frameTree, own, depth + 1);
        } else {
          await walk(child, sessionId, depth + 1);
        }
      }
    };
    await walk(root, undefined, 1);
    return out;
  }

  async #world(frameId: string, sessionId: string | undefined): Promise<number> {
    const key = `${sessionId ?? ''}|${frameId}`;
    const had = this.#worlds.get(key);
    if (had !== undefined) return had;
    const r = (await this.#page.cdp('Page.createIsolatedWorld', { frameId, worldName: WORLD, grantUniveralAccess: false }, sessionId)) as { executionContextId?: number };
    if (typeof r?.executionContextId !== 'number') throw new Error('the frame could not be read');
    this.#worlds.set(key, r.executionContextId);
    return r.executionContextId;
  }

  /** Runs a script in our world in the frame; its value (JSON-able). Run again in a new world once when the frame was reloaded. */
  async evaluate(frame: Pick<FrameInfo, 'frameId' | 'sessionId'>, code: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.#world(frame.frameId, frame.sessionId);
      try {
        const r = (await this.#page.cdp('Runtime.evaluate', { expression: code, contextId, returnByValue: true, awaitPromise: true }, frame.sessionId)) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script error');
        return r?.result?.value;
      } catch (e) {
        // the frame navigated: its world is gone (Cannot find context / Execution context was destroyed)
        this.#worlds.delete(`${frame.sessionId ?? ''}|${frame.frameId}`);
        if (attempt === 1 || !/context/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
    return undefined;
  }

  /** A script's value as a protocol object (an element, for setting files on it). */
  async evaluateHandle(frame: Pick<FrameInfo, 'frameId' | 'sessionId'>, code: string): Promise<string | undefined> {
    const contextId = await this.#world(frame.frameId, frame.sessionId);
    const r = (await this.#page.cdp('Runtime.evaluate', { expression: code, contextId, returnByValue: false }, frame.sessionId)) as { result?: { objectId?: string; subtype?: string } };
    return r?.result?.subtype === 'null' ? undefined : r?.result?.objectId;
  }

  async #ownerCall(frame: FrameInfo, fn: string): Promise<unknown> {
    const owner = (await this.#page.cdp('DOM.getFrameOwner', { frameId: frame.frameId }, frame.parentSessionId)) as { backendNodeId?: number };
    if (typeof owner?.backendNodeId !== 'number') throw new Error('the frame is not on the page any more');
    const ctx = await this.#world(frame.parentFrameId, frame.parentSessionId);
    const node = (await this.#page.cdp('DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: ctx }, frame.parentSessionId)) as { object?: { objectId?: string } };
    if (!node?.object?.objectId) throw new Error('the frame is not on the page any more');
    const r = (await this.#page.cdp('Runtime.callFunctionOn', { objectId: node.object.objectId, functionDeclaration: fn, returnByValue: true }, frame.parentSessionId)) as { result?: { value?: unknown } };
    return r?.result?.value;
  }

  /**
   * Where the frame's content starts in the page's viewport (CSS px), and whether it and every frame around it show.
   * `frames`: the list it came from (its parents are found there).
   */
  async offset(frame: FrameInfo, frames: readonly FrameInfo[]): Promise<{ x: number; y: number; shown: boolean }> {
    let x = 0;
    let y = 0;
    let shown = true;
    for (let f: FrameInfo | undefined = frame; f; f = frames.find((p) => p.frameId === f!.parentFrameId)) {
      const box = (await this.#ownerCall(f, OWNER_BOX).catch(() => undefined)) as { x?: number; y?: number; shown?: boolean } | undefined;
      if (!box) return { x: 0, y: 0, shown: false };
      x += Number(box.x) || 0;
      y += Number(box.y) || 0;
      shown &&= box.shown === true;
      if (f.parentFrameId === this.#mainFrameId) break;
    }
    return { x: Math.round(x), y: Math.round(y), shown };
  }

  /** Brings the frame into view in each frame around it, from the top down. */
  async scrollIntoView(frame: FrameInfo, frames: readonly FrameInfo[]): Promise<void> {
    const chain: FrameInfo[] = [];
    for (let f: FrameInfo | undefined = frame; f; f = frames.find((p) => p.frameId === f!.parentFrameId)) chain.unshift(f);
    for (const f of chain) await this.#ownerCall(f, SCROLL_OWNER).catch(() => undefined);
  }
}

const kept = new WeakMap<AgentPage, PageFrames>();

/** The frames helper of a page (one per page). */
export function pageFrames(page: AgentPage): PageFrames {
  let f = kept.get(page);
  if (!f) kept.set(page, (f = new PageFrames(page)));
  return f;
}
