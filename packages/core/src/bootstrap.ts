// SDK bootstrap (PoC-validated recipe). The published SDK doesn't export the
// session manager publicly — we reach it via `sdk.internal.LocalSessionManager`,
// build AuthInfo from the gh CLI token via `resolveAuthInfoFromToken`, and a
// local feature-flag service. featureFlagService MUST also be passed into every
// createSession/getSession call (the session ctor otherwise calls
// `coreServices.createFeatureFlagService(...)` and throws).

import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as sdkRaw from '@github/copilot/sdk';
import type { SdkSessionManager } from './sdk-types.ts';
import type { ModelOption } from '@cockpit/protocol';

// The published SDK's runtime surface does NOT match its .d.ts (PoC finding):
// query/Session/LocalSessionManager/AuthManager are declared but absent, while
// `internal.LocalSessionManager` + helpers exist with different signatures. So
// we deliberately treat the module as untyped here — this one cast is the entire
// SDK trust boundary; sdk-types.ts declares the shapes the rest of core relies on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = sdkRaw as any;

const COPILOT_VERSION = '1.0.63';

export interface Bootstrapped {
  manager: SdkSessionManager;
  authInfo: unknown;
  featureFlagService: unknown;
  login: string;
  models: ModelOption[];
}

function ghToken(): string {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim();
  } catch (e) {
    throw new Error(`gh auth token failed (is gh logged in?): ${(e as Error).message}`);
  }
}

// bootstrap depends on UNDOCUMENTED SDK internals (the published .d.ts declares a
// public surface that doesn't exist at runtime). Assert every symbol we reach into
// exists at startup, so an SDK upgrade that moves/renames them FAILS FAST at boot
// with a clear message — instead of crashing mid-session deep in a call (which is
// exactly how the missing-autoModeManager sub-agent bug first surfaced).
function assertSdkContract(): void {
  const checks: Array<[string, unknown]> = [
    ['resolveAuthInfoFromToken', sdk.resolveAuthInfoFromToken],
    ['createLocalFeatureFlagService', sdk.createLocalFeatureFlagService],
    ['getAvailableModels', sdk.getAvailableModels],
    ['AutoModeSessionManager', sdk.AutoModeSessionManager],
    ['internal', sdk.internal],
    ['internal.LocalSessionManager', sdk.internal?.LocalSessionManager],
    ['internal.NoopTelemetryService', sdk.internal?.NoopTelemetryService],
  ];
  const missing = checks.filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `@github/copilot ${COPILOT_VERSION} SDK contract broken — missing: ${missing.join(', ')}. `
      + 'bootstrap relies on these internal symbols; an SDK upgrade likely moved them. '
      + 'Update bootstrap.ts/sdk-types.ts to the new surface before deploying.',
    );
  }
}

// Sub-agent definitions self-heal. The SDK bundle (`sdk/index.js`) loads built-in
// agent YAMLs from `dirname(import.meta.url)/definitions` — i.e. `sdk/definitions`.
// But the npm package ships them one level up at `@github/copilot/definitions`
// (the full CLI runs the top-level `app.js`, where that path resolves; we run the
// `sdk/` entry, where it doesn't). Without this, every `task`/sub-agent spawn fails
// with ENOENT on `sdk/definitions/<name>.agent.yaml`. Same class of bug as the
// missing autoModeManager: we run the SDK from a path its bundle doesn't expect.
// Fix: symlink `sdk/definitions -> ../definitions` if absent. Idempotent; re-created
// on every boot so it survives `pnpm install` wiping node_modules.
function ensureAgentDefinitions(): void {
  try {
    // Resolve via the `import` condition (the package's exports define no `require`
    // condition, so createRequire would fail). import.meta.resolve respects exports.
    const sdkEntry = fileURLToPath(import.meta.resolve('@github/copilot/sdk')); // .../@github/copilot/sdk/index.js
    const sdkDir = dirname(sdkEntry);                       // .../@github/copilot/sdk
    const link = join(sdkDir, 'definitions');              // where the bundle looks
    const real = join(sdkDir, '..', 'definitions');        // where the package ships them
    if (existsSync(link)) return;                          // already present (symlink or real dir)
    if (!existsSync(real)) {
      console.warn(`[bootstrap] agent definitions not found at ${real}; sub-agents may not load.`);
      return;
    }
    symlinkSync('../definitions', link, 'dir');
    console.warn(`[bootstrap] linked ${link} -> ../definitions (sub-agent definitions self-heal).`);
  } catch (e) {
    console.warn(`[bootstrap] could not ensure agent definitions: ${(e as Error).message}`);
  }
}

export async function bootstrap(): Promise<Bootstrapped> {
  assertSdkContract();
  ensureAgentDefinitions();
  const token = ghToken();
  const authInfo = await sdk.resolveAuthInfoFromToken(token);
  const login = (authInfo as { copilotUser?: { login?: string } }).copilotUser?.login ?? 'unknown';
  const featureFlagService = sdk.createLocalFeatureFlagService({
    authInfo,
    // Enable the SDK's scheduled-prompt feature (`/every` + `/after`, backed by the
    // per-session ScheduleRegistry). The flag gates the CLI slash-command UI; the
    // in-process registry cockpit drives via `schedule/*` intents works regardless,
    // but we set it for completeness and to future-proof any flag-gated code path.
    flagOverrides: { EVERY_AND_AFTER: true },
  });
  // The session ctor copies `coreServices.autoModeManager` onto every session,
  // including spawned sub-agents. Without it, a sub-agent's first model resolve
  // (getAutoModeResolvedModel → autoModeManager.getLastResolved()) throws
  // "Cannot read properties of undefined". The full CLI provides this service; our
  // hand-rolled bootstrap must too, or the `task` tool / sub-agents always fail.
  const autoModeManager = new sdk.AutoModeSessionManager();
  const manager = new sdk.internal.LocalSessionManager({
    version: COPILOT_VERSION,
    telemetryService: new sdk.internal.NoopTelemetryService(),
    featureFlagService,
    autoModeManager,
  }) as SdkSessionManager;
  let models: ModelOption[] = [];
  try {
    const raw = (await sdk.getAvailableModels(authInfo)) as {
      id: string; name?: string; model_picker_enabled?: boolean;
      supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string;
      billing?: { token_prices?: Record<string, unknown> };
    }[];
    models = raw
      .filter((m) => m.model_picker_enabled !== false)
      .map((m) => {
        // A model supports the "long_context" tier iff its tiered token-pricing
        // (under `billing.token_prices`) exposes a long_context price
        // (CONTEXT_TIER_LEVELS semantics). Reasoning effort is offered only when
        // the model lists supportedReasoningEfforts.
        const tp = m.billing?.token_prices;
        const supportsLongContext = !!(tp && typeof tp === 'object' && tp.long_context != null);
        return {
          modelId: m.id,
          name: m.name ?? m.id,
          ...(m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0
            ? { supportedReasoningEfforts: m.supportedReasoningEfforts } : {}),
          ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
          ...(supportsLongContext ? { supportsLongContext: true } : {}),
        };
      });
  } catch { /* models optional; dropdown just stays empty */ }
  return { manager, authInfo, featureFlagService, login, models };
}
