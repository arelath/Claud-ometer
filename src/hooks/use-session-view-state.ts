'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import { buildTranscriptItems, getMinimapTargets, messagePassesPreset, type FilterPreset } from '@/lib/session-transcript';
import type { SessionDiffSummary } from '@/lib/session-diff';
import { MinimapSegment, MinimapViewport } from '@/components/session/minimap';
import { normalizeDiffPathKey, type DiffDisplayMode, type MainSessionView } from '@/components/session/diff-viewer';
import type { ArtifactViewerState } from '@/components/session/session-render-context';

const FILTER_STORAGE_KEY = 'claud-ometer-session-filter-preset';

function loadPreset(): FilterPreset {
  if (typeof window === 'undefined') return 'narrative';
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw === 'narrative' || raw === 'tools' || raw === 'all') return raw;
    return 'narrative';
  } catch {
    return 'narrative';
  }
}

function savePreset(preset: FilterPreset): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(FILTER_STORAGE_KEY, preset);
}

interface UseSessionViewStateInput {
  sessionId: string;
  messages: SessionMessageDisplay[];
  compactionTimestamps: string[];
  diffSummary: SessionDiffSummary;
}

export function useSessionViewState({
  sessionId,
  messages,
  compactionTimestamps,
  diffSummary,
}: UseSessionViewStateInput) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [preset, setPreset] = useState<FilterPreset>(loadPreset);
  const [copiedContextPath, setCopiedContextPath] = useState<string | null>(null);
  const [minimapSegments, setMinimapSegments] = useState<MinimapSegment[]>([]);
  const [minimapViewport, setMinimapViewport] = useState<MinimapViewport>({ topPct: 0, heightPct: 6 });
  const [artifactViewer, setArtifactViewer] = useState<ArtifactViewerState | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [copiedPatchKey, setCopiedPatchKey] = useState<string | null>(null);
  const [pendingConversationJump, setPendingConversationJump] = useState<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  const mainView: MainSessionView = searchParams.get('view') === 'changes' ? 'changes' : 'conversation';
  const diffMode: DiffDisplayMode = searchParams.get('diff') === 'edits' ? 'edits' : 'net';
  const toolFilter = searchParams.get('filter') || null;

  const replaceSearchParams = useCallback((updates: Record<string, string | null>) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value == null || value === '') {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    });
    const query = nextParams.toString();
    router.replace(query ? `/sessions/${sessionId}?${query}` : `/sessions/${sessionId}`, { scroll: false });
  }, [router, searchParams, sessionId]);

  const setMainView = useCallback((view: MainSessionView) => {
    replaceSearchParams({ view: view === 'changes' ? 'changes' : null });
  }, [replaceSearchParams]);

  const setDiffMode = useCallback((mode: DiffDisplayMode) => {
    replaceSearchParams({ diff: mode === 'edits' ? 'edits' : null });
  }, [replaceSearchParams]);

  const setToolFilter = useCallback((filter: string | null) => {
    replaceSearchParams({ filter });
  }, [replaceSearchParams]);

  const handlePresetChange = useCallback((next: FilterPreset) => {
    setPreset(next);
    savePreset(next);
  }, []);

  const scrollElementIntoConversation = useCallback((targetId: string, block: 'start' | 'center' = 'center') => {
    const container = conversationRef.current;
    const safeTargetId = CSS.escape(targetId);
    const selector = `#${safeTargetId}`;
    const element = (container?.querySelector<HTMLElement>(selector) || document.getElementById(targetId));
    if (!element) return false;

    if (!container) {
      element.scrollIntoView({ behavior: 'smooth', block });
      return true;
    }

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const elementTop = elementRect.top - containerRect.top + container.scrollTop;
    const targetTop = block === 'center'
      ? elementTop - (container.clientHeight / 2) + (elementRect.height / 2)
      : elementTop;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
    return true;
  }, []);

  const scrollMessageIntoConversation = useCallback((messageIndex: number, block: 'start' | 'center' = 'center') => (
    scrollElementIntoConversation(`conversation-message-${messageIndex}`, block)
  ), [scrollElementIntoConversation]);

  const handleJumpToMessage = useCallback((messageIndexes: number[]) => {
    for (const messageIndex of messageIndexes) {
      if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
      setMainView('conversation');
      setPendingConversationJump(messageIndex);
      return;
    }
  }, [mainView, scrollMessageIntoConversation, setMainView]);

  const handleJumpToDiffMessage = useCallback((messageIndex: number) => {
    if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
    setMainView('conversation');
    setPendingConversationJump(messageIndex);
  }, [mainView, scrollMessageIntoConversation, setMainView]);

  const handleCopyContextPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath).then(() => {
      setCopiedContextPath(filePath);
      window.setTimeout(() => {
        setCopiedContextPath(current => (current === filePath ? null : current));
      }, 1200);
    });
  }, []);

  const handleCopyPatch = useCallback((patchText: string, key: string) => {
    void navigator.clipboard.writeText(patchText).then(() => {
      setCopiedPatchKey(key);
      window.setTimeout(() => {
        setCopiedPatchKey(current => (current === key ? null : current));
      }, 1200);
    });
  }, []);

  const groupedMessages = useMemo(
    () => buildTranscriptItems(messages, preset, compactionTimestamps, toolFilter),
    [messages, preset, toolFilter, compactionTimestamps],
  );
  const presetCounts = useMemo(() => ({
    narrative: messages.filter(message => messagePassesPreset(message, 'narrative')).length,
    tools: messages.filter(message => messagePassesPreset(message, 'tools')).length,
    all: messages.length,
  }), [messages]);
  const diffPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of diffSummary.files) {
      map.set(normalizeDiffPathKey(file.path), file.path);
    }
    return map;
  }, [diffSummary.files]);
  const effectiveSelectedDiffPath = useMemo(() => {
    if (selectedDiffPath && diffSummary.files.some(file => file.path === selectedDiffPath)) return selectedDiffPath;
    return diffSummary.files[0]?.path || null;
  }, [diffSummary.files, selectedDiffPath]);
  const minimapTargets = useMemo(() => getMinimapTargets(groupedMessages), [groupedMessages]);

  useEffect(() => {
    if (mainView !== 'conversation' || pendingConversationJump === null) return;
    const frame = window.requestAnimationFrame(() => {
      scrollMessageIntoConversation(pendingConversationJump, 'center');
      setPendingConversationJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mainView, pendingConversationJump, scrollMessageIntoConversation]);

  const hasDiffForPath = useCallback((filePath: string) => (
    diffPathMap.has(normalizeDiffPathKey(filePath))
  ), [diffPathMap]);

  const handleOpenDiffForPath = useCallback((filePath: string) => {
    const diffPath = diffPathMap.get(normalizeDiffPathKey(filePath));
    if (!diffPath) return false;
    setSelectedDiffPath(diffPath);
    setMainView('changes');
    return true;
  }, [diffPathMap, setMainView]);

  const updateMinimapViewport = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;

    const scrollHeight = Math.max(container.scrollHeight, 1);
    const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 0);
    const rawHeightPct = (container.clientHeight / scrollHeight) * 100;
    const heightPct = Math.min(100, Math.max(rawHeightPct, 6));
    const topPct = maxScroll > 0
      ? (container.scrollTop / maxScroll) * (100 - heightPct)
      : 0;

    setMinimapViewport({ topPct, heightPct });
  }, []);

  const updateMinimapSegments = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollHeight = Math.max(container.scrollHeight, 1);
    const nextSegments = minimapTargets
      .map((target): MinimapSegment | null => {
        const element = container.querySelector<HTMLElement>(`#${CSS.escape(target.targetId)}`);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const top = rect.top - containerRect.top + container.scrollTop;
        return {
          type: target.type,
          targetId: target.targetId,
          topPct: Math.max(0, Math.min(100, (top / scrollHeight) * 100)),
          heightPct: Math.max((rect.height / scrollHeight) * 100, target.type === 'compaction' ? 0.7 : 0.8),
        };
      })
      .filter((segment): segment is MinimapSegment => Boolean(segment))
      .sort((left, right) => left.topPct - right.topPct);

    setMinimapSegments(nextSegments);
    updateMinimapViewport();
  }, [minimapTargets, updateMinimapViewport]);

  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;

    updateMinimapSegments();
    const handleScroll = () => updateMinimapViewport();
    container.addEventListener('scroll', handleScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateMinimapSegments());
    resizeObserver.observe(container);
    Array.from(container.children).forEach(child => resizeObserver.observe(child));

    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [groupedMessages, mainView, updateMinimapSegments, updateMinimapViewport]);

  return {
    state: {
      artifactViewer,
      copiedContextPath,
      copiedPatchKey,
      diffMode,
      effectiveSelectedDiffPath,
      groupedMessages,
      mainView,
      minimapSegments,
      minimapViewport,
      preset,
      presetCounts,
      toolFilter,
    },
    refs: {
      conversationRef,
    },
    actions: {
      handleCopyContextPath,
      handleCopyPatch,
      handleJumpToDiffMessage,
      handleJumpToMessage,
      handleOpenDiffForPath,
      handlePresetChange,
      hasDiffForPath,
      scrollElementIntoConversation,
      setArtifactViewer,
      setDiffMode,
      setMainView,
      setSelectedDiffPath,
      setToolFilter,
    },
  };
}
