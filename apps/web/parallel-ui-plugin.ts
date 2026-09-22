import type { Plugin } from 'vite';

export function nextUiDocument(url: string): string | undefined {
  const separator = url.indexOf('?');
  const path = separator < 0 ? url : url.slice(0, separator);
  if (!/^\/next(?:\/(?:session\/[^/]+(?:\/[^/]+)?|(?:mcp|skills)(?:\/[^/]+)?)?\/?)?$/.test(path)) return;
  return `/next/index.html${separator < 0 ? '' : url.slice(separator)}`;
}

export function parallelUiPlugin(): Plugin {
  return {
    name: 'parallel-ui-documents',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.method === 'GET' && request.url) {
          const document = nextUiDocument(request.url);
          if (document) request.url = document;
        }
        next();
      });
    },
  };
}
