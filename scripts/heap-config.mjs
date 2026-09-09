export const HEAP_ENV_VAR = 'COCKPIT_MAX_OLD_SPACE_MB';

// The API no longer hosts Copilot's runtime heap. Keep an explicit operator
// override, but otherwise use Node's normal memory sizing and garbage collection.
export function resolveMaxOldSpaceMb(env = process.env) {
  const raw = env[HEAP_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`[cockpit] ${HEAP_ENV_VAR} must be a positive integer number of megabytes.`);
  }
  const mb = Number(value);
  if (!Number.isSafeInteger(mb) || mb < 1) {
    throw new Error(`[cockpit] ${HEAP_ENV_VAR} is out of range; expected a positive safe integer.`);
  }
  return mb;
}

export function buildServerNodeArgs(env = process.env) {
  const mb = resolveMaxOldSpaceMb(env);
  return [...(mb === undefined ? [] : [`--max-old-space-size=${mb}`]), '--import', 'tsx', 'src/index.ts'];
}
