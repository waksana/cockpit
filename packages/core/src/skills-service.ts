import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SkillSession } from '@cockpit/protocol';
import { SkillNotFoundError, unsupported } from './errors.ts';
import { settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';

/** Native global skill discovery/configuration and per-session skill state. */
export class SkillsService {
  private readonly k: SessionKernel;

  constructor(k: SessionKernel) {
    this.k = k;
  }

  async discoverSkills(cwd?: string) {
    const result = await this.k.untilFatal(() => this.k.runtime.rpc.skills.discover({
      projectPaths: [resolve(cwd || homedir())],
    }));
    if (result.errors?.length) throw new Error(`Native skill discovery failed: ${result.errors.join('; ')}`);
    return result;
  }

  async globalDisabledSkills(): Promise<string[]> {
    const settings = await this.k.untilFatal(() => this.k.runtime.rpc.user.settings.get());
    const disabled = settings.settings.disabledSkills?.value;
    if (disabled === null) return [];
    if (!Array.isArray(disabled) || !disabled.every(name => typeof name === 'string')) {
      throw new Error('Native global skill state is unconfirmed: disabledSkills must be a string array');
    }
    return disabled;
  }

  private async globalSkills(cwd?: string) {
    const [result, disabled] = await this.k.untilFatal(() => settled([
      this.discoverSkills(cwd), this.globalDisabledSkills(),
    ] as const));
    const names = new Set(disabled);
    return result.skills.map(skill => ({ ...skill, enabled: !names.has(skill.name) }));
  }

  async listGlobalSkills(cwd?: string) {
    const skills = await this.globalSkills(cwd);
    return Promise.all(skills.map(async ({ name, description, source, userInvocable, enabled, path }) => {
      const modules = path ? await this.k.roles?.globalSkillSources?.(path) : undefined;
      return { name, description, source, userInvocable, enabled, ...(modules?.length ? { modules } : {}) };
    }));
  }

  async readSkillBody(name: string, cwd?: string) {
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill) throw new SkillNotFoundError();
    if (!skill.path) return unsupported('Skill body without a public local path');
    const modules = await this.k.roles?.globalSkillSources?.(skill.path);
    const body = await readFile(skill.path, 'utf8');
    return { name: skill.name, description: skill.description, source: skill.source,
      userInvocable: skill.userInvocable, enabled: skill.enabled, body,
      ...(modules?.length ? { modules } : {}) };
  }

  async setGlobalSkill(name: string, enabled: boolean, cwd?: string): Promise<void> {
    if (!(await this.globalSkills(cwd)).some(skill => skill.name === name)) throw new SkillNotFoundError();
    await this.k.untilFatal(() => this.k.runtime.rpc.skills.config.setSkillDisabled({ name, disabled: !enabled }));
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill || skill.enabled !== enabled) throw new Error('Native global skill state did not confirm the requested change');
  }

  async listSessionSkills(id: string): Promise<SkillSession[]> {
    return this.k.operation(id, async (sdk, st) => (await this.k.withSession(st, sdk, () => sdk.rpc.skills.list())).skills.map(
      ({ name, description, source, enabled, path }) => {
        const module = st.roleAssembly?.skills.find(skill => skill.name === name && skill.path === path)?.module;
        return { name, description, source, enabled, ...(module ? { module: { ...module } } : {}) };
      }), 'read');
  }

  async toggleSessionSkill(id: string, name: string, enabled: boolean): Promise<void> {
    await this.k.operation(id, async (sdk, st) => {
      await this.k.withSession(st, sdk, () => sdk.rpc.skills[enabled ? 'enable' : 'disable']({ name }));
      const skill = (await this.k.withSession(st, sdk, () => sdk.rpc.skills.list())).skills.find(skill => skill.name === name);
      if (!skill || skill.enabled !== enabled) throw new Error('Native skill state did not confirm the requested change');
    }, ['skills', 'usage']);
  }

  async refreshSkills(): Promise<void> {
    this.k.assertAvailable();
    const loaded = [...this.k.sessions.values()].filter(st => st.sdk);
    if (!loaded.length) {
      await this.discoverSkills();
      return;
    }
    for (const st of loaded) {
      await this.k.operation(st.id, async sdk => {
        const result = await sdk.rpc.skills.reload();
        const diagnostics = [...result.errors, ...result.warnings];
        if (diagnostics.length) throw new Error(`Native skill reload diagnostics: ${diagnostics.join('; ')}`);
      }, 'read', undefined, ['skills', 'usage']);
    }
  }
}
