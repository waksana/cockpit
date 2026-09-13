import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CopilotClient, CopilotSession, SessionConfig } from '@github/copilot-sdk';
import type { AppliedModuleSelection } from '@cockpit/protocol';
import type { RoleSessionConfig } from '../module-session.ts';
import { bundledSkillsDirectory } from '../paths.ts';

export interface ResolvedModuleRole {
  selection: AppliedModuleSelection;
  release: string;
  instructions?: string;
  skillDirectories: string[];
  mcpServers: NonNullable<SessionConfig['mcpServers']>;
  configurationReferences?: Record<string, string>;
}
interface ExpectedSkill { name: string; path: string }

function inside(root: string, file: string): string {
  const canonical = realpathSync(file);
  const rel = relative(realpathSync(root), canonical);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Module role path escapes its immutable release');
  return canonical;
}

function expectedSkills(role: ResolvedModuleRole): ExpectedSkill[] {
  return role.skillDirectories.flatMap(root => {
    inside(role.release, root);
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      const file = inside(role.release, join(root, entry.name, 'SKILL.md'));
      const body = readFileSync(file, 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
      const names = header?.split(/\r?\n/).filter(line => /^name:/.test(line));
      const name = names?.length === 1 ? /^name:\s*([a-z][a-z0-9-]{0,99})\s*$/.exec(names[0]!)?.[1] : undefined;
      if (!name) throw new Error(`Official module skill needs one literal safe frontmatter name: ${file}`);
      return { name, path: file };
    });
  });
}

/** Resolves session-scoped native configuration; never writes global/native settings. */
export class NativeRoleEnvironment {
  constructor(private readonly runtime: Pick<CopilotClient, 'rpc'>) {}

  async configuration(roles: ResolvedModuleRole[], cwd: string): Promise<RoleSessionConfig> {
    const skills = roles.flatMap(expectedSkills);
    const names = new Set<string>();
    for (const skill of skills) {
      if (names.has(skill.name)) throw new Error(`Selected module skills conflict: ${skill.name}`);
      names.add(skill.name);
    }
    const [baseSkills, baseMcp, settings] = await Promise.all([
      this.runtime.rpc.skills.discover({ projectPaths: [resolve(cwd)], skillDirectories: [bundledSkillsDirectory] }),
      this.runtime.rpc.mcp.discover({ workingDirectory: resolve(cwd) }),
      this.runtime.rpc.user.settings.get(),
    ]);
    if (baseSkills.errors?.length) throw new Error(`Native base skill discovery failed: ${baseSkills.errors.join('; ')}`);
    for (const skill of baseSkills.skills) {
      if (names.has(skill.name)) throw new Error(`Module skill conflicts with an existing project/global skill: ${skill.name}`);
    }
    const servers: NonNullable<SessionConfig['mcpServers']> = {};
    for (const role of roles) {
      for (const [name, config] of Object.entries(role.mcpServers)) {
        if (Object.hasOwn(servers, name) || baseMcp.servers.some(server => server.name === name)) {
          throw new Error(`Module MCP conflicts with another session/project/global server: ${name}`);
        }
        servers[name] = config;
      }
    }
    const disabled = settings.settings.disabledSkills?.value;
    if (disabled !== null && (!Array.isArray(disabled) || !disabled.every(value => typeof value === 'string'))) {
      throw new Error('Native disabled skill configuration is unconfirmed');
    }
    const directories = roles.flatMap(role => role.skillDirectories);
    const discovered = await this.runtime.rpc.skills.discover({ projectPaths: [resolve(cwd)],
      skillDirectories: [...directories, bundledSkillsDirectory] });
    if (discovered.errors?.length) throw new Error(`Module skill discovery failed: ${discovered.errors.join('; ')}`);
    for (const expected of skills) {
      const actual = discovered.skills.find(skill => skill.name === expected.name);
      if (!actual?.path || realpathSync(actual.path) !== expected.path) {
        throw new Error(`Native discovery did not select the pinned skill body: ${expected.name}`);
      }
    }
    const content = roles.flatMap(role => {
      const parts: string[] = [];
      if (role.instructions) {
        parts.push(`## Selected module ${role.selection.moduleId}/${role.selection.roleId}@${role.selection.version}\n`
          + readFileSync(inside(role.release, role.instructions), 'utf8'));
      }
      if (role.configurationReferences && Object.keys(role.configurationReferences).length) {
        parts.push('Configuration references for this module (paths only; read when needed):\n'
          + JSON.stringify(role.configurationReferences));
      }
      return parts;
    }).join('\n\n');
    return {
      systemMessage: { mode: 'append', content },
      skillDirectories: directories, mcpServers: servers,
      disabledSkills: (disabled ?? []).filter(name => !names.has(name)),
    };
  }

  async assertConnected(session: CopilotSession, roles: ResolvedModuleRole[]): Promise<void> {
    const expected = roles.flatMap(expectedSkills);
    if (expected.length) {
      const actual = await session.rpc.skills.list();
      for (const skill of expected) {
        const loaded = actual.skills.find(value => value.name === skill.name);
        if (!loaded?.enabled || !loaded.path || realpathSync(loaded.path) !== skill.path) {
          throw new Error(`Pinned module skill is not active at its expected path: ${skill.name}`);
        }
      }
    }
    const servers = roles.flatMap(role => Object.keys(role.mcpServers));
    if (!servers.length) return;
    for (let attempt = 0; attempt < 100; attempt++) {
      const actual = await session.rpc.mcp.list();
      const selected = servers.map(name => actual.servers.find(server => server.name === name));
      if (selected.every(server => server?.status === 'connected')) return;
      const failed = selected.find(server => server && !['connected', 'pending'].includes(server.status));
      if (failed) throw new Error(`Module MCP connection ${failed.name} is ${failed.status}: ${failed.error ?? 'not ready'}`);
      if (attempt < 99) await sleep(50);
    }
    throw Object.assign(new Error('Module MCP connections are still unconfirmed; inspect before applying again'), { moduleOutcomeUnknown: true });
  }
}
