import type { ElicitationResult, ExitPlanModeResult, SessionConfig } from '@github/copilot-sdk';
import { CockpitError, invalid } from './errors.ts';
import { settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';
import type { RoleAssembly, SessionInstructions } from './roles.ts';
import type { RoleService } from './role-service.ts';
import type { SkillsService } from './skills-service.ts';
import type { DecisionBroker } from './decisions.ts';
import { moduleMcpInvocationHook, SubagentNames } from './mcp-invocation.ts';

type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>>;
const planActions = new Set<string>(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);

/**
 * Builds the native create/resume configuration: role resources with conflict
 * checks, Cockpit instructions, global disabled skills and decision callbacks.
 */
export class SessionConfigurator {
  private readonly k: SessionKernel;
  private readonly roleService: RoleService;
  private readonly skills: SkillsService;
  private readonly decisions: DecisionBroker;

  constructor(k: SessionKernel, roleService: RoleService, skills: SkillsService, decisions: DecisionBroker) {
    this.k = k;
    this.roleService = roleService;
    this.skills = skills;
    this.decisions = decisions;
  }

  async config(st: SessionHandle, cwd?: string): Promise<{
    config: SessionConfig; assembly?: RoleAssembly; instructions?: SessionInstructions; subagents?: SubagentNames;
  }> {
    const disabled = await this.skills.globalDisabledSkills();
    const selected = await this.roleService.savedRoles(st.id);
    const assembly = selected.length ? await this.k.roles!.assemble(st.id, selected) : undefined;
    if (assembly?.skills.length) {
      const existing = await this.skills.discoverSkills(cwd ?? st.observedCwd ?? undefined);
      const names = new Map(existing.skills.map(skill => [skill.name, skill.path]));
      for (const directory of assembly.config.skillDirectories ?? []) {
        const discovered = await this.k.untilFatal(() => this.k.runtime.rpc.skills.discover({
          projectPaths: [], skillDirectories: [directory],
        }));
        if (discovered.errors?.length) throw new Error(`Role skill discovery failed: ${discovered.errors.join('; ')}`);
        for (const skill of assembly.skills.filter(skill => skill.path.startsWith(`${directory}/`))) {
          const native = discovered.skills.find(value => value.path === skill.path);
          if (!native) throw new Error(`Role skill was not discovered by native runtime: ${skill.path}`);
          if (names.has(native.name) && names.get(native.name) !== skill.path) {
            throw new Error(`Role skill conflicts with native discovered skill: ${native.name}`);
          }
          names.set(native.name, skill.path);
          skill.name = native.name;
        }
      }
    }
    if (assembly) {
      const [configured, discovered] = await this.k.untilFatal(() => settled([
        this.k.runtime.rpc.mcp.config.list(),
        this.k.runtime.rpc.mcp.discover({ workingDirectory: cwd ?? st.observedCwd ?? undefined }),
      ] as const));
      for (const name of Object.keys(assembly.config.mcpServers ?? {})) {
        if (Object.hasOwn(configured.servers, name) || discovered.servers.some(server => server.name === name)) {
          throw new Error(`Role MCP conflicts with native configuration: ${name}`);
        }
      }
    }
    const instructions = await this.k.roles?.sessionInstructions?.(st.id, assembly);
    const systemMessage = instructions ? { mode: 'append' as const, content: instructions.content } : assembly?.config.systemMessage;
    const moduleServers = new Set(Object.keys(assembly?.config.mcpServers ?? {}));
    const subagents = moduleServers.size ? new SubagentNames() : undefined;
    return { assembly, instructions, subagents, config: {
      ...assembly?.config, ...(systemMessage ? { systemMessage } : {}),
      ...(subagents ? { hooks: { onPreMcpToolCall: moduleMcpInvocationHook(moduleServers, subagents) } } : {}),
      sessionId: st.id, ...(cwd ? { workingDirectory: cwd } : {}), streaming: true,
      enableConfigDiscovery: true,
      // Runtime 1.0.83 discovers skills but does not apply its global disabled
      // list on create/cold resume unless the SDK receives that native value.
      disabledSkills: disabled,
      onUserInputRequest: request => this.decisions.decision<UserInputResponse>(st, 'ask', request, response => {
        if (response.wasFreeform && request.allowFreeform === false) throw invalid('Freeform answers are not allowed');
        if (!response.wasFreeform && !request.choices?.includes(response.answer)) throw invalid('Answer is not an offered choice');
      }),
      onExitPlanModeRequest: request => this.decisions.decision<ExitPlanModeResult>(st, 'planRequest', {
        ...request, actions: request.actions.filter(action => planActions.has(action)),
        recommendedAction: planActions.has(request.recommendedAction) ? request.recommendedAction : undefined,
      }, response => {
        if (response.selectedAction && (!planActions.has(response.selectedAction) || !request.actions.includes(response.selectedAction))) {
          throw invalid('Plan action was not offered or is unsupported');
        }
      }),
      onElicitationRequest: request => this.decisions.decision<ElicitationResult>(st, 'elicitation', {
        message: request.message,
        actions: request.mode === 'url' || request.requestedSchema ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel'],
      }, response => {
        if (response.action === 'accept' && (request.mode === 'url' || request.requestedSchema)) {
          throw new CockpitError('UNSUPPORTED', 'Structured/URL elicitation acceptance is unsupported; decline or cancel the real request');
        }
      }),
    } };
  }
}
