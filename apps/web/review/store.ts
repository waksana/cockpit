import { create } from 'zustand';
import type { UploadedFile } from '@cockpit/protocol';

// Display-only inputs consumed by production components. There is no native
// client, session registry, initializer, notification or business action here.
export const useCockpit = create<{
  connState: 'open' | 'connecting';
  connectionGeneration: number;
  sessions: { sessionId: string; title: string }[];
  speechToken: () => Promise<{ enabled: boolean }>;
  filesGet: (url: string, signal?: AbortSignal) => Promise<UploadedFile>;
}>(() => ({
  connState: 'open', connectionGeneration: 0, sessions: [],
  speechToken: async () => ({ enabled: false }),
  filesGet: async () => { throw new Error('Review fixture metadata is not configured.'); },
}));
