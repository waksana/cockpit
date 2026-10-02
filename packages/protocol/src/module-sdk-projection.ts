import type { IntentBody, IntentResult, ResourcePreparationResult } from './index.ts';

export type {
  NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent,
  SessionStatus, AgentStatus, ContextTier, AgentMode, ModelOption, QueuedItem,
  AskRequest, ExitPlanModeAction, PlanRequest, ElicitationRequest, PendingDecision,
  TodoProgress, SessionActivity, SessionControls, RoleSelection, SessionRole,
  SessionMeta, SessionResource, Snapshot, ServerEvent,
  SessionResourcesPrepare, ResourcePreparationResult,
  ToolScope, SessionToolScope, PromptAccepted,
  RoleAssignmentFailure, RoleAssignmentFailureDetails, RoleAssignmentMutationResult,
  RoleAvailability, RoleAvailabilityQuery, RoleAvailabilityReason, RoleCapability,
} from './index.ts';

type AllowedIntent =
  'session/new' | 'session/get' | 'session/rename' | 'roles/readiness' | 'session/resources-prepare' | 'prompt'
  | 'respondAsk' | 'session/chat' | 'session/directory' | 'session/load' | 'roles/notify' | 'session/tool-scope'
  | 'roles/availability';

export type ModuleHostIntentMap = {
  [Name in AllowedIntent]: { body: IntentBody<Name>; result: IntentResult<Name> };
};
export type ResourcePreparationEffect = ResourcePreparationResult['skills'][number]['effect'];
