import { createContext } from 'react';
import type { ModuleRuntime } from './moduleRuntime';

export const PublicComponentRuntime = createContext<ModuleRuntime | undefined>(undefined);
export const ComposerSurfaceContext = createContext(false);
