import type { McpConnection } from '@cockpit/protocol';

// Display only. Copilot owns discovery, validation and persisted configuration.
const hidden = '••••••';
const sensitive = /token|secret|password|authorization|credential|api[-_]?key/i;

function redactText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, text => {
    try {
      const url = new URL(text);
      if (url.username) url.username = hidden;
      if (url.password) url.password = hidden;
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, hidden);
      if (url.hash) url.hash = hidden;
      return url.toString();
    } catch { return hidden; }
  });
}

export function redactMcpConfig(config: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (key === 'env' || key === 'headers') {
      return [key, value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).map(name => [name, hidden])) : hidden];
    }
    if (sensitive.test(key)) return [key, hidden];
    if (key === 'args' && Array.isArray(value)) {
      let hideNext = false;
      return [key, value.map(arg => {
        if (hideNext) { hideNext = false; return hidden; }
        if (typeof arg !== 'string') return hidden;
        if (sensitive.test(arg)) {
          hideNext = !arg.includes('=');
          return arg.includes('=') ? `${arg.slice(0, arg.indexOf('='))}=${hidden}` : hidden;
        }
        return redactText(arg);
      })];
    }
    if (typeof value === 'string') return [key, redactText(value)];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [key, redactMcpConfig(value)];
    return [key, value];
  }));
}

export function describeMcpServer(config: object): string {
  const cfg = redactMcpConfig(config);
  if (typeof cfg.url === 'string') return cfg.url;
  if (typeof cfg.command === 'string') {
    const args = Array.isArray(cfg.args) ? cfg.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return [cfg.command, ...args].join(' ');
  }
  return 'custom';
}

export function mcpConnection(config: object): McpConnection {
  const cfg = config as Record<string, unknown>;
  const hasUrl = typeof cfg.url === 'string';
  const hasCommand = typeof cfg.command === 'string';
  // Native remote/local configs allow an omitted type; ambiguous or future
  // discriminators must not be classified from whichever field happens to exist.
  const type = cfg.type === undefined
    ? (hasUrl && !hasCommand ? 'http' : hasCommand && !hasUrl ? 'stdio' : undefined) : cfg.type;
  if (type === 'http' || type === 'sse') {
    let target: string | undefined;
    if (hasUrl) {
      try {
        const url = new URL(cfg.url as string);
        if (url.protocol === 'http:' || url.protocol === 'https:') target = url.hostname || undefined;
      } catch { /* Invalid URLs have no safe short target. */ }
    }
    return { method: type, ...(target ? { target } : {}) };
  }
  if (type === 'local' || type === 'stdio') {
    // Validate the entire command first: an embedded argument may itself end
    // in a path whose basename would otherwise look like a safe executable.
    const command = typeof cfg.command === 'string' && /^[\w.@+:/\\-]+$/.test(cfg.command) ? cfg.command : undefined;
    const target = command?.split(/[\\/]/).at(-1);
    return { method: 'stdio', ...(target && /^[\w.@+-]+$/.test(target) ? { target } : {}) };
  }
  return { method: 'unknown' };
}
