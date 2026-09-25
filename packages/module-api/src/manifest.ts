export interface ModuleManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  backend: string;
  /** Module-relative Markdown appended to every Cockpit session while the module is enabled (max 16 KiB). */
  instructions?: string;
  roles?: ModuleRole[];
  frontend?: {
    entry: string;
    styles?: string[];
    assets: string[];
    worker?: string;
  };
}

export interface ModuleRole {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  skillDirectories?: string[];
  mcpServers?: Record<string, { type: 'http'; path: string; tools: string[] }>;
}

export interface ModuleAsset {
  id: string;
  name: string;
  version: string;
  digest: string;
  apiBase: string;
  entry: string;
  styles: string[];
  config: Readonly<Record<string, unknown>>;
  worker?: { entry: string; scope: string };
}
