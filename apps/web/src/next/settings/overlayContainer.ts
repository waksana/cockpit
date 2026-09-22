import { createContext } from 'react';

// Portaled selects must remain inside the native modal's top layer.
export const SettingsOverlayContainer = createContext<HTMLElement | null>(null);
