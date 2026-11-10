// Model settings through Spica's MCP service: an agent on this machine (one the
// user connected through "allow local scripts") lists, tests and saves model
// connections for the user. The settings live with the host (the desktop shell
// stores them, secrets encrypted); the core reaches it through host methods on
// the backend port and never hands a secret back out:
//   - no tool result contains an API key or a Consumer Secret (only hasSecret);
//     a Consumer Key comes back as its last 4 characters
//   - every secret received is added to the redaction table at once
//   - a change applies at once and is shown in the conversations (event
//     settings.changed, and a note with meta.settingsChange in the main
//     conversation and the one open in the window, so it stays in the history);
//     with the runtime's confirmSettingsChanges on it first waits for the user's
//     confirmation in the window (cause settings_change, answerable only there)
//   - each change leaves a traceable record (kind settings) with field names only
import type { ProviderConfig } from './host/backend.ts';
import type { McpTool } from './mcp/server.ts';
import type { Runtime } from './runtime.ts';
import { isoNow } from './events.ts';
import { fence } from './guard.ts';
import type { Session } from './session.ts';
import { catalogProvider } from './catalog/catalog.ts';
import { listProviderModels } from './catalog/list-models.ts';
import type { ProbeResult, SettingsChangeMeta } from './types.ts';

/** A model connection as the host lists it (no secret). */
export interface HostModel {
  id: string;
  kind: CoreKind;
  name: string;
  baseUrl: string;
  model: string;
  strongModel: string;
  tokenUrl: string;
  /** WSO2: the OAuth client id (Consumer Key), in full: the core masks it before it leaves. */
  clientId: string;
  scope: string;
  contextWindow: number | null;
  maxConcurrent: number | null;
  requestsPerMinute: number | null;
  hasSecret: boolean;
  isDefault: boolean;
  /** Cannot be changed here (e.g. comes from a developer file). */
  readOnly?: boolean;
  /** The catalog provider or company preset it was set up from (prices, context windows, how to list models). */
  catalogId?: string;
}

/** What the core asks the host to save. `secret` undefined: keep the saved one. */
export type HostModelDraft = Omit<HostModel, 'id' | 'hasSecret' | 'isDefault' | 'readOnly'> & { id?: string; secret?: string };

type CoreKind = 'openai-compatible' | 'anthropic' | 'wso2';

/**
 * How the settings tools reach the host and the providers (set by startBackend).
 * Host methods: 'models.list' () → HostModel[]; 'models.save' (HostModelDraft) →
 * HostModel, the host then sends the providers to the core with configure() as it
 * does for its own settings page, with the same ids; 'models.setDefault' (id).
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

const FIELDS = {
  id: { ...str, description: 'An existing connection (from spica_list_models) to change or test; leave out to add a new one.' },
  preset: {
    ...str,
    description: 'A provider or company preset from spica_list_presets: its kind, addresses and default model are filled in, so usually only the key (or Consumer Key and Secret) is needed.',
  },
  kind: { type: 'string', enum: KINDS, description: 'openai-compatible (incl. DeepSeek and most gateways with a key), anthropic, or wso2 (WSO2 API gateway with Consumer Key / Secret).' },
  name: { ...str, description: 'Shown in the model list.' },
  baseUrl: { ...str, description: 'API address (usually ending in /v1). Optional for anthropic.' },
  model: { ...str, description: 'Model name to use.' },
  strongModel: { ...str, description: 'Optional model for heavy work.' },
  tokenUrl: { ...str, description: 'wso2: the OAuth token endpoint.' },
  consumerKey: { ...str, description: 'wso2: Consumer Key (OAuth client id).' },
  consumerSecret: { ...str, description: 'wso2: Consumer Secret. Stored encrypted, never returned. Leave out to keep the saved one.' },
  apiKey: { ...str, description: 'openai-compatible / anthropic: the API key. Stored encrypted, never returned. Leave out to keep the saved one.' },
  scope: { ...str, description: 'wso2: OAuth scope, if the gateway needs one.' },
  contextWindow: { ...int, description: 'Tokens the model takes at once. Filled in for models the app knows; otherwise required (ask the user).' },
  maxConcurrent: { ...int, description: 'Requests at the same time (leave out: no limit).' },
  requestsPerMinute: { ...int, description: 'Requests per minute (leave out: no limit).' },
} as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** The last 4 characters, for showing that a value is there without showing it. */
export function maskTail(v: string): string {
  if (!v) return '';
  return v.length <= 4 ? '…' : `…${v.slice(-4)}`;
}

function kindOf(v: unknown): CoreKind | undefined {
  if (v === 'openai') return 'openai-compatible'; // the desktop shell's spelling
  return KINDS.includes(v as CoreKind) ? (v as CoreKind) : undefined;
}

/** What an agent sees of a connection: no secret, the Consumer Key masked. */
function view(m: HostModel) {
  const kind = kindOf(m.kind) ?? 'openai-compatible';
  return {
    id: m.id,
    kind,
    name: m.name,
    baseUrl: m.baseUrl,
    model: m.model,
    strongModel: m.strongModel || null,
    ...(kind === 'wso2' ? { tokenUrl: m.tokenUrl, consumerKey: maskTail(m.clientId), scope: m.scope || null } : {}),
    contextWindow: m.contextWindow,
    maxConcurrent: m.maxConcurrent,
    requestsPerMinute: m.requestsPerMinute,
    hasSecret: m.hasSecret,
    isDefault: m.isDefault,
    ...(m.readOnly ? { readOnly: true } : {}),
  };
}

/** Test result for an agent: the two steps, the code and the Chinese hint from NET_HINTS. */
function testView(kind: CoreKind, r: ProbeResult) {
  const twoSteps = kind === 'wso2';
  const token = !twoSteps ? 'n/a' : r.ok || r.stage === 'model' ? 'ok' : 'failed';
  const model = r.ok ? 'ok' : r.stage === 'token' ? 'skipped' : 'failed';
  return {
    ok: r.ok,
    steps: { token, model },
    ...(r.code ? { code: r.code } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
    ...(r.message ? { message: r.message } : {}),
    latencyMs: r.latencyMs,
    ...(r.firstByteMs !== undefined ? { firstByteMs: r.firstByteMs } : {}),
    ...(r.model ? { serverModel: r.model } : {}),
  };
}

type Args = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : v === undefined ? undefined : NaN);

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
  const list = async () => (await host<HostModel[]>('models.list')) ?? [];
  const waiting = new Map<string, Promise<unknown>>();

  /** The saved connection merged with what the agent gave, validated; secrets registered for redaction. */
  const draftFrom = async (a: Args, purpose: 'test' | 'save' | 'list') => {
    const id = text(a.id) || undefined;
    const presetId = text(a.preset) || undefined;
    const preset = catalogProvider(rt.catalog, presetId);
    if (presetId && !preset) throw new SettingsError('not_found', `no preset ${presetId} (see spica_list_presets)`);
    let existing: HostModel | undefined;
    if (id) {
      existing = (await list()).find((m) => m.id === id);
      if (!existing) throw new SettingsError('not_found', `no model connection with id ${id} (see spica_list_models)`);
      if (existing.readOnly && purpose === 'save') throw new SettingsError('read_only', `${id} cannot be changed here`);
    }
    // what the preset fills in (a saved connection keeps its own values; what the agent gives wins)
    const fromPreset = preset && !existing;
    const kind = a.kind !== undefined ? kindOf(a.kind) : existing ? kindOf(existing.kind) : preset?.kind;
    if (!kind) throw new SettingsError('invalid', `kind must be one of ${KINDS.join(', ')}`);
    const pick = (k: string, from: string) => text(a[k]) ?? from;
    const roleModel = (role: string) => preset?.models.find((m) => m.role === role)?.id ?? '';
    const model = pick('model', existing?.model ?? (fromPreset ? roleModel('default') || (preset.models[0]?.id ?? '') : ''));
    const presetWindow = preset?.models.find((m) => m.id === model)?.contextWindow ?? null;
    const d: HostModelDraft = {
      ...(id ? { id } : {}),
      kind,
      name: pick('name', existing?.name ?? (fromPreset ? preset.name : '')),
      baseUrl: pick('baseUrl', existing?.baseUrl ?? (fromPreset ? preset.baseUrl : kind === 'anthropic' ? 'https://api.anthropic.com/v1' : '')),
      model,
      strongModel: pick('strongModel', existing?.strongModel ?? (fromPreset ? roleModel('strong') : '')),
      tokenUrl: pick('tokenUrl', existing?.tokenUrl ?? (fromPreset ? (preset.tokenUrl ?? '') : '')),
      clientId: pick('consumerKey', existing?.clientId ?? ''),
      scope: pick('scope', existing?.scope ?? (fromPreset ? (preset.scope ?? '') : '')),
      contextWindow: count(a.contextWindow) ?? (a.model === undefined ? existing?.contextWindow : undefined) ?? presetWindow ?? null,
      maxConcurrent: count(a.maxConcurrent) ?? existing?.maxConcurrent ?? (fromPreset ? (preset.maxConcurrent ?? null) : null),
      requestsPerMinute: count(a.requestsPerMinute) ?? existing?.requestsPerMinute ?? (fromPreset ? (preset.requestsPerMinute ?? null) : null),
      ...((existing?.catalogId ?? preset?.id) ? { catalogId: existing?.catalogId ?? preset!.id } : {}),
    };
    const needsKey = catalogProvider(rt.catalog, d.catalogId)?.needsKey ?? true;
    const typed = text(kind === 'wso2' ? (a.consumerSecret ?? a.apiKey) : (a.apiKey ?? a.consumerSecret));
    if (typed) d.secret = typed;
    // known secrets and addresses never show up in errors, records or exports from here on
    rt.addRedactions([typed, d.clientId, d.baseUrl, d.tokenUrl]);
    // (the field name after the reason: "apiKey: …" would read as a key to the redaction)
    const bad = (field: string, why: string) => new SettingsError('invalid', `${why} (field ${field})`);
    if (!d.model && purpose !== 'list') throw bad('model', 'required');
    if (purpose === 'save' && !d.name) throw bad('name', 'required (shown in the model list)');
    const url = /^https?:\/\/[^\s/]+/i;
    if (kind !== 'anthropic' && !d.baseUrl) throw bad('baseUrl', 'required');
    if (d.baseUrl && !url.test(d.baseUrl)) throw bad('baseUrl', 'must start with http:// or https://');
    if (kind === 'wso2') {
      if (!d.tokenUrl) throw bad('tokenUrl', 'required for wso2');
      if (!url.test(d.tokenUrl)) throw bad('tokenUrl', 'must start with http:// or https://');
      if (!d.clientId) throw bad('consumerKey', 'required for wso2');
    }
    for (const k of ['contextWindow', 'maxConcurrent', 'requestsPerMinute'] as const) if (Number.isNaN(d[k])) throw bad(k, 'a positive whole number');
    const running = id ? bridge().providerConfig(id) : undefined;
    const secret = d.secret ?? (kind === 'wso2' ? running?.oauth?.clientSecret : running?.apiKey);
    if (!secret && (needsKey || kind === 'wso2')) {
      throw bad(kind === 'wso2' ? 'consumerSecret' : 'apiKey', existing?.hasSecret ? 'the saved one cannot be read; give it again' : 'required');
    }
    if (purpose === 'save' && d.contextWindow === null) {
      const known = rt.ledger.knownContextWindow(kind, d.model, d.catalogId);
      if (!known) throw new SettingsError('context_window_required', `${app} does not know how many tokens ${d.model} takes at once: ask the user and pass contextWindow`);
      d.contextWindow = known;
    }
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
    const changes = existing
      ? (['kind', 'name', 'baseUrl', 'model', 'strongModel', 'tokenUrl', 'scope', 'contextWindow', 'maxConcurrent', 'requestsPerMinute'] as const)
          .filter((k) => (k === 'kind' ? kindOf(existing.kind) !== d.kind : existing[k] !== d[k]))
          .map(String)
          .concat(existing.clientId !== d.clientId ? ['consumerKey'] : [], d.secret ? [kind === 'wso2' ? 'consumerSecret' : 'apiKey'] : [])
      : ['new'];
    return { d, config, existing, changes };
  };

  const test = async (kind: CoreKind, config: ProviderConfig, model: string) => testView(kind, await bridge().probe(config, model));

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
   * note in the main conversation and in the one open in the window (asked with
   * the optional host method 'ui.activeSession'), kept in the history. The model
   * there reads it as data: names and model names come from the script.
   */
  const announce = async (change: SettingsChangeMeta) => {
    rt.events.emit(rt.eventHost, { type: 'settings.changed', change });
    const targets = new Set<Session>();
    try {
      targets.add(rt.top()); // a model is configured by now, so the main conversation can exist
    } catch {
      // still no usable model: the event is all there is
    }
    try {
      const open = await bridge().host('ui.activeSession');
      const s = typeof open === 'string' && open ? rt.session(open) : undefined;
      if (s) targets.add(s);
    } catch {
      // the window does not say which conversation is open
    }
    const what = { action: change.action, name: change.name, model: change.model, changes: change.changes, confirmedByUser: change.confirmed };
    const body = fence(JSON.stringify(what), 'mcp', 'settings', app).text;
    const text = `[The model settings were changed by a script connected to ${app}${change.confirmed ? ', confirmed by the user' : ', without asking the user (as set up)'}. Details:]\n${body}`;
    for (const s of targets) s.addNote('note', text, { author: 'runtime', settingsChange: change });
  };
  const changeOf = (card: Record<string, unknown>, id: string, confirmed: boolean, extra: string[] = []): SettingsChangeMeta =>
    ({ ...card, id, changes: [...((card.changes as string[] | undefined) ?? []), ...extra], by: 'mcp', confirmed, at: isoNow() }) as SettingsChangeMeta;

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

  return [
    {
      name: 'spica_list_presets',
      description:
        `The providers ${app} knows (company presets first, then providers in China, international, on this machine): kind, API address, whether a key is needed, ` +
        'and a short list of models with context windows and official prices where known. Pass a preset id to spica_save_model to fill in the address and model.',
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
      description: `The model connections set up in ${app} (no keys or secrets: hasSecret says whether one is saved; the Consumer Key shows its last 4 characters).`,
      inputSchema: obj({}),
      run: async () => (await list()).map(view),
    },
    {
      name: 'spica_test_model',
      description:
        'Test a connection without saving it: a saved one by id, or the fields of a new one (with its key / secret). WSO2 is tested in two steps (getting a token, then calling the model). ' +
        'On failure: code, and hint (Chinese) saying what to change.',
      inputSchema: obj(FIELDS),
      run: async (a) => {
        const { d, config } = await draftFrom(a, 'test');
        return test(d.kind, config, d.model);
      },
    },
    {
      name: 'spica_save_model',
      description:
        `Add (no id) or change (id) a model connection, test it, and save it; the change is shown to the user in ${app}'s conversations (if ${app} is set up to ask first, it waits for the user to confirm in the window). ` +
        'Fields left out keep their saved value; the key / secret is stored encrypted and never returned. A failed test saves nothing unless saveIfTestFails. ' +
        'If the user has not answered yet the result is status waiting_for_user with a requestId for spica_settings_result.',
      inputSchema: obj(
        {
          ...FIELDS,
          makeDefault: { type: 'boolean', description: 'Also make it the default for new conversations.' },
          saveIfTestFails: { type: 'boolean', description: 'Save even when the test fails.' },
        },
        [],
      ),
      run: async (a) => {
        const { d, config, existing, changes } = await draftFrom(a, 'save');
        const tested = await test(d.kind, config, d.model);
        if (!tested.ok && a.saveIfTestFails !== true) return { saved: false, test: tested };
        const makeDefault = a.makeDefault === true;
        const card = {
          action: existing ? 'change_model' : 'add_model',
          ...(existing ? { id: existing.id } : {}),
          name: d.name,
          kind: d.kind,
          model: d.model,
          baseUrl: d.baseUrl,
          ...(d.kind === 'wso2' ? { tokenUrl: d.tokenUrl, consumerKey: maskTail(d.clientId), scope: d.scope || null } : {}),
          contextWindow: d.contextWindow,
          changes,
          secret: d.secret ? 'new' : 'unchanged',
          makeDefault,
          test: { ok: tested.ok, ...(tested.code ? { code: tested.code } : {}) },
        };
        return confirmThen(
          'spica_save_model',
          card,
          async (confirmed) => {
            try {
              const saved = await host<HostModel>('models.save', [d]);
              if (makeDefault && !saved.isDefault) await host('models.setDefault', [saved.id]);
              const all = makeDefault ? [...changes, 'default'] : changes;
              record({ id: saved.id, changes: all, status: 'ok', confirmed });
              await announce(changeOf(card, saved.id, confirmed, makeDefault ? ['default'] : []));
              return { saved: true, model: view({ ...saved, isDefault: saved.isDefault || makeDefault }), test: tested };
            } catch (err) {
              record({ id: existing?.id ?? '', changes, status: 'error', confirmed, error: err instanceof Error ? err.message : String(err) });
              throw err;
            }
          },
          () => {
            record({ id: existing?.id ?? '', changes, status: 'aborted', confirmed: false, error: 'declined by the user' });
            return { saved: false, declined: true, test: tested };
          },
        );
      },
    },
    {
      name: 'spica_set_default_model',
      description: `Make a saved connection the default for new conversations; shown to the user like spica_save_model (and confirmed first if ${app} is set up to ask).`,
      inputSchema: obj({ id: FIELDS.id }, ['id']),
      run: async (a) => {
        const id = String(a.id ?? '');
        const m = (await list()).find((x) => x.id === id);
        if (!m) throw new SettingsError('not_found', `no model connection with id ${id} (see spica_list_models)`);
        if (m.isDefault) return { id, isDefault: true };
        return confirmThen(
          'spica_set_default_model',
          { action: 'set_default_model', id, name: m.name, kind: kindOf(m.kind), model: m.model, changes: ['default'] },
          async (confirmed) => {
            await host('models.setDefault', [id]);
            record({ id, changes: ['default'], status: 'ok', confirmed });
            await announce(changeOf({ action: 'set_default_model', name: m.name, kind: kindOf(m.kind), model: m.model, changes: ['default'] }, id, confirmed));
            return { id, isDefault: true };
          },
          () => {
            record({ id, changes: ['default'], status: 'aborted', confirmed: false, error: 'declined by the user' });
            return { id, isDefault: false, declined: true };
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
}
