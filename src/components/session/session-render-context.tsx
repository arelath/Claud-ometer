'use client';

import { createContext, useContext } from 'react';
import type { CodeLanguage } from '@/lib/code-highlighting';
import type { AgentKind } from '@/lib/agent-data/types';

export type PreviewTone = 'neutral' | 'success' | 'error' | 'unknown';

export interface ArtifactViewerState {
  title: string;
  subtitle?: string;
  kind: 'text' | 'diff';
  tone?: PreviewTone;
  language?: CodeLanguage;
  sourcePath?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  location?: string;
}

export interface SessionRenderContextValue {
  projectRoot?: string;
  agentKind?: AgentKind;
  assistantLabel?: string;
  openArtifact: (artifact: ArtifactViewerState) => void;
}

export const SessionRenderContext = createContext<SessionRenderContextValue | null>(null);

export function useSessionRenderContext(): SessionRenderContextValue {
  const context = useContext(SessionRenderContext);
  if (!context) throw new Error('Session render context is missing.');
  return context;
}
