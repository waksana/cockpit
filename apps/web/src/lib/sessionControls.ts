import type { ChatSession } from '../net/types';
import { sessionActivityIndicators, type ActivityIndicator } from './sessionActivity';

export interface SessionControls {
  main: boolean;
  compaction: 'manual' | 'auto' | null;
  tasks: {
    id: string;
    kind: 'shell' | 'agent';
    title: string;
    status: 'running' | 'cancelled';
  }[];
  steering: { id: string; text: string }[];
}

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

export type SessionControlAction =
  | { type: 'stop-all' | 'clear-queue' | 'cancel-compaction' | 'prune-tasks' }
  | { type: 'stop-task' | 'remove-task' | 'remove' | 'steer'; id: string };

export function controlIndicators(session: ChatSession, controls: SessionControls, connected: boolean): ActivityIndicator[] {
  return sessionActivityIndicators({ ...session, compacting: !!controls.compaction,
    needsDecision: !!(session.ask || session.planRequest || session.elicitation) }, connected, true);
}
