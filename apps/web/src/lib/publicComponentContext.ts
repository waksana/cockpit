import { createContext } from 'react';
import type { ModuleRuntime } from './moduleRuntime';

export const PublicComponentRuntime = createContext<ModuleRuntime | undefined>(undefined);
export const ComposerSurfaceContext = createContext(false);
/** Native transcript frames retain their existing measurement/anchor ownership. */
export const ChatMessageFrameContext = createContext<{ anchorId: string } | undefined>(undefined);
