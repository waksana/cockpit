import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SessionRole, type ModuleSource, type RoleSelection } from '@cockpit/protocol';
import type { RoleAssembly, RoleProvider } from '@cockpit/core';
import type { ModuleInstallation } from './module-install.ts';
import { safeModulePath } from './module-install.ts';

export class ModuleRoles implements RoleProvider {
  constructor(private readonly root: string, private readonly origin: string,
    private readonly installations: () => ModuleInstallation[]) {}

  list() {
    return this.installations().flatMap(({ manifest }) => (manifest.roles ?? []).map(role => ({
      moduleId: manifest.id, moduleName: manifest.name, roleId: role.id, name: role.name,
      ...(role.description ? { description: role.description } : {}),
    }))).sort((a, b) => `${a.moduleId}/${a.roleId}`.localeCompare(`${b.moduleId}/${b.roleId}`));
  }

  private file(sessionId: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('Invalid role session identity');
    return join(this.root, 'session-roles', `${sessionId}.json`);
  }

  read(sessionId: string): SessionRole[] {
    try {
      return SessionRole.array().parse(JSON.parse(readFileSync(this.file(sessionId), 'utf8'))).map(selection => {
        const manifest = this.installations().find(value => value.manifest.id === selection.moduleId)?.manifest;
        const role = manifest?.roles?.find(value => value.id === selection.roleId);
        return { ...selection, ...(manifest ? { moduleName: manifest.name } : {}), ...(role ? { name: role.name } : {}) };
      });
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  save(sessionId: string, roles: SessionRole[]): void {
    const file = this.file(sessionId);
    mkdirSync(join(this.root, 'session-roles'), { recursive: true, mode: 0o700 });
    const pending = `${file}.${randomUUID()}.pending`;
    writeFileSync(pending, JSON.stringify(SessionRole.array().parse(roles)), { mode: 0o600, flag: 'wx' });
    try { renameSync(pending, file); }
    finally { rmSync(pending, { force: true }); }
  }

  async assemble(sessionId: string, selections: RoleSelection[]): Promise<RoleAssembly> {
    const roles: SessionRole[] = [];
    const skills = new Map<string, { name: string; path: string; hash: string; module: ModuleSource }>();
    const directories = new Set<string>();
    const instructions = new Map<string, { headers: string[]; text: string }>();
    const servers: NonNullable<RoleAssembly['config']['mcpServers']> = {};
    const mcpSources: Record<string, ModuleSource> = {};
    const selected = [...new Map(selections.map(role => [`${role.moduleId}/${role.roleId}`, role])).values()]
      .sort((a, b) => `${a.moduleId}/${a.roleId}`.localeCompare(`${b.moduleId}/${b.roleId}`));
    for (const selection of selected) {
      const installation = this.installations().find(module => module.manifest.id === selection.moduleId);
      const role = installation?.manifest.roles?.find(role => role.id === selection.roleId);
      if (!installation || !role) throw new Error(`Module role unavailable: ${selection.moduleId}/${selection.roleId}`);
      const { manifest, root } = installation;
      const module = { id: manifest.id, name: manifest.name };
      const contribute = (previous?: ModuleSource): ModuleSource => ({
        ...module,
        roles: [...new Map([...previous?.roles ?? [], { id: role.id, name: role.name }]
          .map(source => [source.id, source])).values()],
      });
      const verified = async (relative: string) => {
        const path = join(root, safeModulePath(relative));
        if (!(await realpath(path)).startsWith(`${resolve(root)}${sep}`)) throw new Error('Role resource escapes module');
        const record = installation.files[relative];
        const bytes = await readFile(path);
        if (!record || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error(`Role resource changed: ${relative}`);
        return bytes.toString('utf8');
      };
      roles.push({ ...selection, moduleName: manifest.name, name: role.name });
      const text = role.instructions ? await verified(role.instructions) : '';
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`Role instructions exceed 64 KiB: ${manifest.id}/${role.id}`);
      const source = role.instructions ? join(root, role.instructions) : `${manifest.id}/${role.id}`;
      const group = instructions.get(source) ?? { headers: [], text };
      group.headers.push(`## Module ${manifest.id} / role ${role.id} (${role.name})\nNative session ID: ${sessionId}`);
      instructions.set(source, group);
      for (const directory of role.skillDirectories ?? []) {
        const absolute = join(root, safeModulePath(directory));
        if (!await stat(absolute).then(value => value.isDirectory())) throw new Error(`Role skill root missing: ${directory}`);
        const files = Object.keys(installation.files).filter(path => path.startsWith(`${directory}/`) && path.endsWith('/SKILL.md'));
        if (!files.length) throw new Error(`Role skill root has no skills: ${directory}`);
        for (const path of files) {
          const body = await verified(path);
          // The native discovery preflight owns complete frontmatter parsing.
          const name = /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(body)?.[1]?.trim() ?? path;
          const hash = createHash('sha256').update(body).digest('hex');
          const previous = skills.get(name);
          if (previous && (previous.module.id !== module.id || previous.hash !== hash)) throw new Error(`Conflicting role skill: ${name}`);
          if (previous && previous.path !== join(root, path)) throw new Error(`Duplicate role skill name in different directories: ${name}`);
          skills.set(name, { name, path: join(root, path), hash, module: contribute(previous?.module) });
        }
        directories.add(absolute);
      }
      for (const [key, config] of Object.entries(role.mcpServers ?? {})) {
        const name = key;
        const url = new URL(`/_modules/${manifest.id}/${installation.digest}/api${config.path}`, this.origin).href;
        const value = { type: 'http' as const, url, headers: { 'X-Cockpit-Module-Digest': installation.digest }, tools: [...new Set(config.tools)].sort() };
        if (value.tools.includes('*')) value.tools = ['*'];
        const previous = Object.hasOwn(servers, name) ? servers[name] : undefined;
        if (previous) {
          if (mcpSources[name]?.id !== manifest.id || !('url' in previous) || previous.url !== value.url) {
            throw new Error(`Conflicting role MCP configuration: ${name}`);
          }
          value.tools = [...new Set([...previous.tools ?? [], ...value.tools])].sort();
          if (value.tools.includes('*')) value.tools = ['*'];
        }
        Object.defineProperty(servers, name, { value, enumerable: true, configurable: true, writable: true });
        Object.defineProperty(mcpSources, name, {
          value: contribute(previous ? mcpSources[name] : undefined), enumerable: true, configurable: true, writable: true,
        });
      }
    }
    const config: RoleAssembly['config'] = selected.length ? {
      systemMessage: { mode: 'append', content: [...instructions.values()].map(group => `${group.headers.join('\n')}\n${group.text}`).join('\n\n') },
      skillDirectories: [...directories], mcpServers: servers,
    } : {};
    return { roles, config, skills: [...skills.values()], mcpSources,
      fingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
  }
}
