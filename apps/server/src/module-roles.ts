import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  MODULE_SKILL_NOT_FOUND, SessionRole,
  type ModuleRoleResources, type ModuleRoleSkill, type ModuleSkillSource, type ModuleSource, type RoleSelection,
} from '@cockpit/protocol';
import type { RoleAssembly, RoleProvider, SessionInstructions } from '@cockpit/core';
import type { ModuleInstallation } from './module-install.ts';
import { MODULE_INSTRUCTIONS_LIMIT, safeModulePath } from './module-install.ts';

export const USER_INSTRUCTIONS_FILE = 'instructions.md';
export const USER_INSTRUCTIONS_LIMIT = 16 * 1024;

async function verifiedResource(installation: ModuleInstallation, relative: string): Promise<string> {
  const { root } = installation;
  const path = join(root, safeModulePath(relative));
  if (!(await realpath(path)).startsWith(`${resolve(root)}${sep}`)) throw new Error('Role resource escapes module');
  const record = installation.files[relative];
  const bytes = await readFile(path);
  if (!record || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error(`Role resource changed: ${relative}`);
  return bytes.toString('utf8');
}

// The native discovery preflight owns complete frontmatter parsing.
const roleSkillName = (body: string, path: string) =>
  /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(body)?.[1]?.trim() ?? path;

// Display-only description for the read-only catalog; names use the assembly rule.
function skillDescription(body: string): string | undefined {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? '';
  const lines = header.split(/\r?\n/);
  const scalar = (key: string) => {
    const index = lines.findIndex(line => line.startsWith(`${key}:`));
    if (index < 0) return;
    const inline = lines[index]!.slice(key.length + 1).trim();
    const continuation: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      continuation.push(line.trim());
    }
    const block = /^[>|][+-]?$/.test(inline);
    const text = block ? continuation.join(inline.startsWith('|') ? '\n' : ' ')
      : [inline, ...continuation].join(' ');
    const trimmed = text.trim();
    const unquoted = /^(["']).*\1$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
    return unquoted.trim() || undefined;
  };
  return scalar('description');
}

const roleSkillFiles = (installation: ModuleInstallation, directory: string) =>
  Object.keys(installation.files).filter(path => path.startsWith(`${directory}/`) && path.endsWith('/SKILL.md'));

const roleSkillId = (installation: ModuleInstallation, relative: string) =>
  createHash('sha256').update(`${installation.digest}\0${relative}`).digest('hex');

const moduleSkillNotFound = () => Object.assign(
  new Error('Module Skill is unavailable, disabled, replaced or no longer current'),
  { code: MODULE_SKILL_NOT_FOUND, statusCode: 404 },
);

const moduleSkillReadFailed = (cause: unknown): never => {
  throw new Error('Module Skill could not be verified or read', { cause });
};

const normalizedTools = (tools: Iterable<string>) => {
  const sorted = [...new Set(tools)].sort();
  return sorted.includes('*') ? ['*'] : sorted;
};

export class ModuleRoles implements RoleProvider {
  constructor(private readonly root: string, private readonly origin: string,
    private readonly installations: () => ModuleInstallation[]) {}

  list() {
    return this.installations().flatMap(({ manifest }) => (manifest.roles ?? []).map(role => ({
      moduleId: manifest.id, moduleName: manifest.name, roleId: role.id, name: role.name,
      ...(role.description ? { description: role.description } : {}),
    }))).sort((a, b) => `${a.moduleId}/${a.roleId}`.localeCompare(`${b.moduleId}/${b.roleId}`));
  }

  async resources(): Promise<ModuleRoleResources[]> {
    const modules = [...this.installations()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    const result: ModuleRoleResources[] = [];
    for (const installation of modules) {
      const { manifest } = installation;
      const roles = [...manifest.roles ?? []].sort((a, b) => a.id.localeCompare(b.id));
      const skills = new Map<string, { id: string; name: string; description?: string; roles: Set<string> }>();
      const servers = new Map<string, { name: string; tools: Set<string>; roles: Set<string> }>();
      const bodies = new Map<string, { name: string; description?: string }>();
      for (const role of roles) {
        for (const directory of role.skillDirectories ?? []) {
          for (const path of roleSkillFiles(installation, directory)) {
            let parsed = bodies.get(path);
            if (!parsed) {
              const body = await verifiedResource(installation, path).catch(moduleSkillReadFailed);
              const description = skillDescription(body);
              bodies.set(path, parsed = { name: roleSkillName(body, path), ...(description ? { description } : {}) });
            }
            const id = roleSkillId(installation, path);
            const entry = skills.get(id) ?? { id, ...parsed, roles: new Set<string>() };
            entry.roles.add(role.id);
            skills.set(id, entry);
          }
        }
        for (const [name, config] of Object.entries(role.mcpServers ?? {})) {
          const entry = servers.get(name) ?? { name, tools: new Set<string>(), roles: new Set<string>() };
          for (const tool of config.tools) entry.tools.add(tool);
          entry.roles.add(role.id);
          servers.set(name, entry);
        }
      }
      if (!skills.size && !servers.size) continue;
      const sortedRoles = (ids: Set<string>) => [...ids].sort();
      result.push({
        id: manifest.id, name: manifest.name,
        roles: roles.map(role => ({ id: role.id, name: role.name })),
        skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
          .map(({ roles: ids, ...skill }) => ({ ...skill, roles: sortedRoles(ids) })),
        mcpServers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name))
          .map(({ name, tools, roles: ids }) => ({ name, tools: normalizedTools(tools), roles: sortedRoles(ids) })),
      });
    }
    return result;
  }

  async readSkill(moduleId: string, resourceId: string): Promise<ModuleRoleSkill> {
    const installation = this.installations().find(value => value.manifest.id === moduleId);
    if (!installation) throw moduleSkillNotFound();
    const roles = [...installation.manifest.roles ?? []].sort((a, b) => a.id.localeCompare(b.id));
    const paths = [...new Set(roles.flatMap(role =>
      (role.skillDirectories ?? []).flatMap(directory => roleSkillFiles(installation, directory))))];
    const path = paths.find(relative => roleSkillId(installation, relative) === resourceId);
    if (!path) throw moduleSkillNotFound();
    const body = await verifiedResource(installation, path).catch(moduleSkillReadFailed);
    const contributors = roles.filter(role => (role.skillDirectories ?? [])
      .some(directory => path.startsWith(`${directory}/`)));
    if (!contributors.length) throw moduleSkillNotFound();
    const all = contributors.length === roles.length;
    const description = skillDescription(body);
    return {
      id: resourceId,
      name: roleSkillName(body, path),
      ...(description ? { description } : {}),
      body,
      module: {
        id: installation.manifest.id,
        name: installation.manifest.name,
        ...(all ? {} : { roles: contributors.map(role => ({ id: role.id, name: role.name })) }),
      },
    };
  }

  globalMcpSources(config: object): ModuleSource[] | undefined {
    if (!('type' in config) || config.type !== 'http' || !('url' in config) || typeof config.url !== 'string') return;
    for (const { manifest, digest } of this.installations()) {
      const matches = (manifest.roles ?? []).some(role => Object.values(role.mcpServers ?? {}).some(server =>
        config.url === new URL(`/_modules/${manifest.id}/${digest}/api${server.path}`, this.origin).href));
      if (matches) return [{ id: manifest.id, name: manifest.name }];
    }
  }

  async globalSkillSources(path: string): Promise<ModuleSkillSource[] | undefined> {
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const installation of this.installations()) {
      const { manifest, root, files } = installation;
      const prefix = `${resolve(root)}${sep}`;
      if (!canonical.startsWith(prefix)) continue;
      const relative = canonical.slice(prefix.length);
      if (relative !== 'SKILL.md' && !relative.endsWith('/SKILL.md')) return;
      const record = Object.hasOwn(files, relative) ? files[relative] : undefined;
      if (!record) return;
      try {
        const bytes = await readFile(canonical);
        if (createHash('sha256').update(bytes).digest('hex') === record.sha256) {
          const roleResource = (manifest.roles ?? []).some(role => (role.skillDirectories ?? [])
            .some(directory => roleSkillFiles(installation, directory).includes(relative)));
          return [{
            id: manifest.id, name: manifest.name,
            ...(roleResource ? { resourceId: roleSkillId(installation, relative) } : {}),
          }];
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      return;
    }
  }

  /**
   * The single composition point for Cockpit-appended instructions, in order:
   * enabled module defaults (by module ID), applied role instructions, then the
   * user's COCKPIT_HOME/instructions.md. Read only when a session is created or resumed.
   */
  async sessionInstructions(_sessionId: string, assembly?: RoleAssembly): Promise<SessionInstructions | undefined> {
    const sections: string[] = [];
    const sources: SessionInstructions['sources'] = [];
    const modules = [...this.installations()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    for (const installation of modules) {
      const { manifest, root } = installation;
      if (!manifest.instructions) continue;
      const text = await verifiedResource(installation, manifest.instructions);
      if (Buffer.byteLength(text) > MODULE_INSTRUCTIONS_LIMIT) throw new Error(`Module default instructions exceed 16 KiB: ${manifest.id}`);
      if (!text.trim()) continue;
      const header = `Module ${manifest.id} (${manifest.name})`;
      sections.push(`## ${header}\n${text}`);
      sources.push({ label: header, sublabel: join(root, manifest.instructions) });
    }
    const roles = assembly?.config.systemMessage;
    if (roles && 'content' in roles && roles.content) {
      sections.push(roles.content);
      sources.push(...assembly.instructionSources ?? []);
    }
    const user = await this.userInstructions();
    if (user) {
      sections.push(`## Cockpit user instructions\n${user.text}`);
      sources.push({ label: 'Cockpit user instructions', sublabel: user.path });
    }
    return sections.length ? { content: sections.join('\n\n'), sources } : undefined;
  }

  private async userInstructions(): Promise<{ path: string; text: string } | undefined> {
    const path = join(this.root, USER_INSTRUCTIONS_FILE);
    let info;
    try { info = await stat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!info.isFile()) throw new Error(`Cockpit user instructions must be a regular file: ${path}`);
    if (info.size > USER_INSTRUCTIONS_LIMIT) throw new Error(`Cockpit user instructions exceed 16 KiB: ${path}`);
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > USER_INSTRUCTIONS_LIMIT) throw new Error(`Cockpit user instructions exceed 16 KiB: ${path}`);
    return text.trim() ? { path, text } : undefined;
  }

  private file(sessionId: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('Invalid role session identity');
    return join(this.root, 'session-roles', `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<SessionRole[]> {
    try {
      return SessionRole.array().parse(JSON.parse(await readFile(this.file(sessionId), 'utf8'))).map(selection => {
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
    const directory = join(this.root, 'session-roles');
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pending = `${file}.${randomUUID()}.pending`;
    const bytes = JSON.stringify(SessionRole.array().parse(roles));
    try {
      const handle = openSync(pending, 'wx', 0o600);
      try {
        writeFileSync(handle, bytes);
        fsyncSync(handle);
      } finally { closeSync(handle); }
      renameSync(pending, file);
    } finally { rmSync(pending, { force: true }); }
    syncDirectory(directory);
    // A freshly created directory chain must also be durable in its parents.
    if (created) for (let path = dirname(directory); ; path = dirname(path)) {
      syncDirectory(path);
      if (path === dirname(created) || path === dirname(path)) break;
    }
  }

  async assemble(sessionId: string, selections: RoleSelection[]): Promise<RoleAssembly> {
    const roles: SessionRole[] = [];
    const skills = new Map<string, { name: string; path: string; hash: string; module: ModuleSource }>();
    const directories = new Set<string>();
    const instructions = new Map<string, { headers: string[]; text: string }>();
    const instructionSources: SessionInstructions['sources'] = [];
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
      const verified = (relative: string) => verifiedResource(installation, relative);
      roles.push({ ...selection, moduleName: manifest.name, name: role.name });
      const text = role.instructions ? await verified(role.instructions) : '';
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`Role instructions exceed 64 KiB: ${manifest.id}/${role.id}`);
      const source = role.instructions ? join(root, role.instructions) : `${manifest.id}/${role.id}`;
      const group = instructions.get(source) ?? { headers: [], text };
      group.headers.push(`## Module ${manifest.id} / role ${role.id} (${role.name})\nNative session ID: ${sessionId}`);
      instructions.set(source, group);
      instructionSources.push({ label: `Module ${manifest.id} / role ${role.id} (${role.name})`,
        ...(role.instructions ? { sublabel: source } : {}) });
      for (const directory of role.skillDirectories ?? []) {
        const absolute = join(root, safeModulePath(directory));
        if (!await stat(absolute).then(value => value.isDirectory())) throw new Error(`Role skill root missing: ${directory}`);
        const files = roleSkillFiles(installation, directory);
        if (!files.length) throw new Error(`Role skill root has no skills: ${directory}`);
        for (const path of files) {
          const body = await verified(path);
          const name = roleSkillName(body, path);
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
    return { roles, config, skills: [...skills.values()], mcpSources, instructionSources,
      fingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
  }
}

function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
