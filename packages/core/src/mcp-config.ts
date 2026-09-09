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
