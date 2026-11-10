// Model settings through Spica's MCP service: an agent on this machine (one the
// user connected through "allow local scripts") lists, tests and saves model
// connections for the user. A connection is one provider address with one key
// and the models ticked under it; the default and the strong model each point
// at a connection and one of its models. The settings live with the host (the
// desktop shell stores them, secrets encrypted); the core reaches it through
// host methods on the backend port and never hands a secret back out:
//   - no tool result contains an API key or a Consumer Secret (only hasSecret);
//     a Consumer Key comes back masked (protocol keyMaskText)
//   - every secret received is added to the redaction table at once
//   - every ticked model has a context window: given, from the catalog, or
//     matched by name (marked so); otherwise nothing is saved
//   - a change applies at once and is shown in the conversations (event
//     settings.changed, and a note with meta.settingsChange in the main
//     conversation and the one open in the window, so it stays in the history);
//     with the runtime's confirmSettingsChanges on it first waits for the user's
//     confirmation in the window (cause settings_change, answerable only there)
//   - each change leaves a traceable record (kind settings) with field names only
import { isoNow } from './events.ts';
import { fence } from './guard.ts';
import type { ProviderConfig } from './host/backend.ts';
import type { McpTool } from './mcp/server.ts';
import type { Runtime } from './runtime.ts';
import type { Session } from './session.ts';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
import { catalogProvider } from './catalog/catalog.ts';
import { listProviderModels } from './catalog/list-models.ts';
import type { ProbeResult, SettingsChangeMeta } from './types.ts';

type CoreKind = 'openai-compatible' | 'anthropic' | 'wso2';

/** Where a ticked model's context window came from (the form marks name matches). */
export type ContextFrom = 'user' | 'catalog' | 'provider' | 'name-match';

export interface HostConnectionModel {
  id: string;
  /**
   * Required for an enabled model. 0 or null = missing (e.g. moved over from older
   * settings, or a disabled model): the tools say so and ask for it when it is enabled.
   */
  contextWindow: number | null;
  contextFrom: ContextFrom;
  /** false: kept in the connection's list but not in use (not offered, not a default); absent = true. */
  enabled?: boolean;
}

/** A model connection as the host lists it: one address, one key, the models ticked under it (no secret). */
export interface HostConnection {
  id: string;
  kind: CoreKind;
  name: string;
  baseUrl: string;
  tokenUrl: string;
  /** WSO2: the OAuth client id (Consumer Key), in full: the core masks it before it leaves. */
  clientId: string;
  scope: string;
  /** The catalog provider or company preset it was set up from (prices, context windows, how to list models). */
  catalogId?: string;
  maxConcurrent: number | null;
  requestsPerMinute: number | null;
  hasSecret: boolean;
  /** Cannot be changed here (e.g. comes from a developer file). */
  readOnly?: boolean;
  models: HostConnectionModel[];
}

/** A connection and one of its models (the default, the strong one). */
export interface HostModelPointer {
  connectionId: string;
  model: string;
}

/** What 'models.list' answers. */
export interface HostModelList {
  connections: HostConnection[];
  default: HostModelPointer | null;
  strong: HostModelPointer | null;
}

/** What the core asks the host to save: the whole list of ticked models; `secret` undefined keeps the saved one. */
export type HostConnectionDraft = Omit<HostConnection, 'id' | 'hasSecret' | 'readOnly'> & { id?: string; secret?: string };

/**
 * How the settings tools reach the host and the providers (set by startBackend).
 * Host methods: 'models.list' () → HostModelList; 'models.save'
 * (HostConnectionDraft) → HostConnection (the ticked models replace the saved
 * ones; a pointer to a model that went away moves: to the first model left in
 * that connection, else the first one anywhere, else none), the host then sends
 * the providers to the core with configure() as it does for its own settings
 * page, with the same ids; 'models.setDefault' (HostModelPointer);
 * 'models.setStrong' (HostModelPointer | null); optional 'ui.activeSession' ().
 */
export interface SettingsBridge {
  host(method: string, params?: unknown[]): Promise<unknown>;
  probe(config: ProviderConfig, model: string): Promise<ProbeResult>;
  /** The provider configuration the core runs with now (includes its secret), or undefined. */
  providerConfig(id: string): ProviderConfig | undefined;
  network(): { proxy: string | null; noProxy: string[]; caFile: string | null; useSystemCa: boolean };
  /** How long a tool waits for the user's answer before saying it is still waiting. Default 2 minutes. */
  waitMs?: number;
}

export class SettingsError extends Error {
  override name = 'SettingsError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

const KINDS: CoreKind[] = ['openai-compatible', 'anthropic', 'wso2'];
const str = { type: 'string' } as const;
const int = { type: 'integer', minimum: 1 } as const;
const modelItem = {
  type: 'object',
  properties: { id: { ...str, description: 'Model name as the API takes it.' }, contextWindow: { ...int, description: 'Tokens it takes at once; leave out when the app knows it.' } },
  required: ['id'],
} as const;

const FIELDS = {
  id: { ...str, description: 'An existing connection (from spica_list_models) to change or test; leave out to add a new one.' },
  preset: {
    ...str,
    description: 'A provider or company preset from spica_list_presets: its kind, addresses and recommended models are filled in, so usually only the key (or Consumer Key and Secret) is needed.',
  },
  kind: { type: 'string', enum: KINDS, description: 'openai-compatible (incl. DeepSeek, relays and most gateways with a key), anthropic, or wso2 (WSO2 API gateway with Consumer Key / Secret).' },
  name: { ...str, description: 'Shown in the model list.' },
  baseUrl: { ...str, description: 'API address (usually ending in /v1). Optional for anthropic.' },
  tokenUrl: { ...str, description: 'wso2: the OAuth token endpoint.' },
  consumerKey: { ...str, description: 'wso2: Consumer Key (OAuth client id).' },
  consumerSecret: { ...str, description: 'wso2: Consumer Secret. Stored encrypted, never returned. Leave out to keep the saved one.' },
  apiKey: { ...str, description: 'openai-compatible / anthropic: the API key. Stored encrypted, never returned. Leave out to keep the saved one.' },
  scope: { ...str, description: 'wso2: OAuth scope, if the gateway needs one.' },
  maxConcurrent: { ...int, description: 'Requests at the same time over this connection (leave out: no limit).' },
  requestsPerMinute: { ...int, description: 'Requests per minute over this connection (leave out: no limit).' },
} as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** A Consumer Key as shown everywhere (protocol keyMaskParts / keyMaskText); empty when there is none. */
function maskKey(v: string): string {
  return v ? keyMaskText(keyMaskParts(v)) : '';
}

function kindOf(v: unknown): CoreKind | undefined {
  if (v === 'openai') return 'openai-compatible'; // the desktop shell's spelling
  return KINDS.includes(v as CoreKind) ? (v as CoreKind) : undefined;
}

const samePointer = (a: HostModelPointer | null | undefined, b: HostModelPointer | null | undefined) =>
  (a?.connectionId ?? null) === (b?.connectionId ?? null) && (a?.model ?? null) === (b?.model ?? null);

/** What an agent sees of a connection: no secret, the Consumer Key masked. */
function view(c: HostConnection, list: HostModelList) {
  const kind = kindOf(c.kind) ?? 'openai-compatible';
  return {
    id: c.id,
    kind,
    name: c.name,
    baseUrl: c.baseUrl,
    ...(kind === 'wso2' ? { tokenUrl: c.tokenUrl, consumerKey: maskKey(c.clientId), scope: c.scope || null } : {}),
    ...(c.catalogId ? { preset: c.catalogId } : {}),
    models: c.models.map((m) => ({
      ...m,
      enabled: m.enabled !== false,
      // 0 / null = none yet (older settings, or a disabled model): say so instead of showing a number
      ...((m.contextWindow ?? 0) > 0 ? {} : { contextWindow: null, ...(m.enabled !== false ? { needsContextWindow: true } : {}) }),
      ...(list.default?.connectionId === c.id && list.default.model === m.id ? { isDefault: true } : {}),
      ...(list.strong?.connectionId === c.id && list.strong.model === m.id ? { isStrong: true } : {}),
    })),
    maxConcurrent: c.maxConcurrent,
    requestsPerMinute: c.requestsPerMinute,
    hasSecret: c.hasSecret,
    ...(c.readOnly ? { readOnly: true } : {}),
  };
}

/** Test result for an agent: the two steps, the code and the Chinese hint from NET_HINTS. */
function testView(kind: CoreKind, model: string, r: ProbeResult) {
  const twoSteps = kind === 'wso2';
  const token = !twoSteps ? 'n/a' : r.ok || r.stage === 'model' ? 'ok' : 'failed';
  const step = r.ok ? 'ok' : r.stage === 'token' ? 'skipped' : 'failed';
  return {
    ok: r.ok,
    model,
    steps: { token, model: step },
    ...(r.code ? { code: r.code } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
    ...(r.message ? { message: r.message } : {}),
    latencyMs: r.latencyMs,
    ...(r.firstByteMs !== undefined ? { firstByteMs: r.firstByteMs } : {}),
    ...(r.model ? { serverModel: r.model } : {}),
    ...(r.suggestedBaseUrl ? { suggestedBaseUrl: r.suggestedBaseUrl } : {}),
  };
}

type Args = Record<string, unknown>;
type Wanted = { id: string; contextWindow?: number; enabled?: boolean };
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : v === undefined ? undefined : NaN);
/** [{ id, contextWindow? }] from a list of objects or of names. */
const modelArgs = (v: unknown): Wanted[] | undefined =>
  Array.isArray(v)
    ? v
        .map((x) =>
          typeof x === 'string'
            ? { id: x.trim() }
            : {
                id: String((x as { id?: unknown })?.id ?? '').trim(),
                contextWindow: count((x as { contextWindow?: unknown })?.contextWindow),
                enabled: (x as { enabled?: unknown })?.enabled === false ? false : undefined,
              },
        )
        .filter((x) => x.id)
        .map((x) => ({ id: x.id, ...('contextWindow' in x && x.contextWindow !== undefined ? { contextWindow: x.contextWindow } : {}), ...('enabled' in x && x.enabled === false ? { enabled: false } : {}) }))
    : undefined;

export function settingsTools(rt: Runtime): McpTool[] {
  const app = rt.appName;
  const bridge = (): SettingsBridge => {
    const b = rt.settingsBridge;
    if (!b) throw new SettingsError('host_unavailable', `model settings can be changed only while the ${app} window is open`);
    return b;
  };
  const host = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    try {
      return (await bridge().host(method, params)) as T;
    } catch (err) {
      if (err instanceof SettingsError) throw err;
      const code = (err as { code?: unknown })?.code;
      if (code === 'host_unavailable') throw new SettingsError('host_unavailable', `model settings can be changed only while the ${app} window is open`);
      throw new SettingsError(typeof code === 'string' ? code : 'host_failed', rt.redact(err instanceof Error ? err.message : String(err)));
    }
  };
  const list = async (): Promise<HostModelList> => {
    const l = await host<HostModelList | undefined>('models.list');
    return { connections: l?.connections ?? [], default: l?.default ?? null, strong: l?.strong ?? null };
  };
  const waiting = new Map<string, Promise<unknown>>();

  /** A context window for each model: given, the catalog's, or matched by name; the ones without are named. */
  const windows = (kind: CoreKind, catalogId: string | undefined, wanted: Wanted[], keep: HostConnectionModel[]) => {
    const out: HostConnectionModel[] = [];
    const missing: string[] = [];
    for (const w of wanted) {
      const kept = keep.find((m) => m.id === w.id);
      const off = w.enabled === false ? { enabled: false } : {};
      if (Number.isNaN(w.contextWindow)) throw new SettingsError('invalid', `a positive whole number (field contextWindow of ${w.id})`);
      if (w.contextWindow) out.push({ id: w.id, contextWindow: w.contextWindow, contextFrom: 'user', ...off });
      else if (kept && (kept.contextWindow ?? 0) > 0) out.push({ id: kept.id, contextWindow: kept.contextWindow, contextFrom: kept.contextFrom, ...off });
      else {
        const found = rt.ledger.matchContextWindow(kind, w.id, catalogId);
        if (found) out.push({ id: w.id, contextWindow: found.contextWindow, contextFrom: found.how === 'exact' ? 'catalog' : 'name-match', ...off });
        // a disabled model may stay without one; it needs one when it is enabled
        else if (w.enabled === false) out.push({ id: w.id, contextWindow: kept?.contextWindow ?? null, contextFrom: kept?.contextFrom ?? 'user', enabled: false });
        else missing.push(w.id);
      }
    }
    if (missing.length) {
      throw new SettingsError('context_window_required', `${app} does not know how many tokens ${missing.join(', ')} take at once: ask the user and pass contextWindow for each`);
    }
    return out;
  };

  /** The saved connection merged with what the agent gave, validated; secrets registered for redaction. */
  const draftFrom = async (a: Args, purpose: 'test' | 'save' | 'list') => {
    const all = await (purpose === 'save' || text(a.id) ? list() : Promise.resolve<HostModelList>({ connections: [], default: null, strong: null }));
    const id = text(a.id) || undefined;
    let existing: HostConnection | undefined;
    if (id) {
      existing = all.connections.find((c) => c.id === id);
      if (!existing) throw new SettingsError('not_found', `no model connection with id ${id} (see spica_list_models)`);
      if (existing.readOnly && purpose === 'save') throw new SettingsError('read_only', `${id} cannot be changed here`);
    }
    const presetId = text(a.preset) || undefined;
    const preset = catalogProvider(rt.catalog, presetId);
    if (presetId && !preset) throw new SettingsError('not_found', `no preset ${presetId} (see spica_list_presets)`);
    // what the preset fills in (a saved connection keeps its own values; what the agent gives wins)
    const fromPreset = preset && !existing;
    const kind = a.kind !== undefined ? kindOf(a.kind) : existing ? kindOf(existing.kind) : preset?.kind;
    if (!kind) throw new SettingsError('invalid', `kind must be one of ${KINDS.join(', ')}`);
    const pick = (k: string, from: string) => text(a[k]) ?? from;
    const catalogId = existing?.catalogId ?? preset?.id;

    // the ticked models: the whole list, or the saved ones plus / minus some; a new preset connection gets its recommended ones
    const given = modelArgs(a.models);
    const single = text(a.model) ? [{ id: text(a.model)!, ...(a.contextWindow !== undefined ? { contextWindow: count(a.contextWindow) } : {}) }] : undefined;
    const add = [...(modelArgs(a.addModels) ?? []), ...(given ? [] : (single ?? []))];
    const names = (v: unknown) => new Set((Array.isArray(v) ? v : []).map((x) => String(typeof x === 'string' ? x : ((x as { id?: unknown })?.id ?? ''))));
    const remove = names(a.removeModels);
    const disable = names(a.disableModels);
    const enable = modelArgs(a.enableModels) ?? [];
    const before = existing?.models ?? [];
    let wanted: Wanted[] =
      given ??
      (existing
        ? before.map((m) => ({ id: m.id, ...(m.enabled === false ? { enabled: false } : {}) }))
        : fromPreset
          ? preset.models.filter((m) => m.role === 'default' || m.role === 'strong').map((m) => ({ id: m.id }))
          : []);
    if (fromPreset && !given && wanted.length === 0 && preset.models[0]) wanted = [{ id: preset.models[0].id }];
    for (const m of [...add, ...enable]) {
      const i = wanted.findIndex((w) => w.id === m.id);
      if (i >= 0) wanted[i] = { ...m }; // enabled again
      else wanted.push(m);
    }
    wanted = wanted.filter((w) => !remove.has(w.id)).map((w) => (disable.has(w.id) ? { ...w, enabled: false } : w));
    if (purpose === 'save' && wanted.length === 0) throw new SettingsError('invalid', 'at least one model (field models)');
    if (purpose === 'save' && !wanted.some((w) => w.enabled !== false)) throw new SettingsError('invalid', 'at least one enabled model (fields models / enableModels)');

    const d: HostConnectionDraft = {
      ...(id ? { id } : {}),
      kind,
      name: pick('name', existing?.name ?? (fromPreset ? preset.name : '')),
      baseUrl: pick('baseUrl', existing?.baseUrl ?? (fromPreset ? preset.baseUrl : kind === 'anthropic' ? 'https://api.anthropic.com/v1' : '')),
      tokenUrl: pick('tokenUrl', existing?.tokenUrl ?? (fromPreset ? (preset.tokenUrl ?? '') : '')),
      clientId: pick('consumerKey', existing?.clientId ?? ''),
      scope: pick('scope', existing?.scope ?? (fromPreset ? (preset.scope ?? '') : '')),
      ...(catalogId ? { catalogId } : {}),
      maxConcurrent: count(a.maxConcurrent) ?? existing?.maxConcurrent ?? (fromPreset ? (preset.maxConcurrent ?? null) : null),
      requestsPerMinute: count(a.requestsPerMinute) ?? existing?.requestsPerMinute ?? (fromPreset ? (preset.requestsPerMinute ?? null) : null),
      models: [],
    };
    const typed = text(kind === 'wso2' ? (a.consumerSecret ?? a.apiKey) : (a.apiKey ?? a.consumerSecret));
    if (typed) d.secret = typed;
    // known secrets and addresses never show up in errors, records or exports from here on
    rt.addRedactions([typed, d.clientId, d.baseUrl, d.tokenUrl]);
    // (the field name after the reason: "apiKey: …" would read as a key to the redaction)
    const bad = (field: string, why: string) => new SettingsError('invalid', `${why} (field ${field})`);
    if (purpose === 'save' && !d.name) throw bad('name', 'required (shown in the model list)');
    const url = /^https?:\/\/[^\s/]+/i;
    if (kind !== 'anthropic' && !d.baseUrl) throw bad('baseUrl', 'required');
    if (d.baseUrl && !url.test(d.baseUrl)) throw bad('baseUrl', 'must start with http:// or https://');
    if (kind === 'wso2') {
      if (!d.tokenUrl) throw bad('tokenUrl', 'required for wso2');
      if (!url.test(d.tokenUrl)) throw bad('tokenUrl', 'must start with http:// or https://');
      if (!d.clientId) throw bad('consumerKey', 'required for wso2');
    }
    for (const k of ['maxConcurrent', 'requestsPerMinute'] as const) if (Number.isNaN(d[k])) throw bad(k, 'a positive whole number');
    const needsKey = catalogProvider(rt.catalog, d.catalogId)?.needsKey ?? true;
    const running = id ? bridge().providerConfig(id) : undefined;
    const secret = d.secret ?? (kind === 'wso2' ? running?.oauth?.clientSecret : running?.apiKey);
    if (!secret && (needsKey || kind === 'wso2')) {
      throw bad(kind === 'wso2' ? 'consumerSecret' : 'apiKey', existing?.hasSecret ? 'the saved one cannot be read; give it again' : 'required');
    }
    if (purpose === 'save') d.models = windows(kind, catalogId, wanted, before);
    const config: ProviderConfig = {
      id: id ?? 'settings-draft',
      kind,
      ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
      ...(kind === 'wso2'
        ? { oauth: { tokenUrl: d.tokenUrl, clientId: d.clientId, clientSecret: secret ?? '', ...(d.scope ? { scope: d.scope } : {}) } }
        : secret
          ? { apiKey: secret }
          : {}),
      ...(d.catalogId ? { catalogId: d.catalogId } : {}),
    };
    const added = d.models.filter((m) => !before.some((b) => b.id === m.id)).map((m) => m.id);
    const removed = before.filter((b) => !d.models.some((m) => m.id === b.id)).map((m) => m.id);
    const was = (id: string) => before.find((b) => b.id === id);
    const enabledNow = d.models.filter((m) => m.enabled !== false && was(m.id)?.enabled === false).map((m) => m.id);
    const disabledNow = d.models.filter((m) => m.enabled === false && was(m.id) && was(m.id)!.enabled !== false).map((m) => m.id);
    const changes = existing
      ? (['kind', 'name', 'baseUrl', 'tokenUrl', 'scope', 'maxConcurrent', 'requestsPerMinute'] as const)
          .filter((k) => (k === 'kind' ? kindOf(existing.kind) !== d.kind : existing[k] !== d[k]))
          .map(String)
          .concat(
            existing.clientId !== d.clientId ? ['consumerKey'] : [],
            d.secret ? [kind === 'wso2' ? 'consumerSecret' : 'apiKey'] : [],
            added.length || removed.length || enabledNow.length || disabledNow.length || d.models.some((m) => was(m.id) && was(m.id)!.contextWindow !== m.contextWindow) ? ['models'] : [],
          )
      : ['new'];
    // the model to test: an enabled one being added or enabled, else the one asked for, else the first enabled one
    const on = (id: string) => wanted.find((w) => w.id === id)?.enabled !== false;
    const testModel = [...added, ...enabledNow].find(on) ?? text(a.model) ?? (wanted.find((w) => w.enabled !== false)?.id || wanted[0]?.id || '');
    return { d, config, existing, changes, added, removed, enabledNow, disabledNow, testModel, all };
  };

  const test = async (kind: CoreKind, config: ProviderConfig, model: string) => testView(kind, model, await bridge().probe(config, model));

  const record = (o: { id: string; changes: string[]; status: 'ok' | 'error' | 'aborted'; confirmed: boolean; error?: string }) =>
    rt.tracer
      .start({
        kind: 'settings',
        sessionId: null,
        parentChain: [],
        initiator: 'mcp',
        target: 'models',
        providerId: o.id,
        changes: o.changes,
        // applied without asking (as set up) is recorded as such; a declined change has no confirmation
        ...(o.confirmed ? { confirmedBy: 'user' as const } : o.status === 'aborted' ? {} : { confirmedBy: 'none' as const }),
      })
      .finish({ status: o.status, ...(o.error ? { error: o.error } : {}) });

  /**
   * Show an applied change where the user looks: an event for the window, and a
   * note in the conversation open in the window (asked with the optional host
   * method 'ui.activeSession'), else in the assistant conversation used most
   * recently, kept in the history. The model there reads it as data: names and
   * model names come from the script.
   */
  const announce = async (change: SettingsChangeMeta) => {
    rt.events.emit(rt.eventHost, { type: 'settings.changed', change });
    // the conversation open in the window; else the one used most recently, so it is seen next time
    const targets = new Set<Session>();
    try {
      const open = await bridge().host('ui.activeSession');
      const s = typeof open === 'string' && open ? rt.session(open) : undefined;
      if (s) targets.add(s);
    } catch {
      // the window does not say which conversation is open
    }
    if (targets.size === 0) {
      try {
        targets.add(rt.top()); // a model is configured by now, so a conversation can be started
      } catch {
        // still no usable model: the event is all there is
      }
    }
    const what = {
      action: change.action,
      name: change.name,
      ...(change.addedModels?.length ? { addedModels: change.addedModels } : {}),
      ...(change.removedModels?.length ? { removedModels: change.removedModels } : {}),
      ...(change.model ? { model: change.model } : {}),
      changes: change.changes,
      confirmedByUser: change.confirmed,
    };
    const body = fence(JSON.stringify(what), 'mcp', 'settings', app).text;
    const note = `[The model settings were changed by a script connected to ${app}${change.confirmed ? ', confirmed by the user' : ', without asking the user (as set up)'}. Details:]\n${body}`;
    for (const s of targets) s.addNote('note', note, { author: 'runtime', settingsChange: change });
  };

  /** Ask the user (unless turned off), then run `apply`; says it is still waiting after waitMs. */
  const confirmThen = async (name: string, card: Record<string, unknown>, apply: (confirmed: boolean) => Promise<unknown>, declined: () => unknown) => {
    if (!rt.confirmSettingsChanges) return apply(false);
    const ask = rt.askOutsideSession({ name, input: card, reason: `a script connected to ${app} asks to change the model settings`, cause: 'settings_change', userOnly: true });
    const done = ask.answer.then((ok) => (ok ? apply(true) : declined()));
    return waitOrPending(ask.callId, done);
  };
  const waitOrPending = async (requestId: string, done: Promise<unknown>) => {
    waiting.set(requestId, done);
    void done.finally(() => setTimeout(() => waiting.delete(requestId), 15 * 60_000).unref?.()).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const still = new Promise((r) => (timer = setTimeout(() => r({ status: 'waiting_for_user', requestId, next: 'call spica_settings_result with this requestId' }), bridge().waitMs ?? 120_000)));
    try {
      return await Promise.race([done, still]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Set a pointer (default / strong) to a connection's model. */
  const pointerTo = (connectionId: string, model: string): HostModelPointer => ({ connectionId, model });

  /**
   * spica_save_model as scripts called it up to 0.1.0-rc.2 (one model per connection): makeDefault: true, strongModel,
   * contextWindow without model, model on a saved connection meaning "its model". What has one clear meaning now
   * works as before and is reported in the result (`legacy`); what is ambiguous is refused with the way to say it now.
   * When the old and the new spelling are both given, the new one wins.
   */
  const legacySave = async (raw: Args) => {
    const a: Args = { ...raw };
    const notes: LegacyNote[] = [];
    const existing = text(raw.id) ? (await list()).connections.find((c) => c.id === text(raw.id)) : undefined;
    let legacyDefault = false;
    if (typeof raw.makeDefault === 'boolean') {
      delete a.makeDefault;
      legacyDefault = raw.makeDefault;
      if (!raw.makeDefault) notes.push({ parameter: 'makeDefault', given: false, handledAs: 'nothing to do (as before)' });
    } else if (raw.makeDefault !== undefined && typeof raw.makeDefault !== 'string') {
      throw new SettingsError('invalid', 'makeDefault takes the name of one of this connection\'s models, e.g. makeDefault: "deepseek-flash" (true still works: its model) (field makeDefault)');
    }
    let legacyStrong: string | undefined;
    if (raw.strongModel !== undefined) {
      delete a.strongModel;
      const s = text(raw.strongModel);
      if (!s) throw new SettingsError('invalid', 'strongModel is a model name; it is now written makeStrong: "<model>" (field strongModel)');
      if (text(raw.makeStrong)) notes.push({ parameter: 'strongModel', given: s, handledAs: 'not used: makeStrong was given too (the newer parameter wins)' });
      else {
        legacyStrong = s;
        // as before, the strong model is one of the connection's models
        const ticked = (existing?.models ?? []).some((m) => m.id === s) || text(raw.model) === s || (modelArgs(raw.models) ?? []).some((m) => m.id === s);
        if (!ticked && raw.models === undefined) a.addModels = [...(modelArgs(raw.addModels) ?? []), { id: s }];
      }
    }
    if (raw.contextWindow !== undefined && !text(raw.model)) {
      // before, a connection had one model and contextWindow was its window
      const on = (existing?.models ?? []).filter((m) => m.enabled !== false);
      if (existing && on.length === 1) {
        a.model = on[0]!.id;
        notes.push({ parameter: 'contextWindow', given: raw.contextWindow, handledAs: `the context window of ${on[0]!.id}, the connection's one model` });
      } else {
        throw new SettingsError(
          'invalid',
          'contextWindow needs the model it is for (a connection can have several models now): pass model with it, or models / addModels: [{ id, contextWindow }] (field contextWindow)',
        );
      }
    }
    const single = text(raw.model);
    if (existing && single && !existing.models.some((m) => m.id === single) && raw.models === undefined && raw.addModels === undefined) {
      // before, model on a saved connection replaced its model; now a connection has several, and replacing or adding cannot be told apart
      throw new SettingsError(
        'invalid',
        `${single} is not one of this connection's models. Up to 0.1.0-rc.2, model replaced a connection's model; now a connection has several: pass addModels: [{ id: "${single}" }] to add it, or models: [...] for the whole list (field model)`,
      );
    }
    return { a, notes, legacyDefault, legacyStrong };
  };

  const tools: McpTool[] = [
    {
      name: 'spica_list_presets',
      description:
        `The providers ${app} knows (company presets first, then providers in China, international, on this machine): kind, API address, whether a key is needed, ` +
        'and a short list of models with context windows and official prices where known. Pass a preset id to spica_save_model to fill in the address and models.',
      inputSchema: obj({}),
      run: async () =>
        rt.catalog.providers.map((p) => ({
          id: p.id,
          name: p.name,
          group: p.group,
          kind: p.kind,
          baseUrl: p.baseUrl,
          ...(p.tokenUrl ? { tokenUrl: p.tokenUrl } : {}),
          ...(p.scope ? { scope: p.scope } : {}),
          needsKey: p.needsKey,
          canListModels: p.listModels !== 'none',
          ...(p.docsUrl ? { docsUrl: p.docsUrl } : {}),
          // only official prices: a model without one has none here
          models: p.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}), contextWindow: m.contextWindow, ...(m.role ? { role: m.role } : {}), ...(m.price ? { price: m.price } : {}) })),
        })),
    },
    {
      name: 'spica_list_provider_models',
      description:
        'Ask a provider which models it has now: a saved connection by id, or a preset with its key. Context windows come from the answer when the provider gives them, ' +
        'else from the short list. When the provider has no model list (code list.unsupported) or the key is refused, use the short list or a model name the user gives.',
      inputSchema: obj(FIELDS),
      run: async (a) => {
        const { config } = await draftFrom(a, 'list');
        return listProviderModels(
          {
            kind: config.kind,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            ...(config.oauth ? { oauth: config.oauth } : {}),
            ...(config.catalogId ? { catalogId: config.catalogId } : {}),
          },
          rt.catalog,
        );
      },
    },
    {
      name: 'spica_list_models',
      description:
        `The model connections set up in ${app}: each is one address with one key and the models ticked under it (with their context windows); which model is the default and which the strong one. ` +
        'No keys or secrets: hasSecret says whether one is saved; the Consumer Key is shown masked (at most its first and last 4 characters). A second key for the same provider is a second connection.',
      inputSchema: obj({}),
      run: async () => {
        const l = await list();
        return { connections: l.connections.map((c) => view(c, l)), default: l.default, strong: l.strong };
      },
    },
    {
      name: 'spica_test_model',
      description:
        'Test a connection without saving it: a saved one by id, or a preset / the fields of a new one (with its key / secret); `model` picks which of its models (default: the first). ' +
        'WSO2 is tested in two steps (getting a token, then calling the model). On failure: code, and hint (Chinese) saying what to change.',
      inputSchema: obj({
        ...FIELDS,
        model: { ...str, description: 'Which model to test.' },
        strongModel: { ...str, description: 'Older parameter: not used by a test (as before).' },
        contextWindow: { ...int, description: 'Older parameter: not used by a test (as before).' },
      }),
      run: async (raw) => {
        const { strongModel, contextWindow, ...a } = raw;
        const notes: LegacyNote[] = [];
        if (strongModel !== undefined) notes.push({ parameter: 'strongModel', given: strongModel, handledAs: 'not used by a test (as before)' });
        if (contextWindow !== undefined) notes.push({ parameter: 'contextWindow', given: contextWindow, handledAs: 'not used by a test (as before)' });
        const { d, config, testModel } = await draftFrom(a, 'test');
        if (!testModel) throw new SettingsError('invalid', 'which model to test (field model)');
        const r = await test(d.kind, config, testModel);
        return notes.length ? { ...r, legacy: notes } : r;
      },
    },
    {
      name: 'spica_save_model',
      description:
        `Add (no id) or change (id) a model connection: one address and one key with the models ticked under it (several models of a provider share one key: ask for the key once). ` +
        'models replaces the list; addModels / removeModels add or remove models, disableModels / enableModels turn them off and on (a disabled model stays in the list, unused); ' +
        'a new connection from a preset gets the preset\'s recommended models when none are given. ' +
        `Every enabled model needs a context window: given, or known to ${app} (also matched by name for relays that spell it differently); otherwise nothing is saved. ` +
        `It tests one model first; a failed test saves nothing unless saveIfTestFails. The change is shown to the user in ${app}'s conversations (if ${app} is set up to ask first, it waits for the user to confirm in the window). ` +
        'Fields left out keep their saved value; the key / secret is stored encrypted and never returned. If the user has not answered yet the result is status waiting_for_user with a requestId for spica_settings_result. ' +
        'Parameters of scripts written for 0.1.0-rc.2 (makeDefault: true, strongModel, contextWindow alone) still work and the result says how they were taken (legacy); unknown parameters are refused.',
      inputSchema: obj({
        ...FIELDS,
        models: { type: 'array', items: modelItem, description: 'All models to tick (replaces the saved list).' },
        addModels: { type: 'array', items: modelItem, description: 'Models to tick in addition.' },
        removeModels: { type: 'array', items: str, description: 'Model names to remove from the connection\'s list.' },
        disableModels: { type: 'array', items: str, description: 'Model names to disable: kept in the list, not in use (no context window needed).' },
        enableModels: { type: 'array', items: modelItem, description: 'Disabled models to enable again (each needs a context window, given or known).' },
        model: { ...str, description: 'A new connection: its model (shorthand for models: [{ id }]). A saved one: one of its models, to change its contextWindow; to add one use addModels.' },
        contextWindow: { ...int, description: 'With model: its context window.' },
        makeDefault: { ...str, description: 'Make this model of the connection the default for new conversations. (Older scripts: true still works and means the connection\'s model, `model` or its first enabled one.)' },
        makeStrong: { ...str, description: 'Make this model of the connection the strong one (heavy work).' },
        strongModel: {
          ...str,
          description: 'Older parameter, still works: ticks this model and makes it the strong one when this connection is the default (as it was). Prefer makeStrong; when both are given makeStrong wins.',
        },
        saveIfTestFails: { type: 'boolean', description: 'Save even when the test fails.' },
      }),
      run: async (raw) => {
        const { a, notes, legacyDefault, legacyStrong } = await legacySave(raw);
        const { d, config, existing, changes, added, removed, enabledNow, disabledNow, testModel, all } = await draftFrom(a, 'save');
        let makeDefault = text(a.makeDefault) || undefined;
        if (legacyDefault) {
          makeDefault = text(a.model) || d.models.find((m) => m.enabled !== false)?.id;
          notes.push({ parameter: 'makeDefault', given: true, handledAs: `makeDefault: "${makeDefault}"` });
        }
        const makeStrong = text(a.makeStrong) || undefined;
        for (const [field, m] of [['makeDefault', makeDefault], ['makeStrong', makeStrong]] as const) {
          if (m && !d.models.some((x) => x.id === m && x.enabled !== false)) throw new SettingsError('invalid', `${m} is not one of this connection's enabled models (field ${field})`);
        }
        const tested = await test(d.kind, config, testModel);
        if (!tested.ok && a.saveIfTestFails !== true) return { saved: false, test: tested, ...(notes.length ? { legacy: notes } : {}) };
        // the address only worked with /v1 added: save that one, and say so (as the form does)
        const baseUrlAdjusted = tested.suggestedBaseUrl ? { from: d.baseUrl, to: tested.suggestedBaseUrl } : undefined;
        if (baseUrlAdjusted) {
          d.baseUrl = baseUrlAdjusted.to;
          if (existing && !changes.includes('baseUrl')) changes.unshift('baseUrl');
        }
        const card = {
          action: existing ? 'change_connection' : 'add_connection',
          ...(existing ? { id: existing.id } : {}),
          name: d.name,
          kind: d.kind,
          baseUrl: d.baseUrl,
          ...(d.kind === 'wso2' ? { tokenUrl: d.tokenUrl, consumerKey: maskKey(d.clientId), scope: d.scope || null } : {}),
          // the models in use (each has its context window); disabled ones are named in disabledModels
          models: d.models.filter((m) => m.enabled !== false).map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? 0, contextFrom: m.contextFrom })),
          addedModels: added,
          removedModels: removed,
          enabledModels: enabledNow,
          disabledModels: disabledNow,
          changes,
          secret: d.secret ? 'new' : 'unchanged',
          ...(makeDefault ? { makeDefault } : {}),
          ...(makeStrong ? { makeStrong } : {}),
          test: { ok: tested.ok, model: tested.model, ...(tested.code ? { code: tested.code } : {}) },
        };
        return confirmThen(
          'spica_save_model',
          card,
          async (confirmed) => {
            try {
              const saved = await host<HostConnection>('models.save', [d]);
              if (makeDefault) await host('models.setDefault', [pointerTo(saved.id, makeDefault)]);
              if (makeStrong) await host('models.setStrong', [pointerTo(saved.id, makeStrong)]);
              let strongSet = !!makeStrong;
              if (legacyStrong) {
                // as before: a connection's strong model counts while it is the default
                if ((await list()).default?.connectionId === saved.id) {
                  await host('models.setStrong', [pointerTo(saved.id, legacyStrong)]);
                  strongSet = true;
                  notes.push({ parameter: 'strongModel', given: legacyStrong, handledAs: `makeStrong: "${legacyStrong}"` });
                } else {
                  notes.push({
                    parameter: 'strongModel',
                    given: legacyStrong,
                    handledAs: `${legacyStrong} is ticked on this connection; the strong model did not change because this connection is not the default (as before); pass makeStrong to set it`,
                  });
                }
              }
              const after = await list();
              const moved = (which: 'default' | 'strong') => (samePointer(all[which], after[which]) ? undefined : { from: all[which], to: after[which] });
              const all2 = [...changes, ...(makeDefault ? ['default'] : []), ...(strongSet ? ['strong'] : [])];
              record({ id: saved.id, changes: all2, status: 'ok', confirmed });
              await announce({
                ...(card as unknown as SettingsChangeMeta),
                id: saved.id,
                changes: all2,
                ...(moved('default') ? { defaultMoved: moved('default') } : {}),
                ...(moved('strong') ? { strongMoved: moved('strong') } : {}),
                by: 'mcp',
                confirmed,
                at: isoNow(),
              });
              return {
                saved: true,
                ...(baseUrlAdjusted ? { baseUrlAdjusted } : {}),
                connection: view(after.connections.find((c) => c.id === saved.id) ?? saved, after),
                default: after.default,
                strong: after.strong,
                test: tested,
                ...(notes.length ? { legacy: notes } : {}),
              };
            } catch (err) {
              record({ id: existing?.id ?? '', changes, status: 'error', confirmed, error: err instanceof Error ? err.message : String(err) });
              throw err;
            }
          },
          () => {
            record({ id: existing?.id ?? '', changes, status: 'aborted', confirmed: false, error: 'declined by the user' });
            return { saved: false, declined: true, test: tested, ...(notes.length ? { legacy: notes } : {}) };
          },
        );
      },
    },
    {
      name: 'spica_set_default_model',
      description: `Make a model of a saved connection the default for new conversations (or, with strong, the one for heavy work); shown to the user like spica_save_model (and confirmed first if ${app} is set up to ask).`,
      inputSchema: obj({ id: FIELDS.id, model: { ...str, description: "One of the connection's models (default: its first)." }, strong: { type: 'boolean', description: 'Set the strong model instead.' } }, ['id']),
      run: async (a) => {
        const id = String(a.id ?? '');
        const strong = a.strong === true;
        const l = await list();
        const c = l.connections.find((x) => x.id === id);
        if (!c) throw new SettingsError('not_found', `no model connection with id ${id} (see spica_list_models)`);
        const model = text(a.model) || c.models.find((m) => m.enabled !== false)?.id;
        if (!model || !c.models.some((m) => m.id === model && m.enabled !== false)) throw new SettingsError('invalid', `${model ?? '(none)'} is not one of this connection's enabled models (field model)`);
        const which = strong ? 'strong' : 'default';
        const target = pointerTo(id, model);
        if (samePointer(l[which], target)) return { [which]: target };
        const card = { action: strong ? 'set_strong_model' : 'set_default_model', id, name: c.name, kind: kindOf(c.kind), model, changes: [which] };
        return confirmThen(
          'spica_set_default_model',
          card,
          async (confirmed) => {
            await host(strong ? 'models.setStrong' : 'models.setDefault', [target]);
            record({ id, changes: [which], status: 'ok', confirmed });
            await announce({ ...(card as unknown as SettingsChangeMeta), [strong ? 'strongMoved' : 'defaultMoved']: { from: l[which], to: target }, by: 'mcp', confirmed, at: isoNow() });
            return { [which]: target };
          },
          () => {
            record({ id, changes: [which], status: 'aborted', confirmed: false, error: 'declined by the user' });
            return { [which]: l[which], declined: true };
          },
        );
      },
    },
    {
      name: 'spica_settings_result',
      description: 'Wait again for a change that was still waiting for the user (status waiting_for_user).',
      inputSchema: obj({ requestId: str }, ['requestId']),
      run: async (a) => {
        const id = String(a.requestId ?? '');
        const done = waiting.get(id);
        if (!done) throw new SettingsError('not_found', `no settings change waiting with requestId ${id}`);
        return waitOrPending(id, done);
      },
    },
    {
      name: 'spica_network_status',
      description: `Proxy, hosts that bypass it, and extra trusted certificates in force (read only; no proxy password). The user changes them in the ${app} window's settings.`,
      inputSchema: obj({}),
      run: async () => bridge().network(),
    },
  ];
  return tools.map((t) => ({ ...t, run: (a: Args) => (refuseUnknown(t, a ?? {}), t.run(a ?? {})) }));
}

/** How a parameter of an older script was taken (in the result as `legacy`). */
interface LegacyNote {
  parameter: string;
  given: unknown;
  handledAs: string;
}

/** A parameter the tool does not take is an error naming it (a misspelled or dropped one never passes silently). */
function refuseUnknown(t: McpTool, a: Args): void {
  const known = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  const unknown = Object.keys(a).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  throw new SettingsError(
    'invalid',
    `${t.name} does not take ${unknown.map((k) => `"${k}"`).join(', ')}${known.length ? `; it takes: ${known.join(', ')}` : '; it takes no parameters'}`,
  );
}
