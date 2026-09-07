// heap-config.mjs — resolve the cockpit server child's V8 old-space ceiling.
//
// The launcher spawns the server with `--max-old-space-size=<MB>`. That ceiling
// used to be hardcoded; it is now overridable via the COCKPIT_MAX_OLD_SPACE_MB
// environment variable so a box can be tuned without editing source.
//
// Validation is STRICT and LOUD: an override must be a positive integer number of
// megabytes. Anything else (a typo, a unit suffix like "8192MB", a decimal, a
// negative, zero, hex, exponent) THROWS so the launcher fails to start with a clear
// message — it must never silently fall back to the default and quietly run with a
// smaller heap than the operator intended.
//
// The watchdog watermarks in packages/core/src/memory.ts are fractions of V8's
// *actual* ceiling, so they adapt automatically when this value changes — raising
// the ceiling here needs no watchdog retuning.

export const HEAP_ENV_VAR = 'COCKPIT_MAX_OLD_SPACE_MB';

// Default old-space ceiling in MB. Sized for this 64 GB host; overridable per box.
export const DEFAULT_MAX_OLD_SPACE_MB = 8192;

// Resolve the old-space ceiling (in MB) from `env`. Returns the default when the
// override is unset/empty; throws an Error with a clear, actionable message when the
// override is present but not a positive integer.
export function resolveMaxOldSpaceMb(env = process.env) {
  const raw = env[HEAP_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_OLD_SPACE_MB;

  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `[cockpit] ${HEAP_ENV_VAR}=${JSON.stringify(raw)} is invalid — it must be a ` +
        `positive integer number of megabytes (digits only, no sign/decimal/unit), ` +
        `e.g. ${HEAP_ENV_VAR}=${DEFAULT_MAX_OLD_SPACE_MB}.`,
    );
  }

  const mb = Number(value);
  if (!Number.isSafeInteger(mb) || mb < 1) {
    throw new Error(
      `[cockpit] ${HEAP_ENV_VAR}=${JSON.stringify(raw)} is out of range — it must be a ` +
        `positive integer number of megabytes (>= 1).`,
    );
  }
  return mb;
}

// Build the argv for the server child. Mirrors the systemd ExecStart (GC exposed,
// raised old-space) for parity, with the ceiling resolved from the environment.
export function buildServerNodeArgs(env = process.env) {
  const mb = resolveMaxOldSpaceMb(env);
  return ['--expose-gc', `--max-old-space-size=${mb}`, '--import', 'tsx', 'src/index.ts'];
}
