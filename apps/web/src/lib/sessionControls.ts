import type { ChatSession } from '../net/types';
import { sessionActivityIndicators, type ActivityIndicator } from './sessionActivity';
import type { SessionControls as NativeSessionControls } from '@cockpit/protocol';

export type SessionControls = Pick<NativeSessionControls, 'main' | 'compaction' | 'tasks' | 'steering'>;

export interface AgentTaskDetails {
  sessionId: string;
  taskId: string;
  title: string;
  status: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';
  description?: string;
  prompt?: string;
  model?: string;
  latestIntent?: string;
  recentActivity: { message: string; timestamp: string }[];
  latestResponse?: string;
  result?: string;
  error?: string;
}

export type ReadAgentTaskDetails = (sessionId: string, taskId: string, signal: AbortSignal) => Promise<AgentTaskDetails | null>;

export type { SessionControlAction } from '@cockpit/protocol';

export function controlIndicators(session: ChatSession, controls: SessionControls, connected: boolean): ActivityIndicator[] {
  return sessionActivityIndicators({ ...session, compacting: !!controls.compaction,
    needsDecision: !!(session.ask || session.planRequest || session.elicitation) }, connected, true);
}
