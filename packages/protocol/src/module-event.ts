/** Module-owned JSON data, never a host event envelope or a live resource. */
export type ModuleEventPayload =
  | null | boolean | number | string
  | readonly ModuleEventPayload[]
  | { readonly [key: string]: ModuleEventPayload };

/** Maximum UTF-8 byte length of the serialized payload, excluding its host envelope. */
export const MAX_MODULE_EVENT_BYTES = 64 * 1024;
const MAX_DEPTH = 64;
const encoder = new TextEncoder();

/**
 * Validate before serialization: JSON.stringify alone silently drops/coerces
 * unsupported values and invokes getters/toJSON. The optional object guard lets
 * the Node publisher reject proxies before inspecting them.
 */
export function snapshotModuleEventPayload(
  input: unknown, unsupportedObject?: (value: object) => boolean,
): ModuleEventPayload {
  const ancestors = new Set<object>();
  const parts: string[] = [];
  let bytes = 0;
  const invalid = (reason: string): never => {
    throw Object.assign(new TypeError(`Invalid module event payload: ${reason}`), { code: 'MODULE_EVENT_INVALID' });
  };
  const tooLarge = (): never => {
    throw Object.assign(new RangeError('Module event payload exceeds 64 KiB of serialized UTF-8 JSON'), { code: 'MODULE_EVENT_TOO_LARGE' });
  };
  const append = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > MAX_MODULE_EVENT_BYTES) tooLarge();
    parts.push(text);
  };
  const string = (value: string) => {
    if (value.length > MAX_MODULE_EVENT_BYTES - bytes) tooLarge();
    append(JSON.stringify(value));
  };
  const encode = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) invalid(`nesting exceeds ${MAX_DEPTH} levels`);
    if (value === null || typeof value === 'boolean') { append(String(value)); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('numbers must be finite');
      append(JSON.stringify(value));
      return;
    }
    if (typeof value !== 'object') invalid('only JSON data is supported');
    const object = value as object;
    if (unsupportedObject?.(object)) invalid('unsupported object');
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      invalid('only plain objects and arrays are supported');
    }
    if (ancestors.has(object)) invalid('cyclic data');
    ancestors.add(object);
    const keys = Reflect.ownKeys(object);
    // Even the smallest JSON member consumes at least one byte.
    if (keys.length > MAX_MODULE_EVENT_BYTES - bytes) tooLarge();
    append(array ? '[' : '{');
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalid('symbol keys are not JSON data');
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('accessors and hidden properties are not JSON data');
      if (array && key !== String(count)) invalid('arrays must be dense and have no extra properties');
      if (count++) append(',');
      if (!array) { string(key as string); append(':'); }
      encode(descriptor.value, depth + 1);
    }
    if (array && count !== Object.getOwnPropertyDescriptor(object, 'length')?.value) invalid('arrays must be dense');
    append(array ? ']' : '}');
    ancestors.delete(object);
  };
  encode(input, 0);
  const snapshot = JSON.parse(parts.join('')) as ModuleEventPayload;
  const freeze = (value: ModuleEventPayload): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(snapshot);
  return snapshot;
}
