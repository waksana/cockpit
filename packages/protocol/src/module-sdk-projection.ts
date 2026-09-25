import type { IntentBody, IntentResult, ResourcePreparationResult } from './index.ts';

export type {
  NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent,
  SessionStatus, AgentStatus, ContextTier, AgentMode, ModelOption, QueuedItem,
  AskRequest, ExitPlanModeAction, PlanRequest, ElicitationRequest, PendingDecision,
  TodoProgress, SessionActivity, SessionControls, RoleSelection, SessionRole,
  SessionMeta, SessionResource, Snapshot, ServerEvent,
  SessionResourcesPrepare, ResourcePreparationResult,
} from './index.ts';

type AllowedIntent =
  'session/new' | 'session/get' | 'session/rename' | 'roles/readiness' | 'session/resources-prepare' | 'prompt';

export type ModuleHostIntentMap = {
  [Name in AllowedIntent]: { body: IntentBody<Name>; result: IntentResult<Name> };
};
export type ResourcePreparationEffect = ResourcePreparationResult['skills'][number]['effect'];
