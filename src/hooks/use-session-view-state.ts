'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import { buildTranscriptItems, buildTranscriptMarkdown, getMinimapTargets, messageMatchesAgent, messagePassesPreset, type FilterPreset } from '@/lib/session-transcript';
import type { SessionDiffSummary } from '@/lib/session-diff';
import type { MinimapSegment } from '@/components/session/minimap';
import { normalizeDiffPathKey, type DiffDisplayMode, type MainSessionView } from '@/components/session/diff-viewer';
import type { ArtifactViewerState } from '@/components/session/session-render-context';

const FILTER_STORAGE_KEY = 'agentscope-session-filter-preset';
const EAGER_MESSAGE_LIMIT = 200;

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
  isLive?: boolean;
  liveRevision?: string;
  assistantLabel?: string;
}

export function useSessionViewState({
  sessionId,
  messages,
  compactionTimestamps,
  diffSummary,
  isLive = false,
  liveRevision,
  assistantLabel = 'Assistant',
}: UseSessionViewStateInput) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [preset, setPreset] = useState<FilterPreset>(loadPreset);
  const [copiedContextPath, setCopiedContextPath] = useState<string | null>(null);
  const [minimapSegments, setMinimapSegments] = useState<MinimapSegment[]>([]);
  const deferredJump = useRef<{ id: string; block: 'start' | 'center' } | null>(null);
  const [artifactViewer, setArtifactViewer] = useState<ArtifactViewerState | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [copiedPatchKey, setCopiedPatchKey] = useState<string | null>(null);
  const [copiedVisibleConversation, setCopiedVisibleConversation] = useState(false);
  const [pendingConversationJump, setPendingConversationJump] = useState<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const previousMessageCountRef = useRef(messages.length);
  const initialLiveScrollSessionRef = useRef<string | null>(null);
  const deferContent = messages.length > EAGER_MESSAGE_LIMIT;

  const mainView: MainSessionView = searchParams.get('view') === 'changes' ? 'changes' : 'conversation';
  const diffMode: DiffDisplayMode = searchParams.get('diff') === 'edits' ? 'edits' : 'net';
  const toolFilter = searchParams.get('filter') || null;
  const agentFilter = searchParams.get('agent') || null;
  const agentOptions = useMemo(() => {
    const options = new Map<string, { key: string; label: string; toolCalls: number }>();
    for (const message of messages) {
      const agent = message.subagent;
      if (!agent) continue;
      const key = agent.path || agent.id;
      let option = options.get(key);
      if (!option) {
        option = { key, label: [agent.path || agent.nickname || agent.id, agent.role].filter(Boolean).join(' · '), toolCalls: 0 };
        options.set(key, option);
      }
      option.toolCalls += message.toolCalls?.length || 0;
    }
    return Array.from(options.values());
  }, [messages]);

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

  const setAgentFilter = useCallback((agent: string | null) => replaceSearchParams({ agent }), [replaceSearchParams]);

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

    deferredJump.current = deferContent ? { id: targetId, block } : null;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: deferContent ? 'instant' : 'smooth',
    });
    return true;
  }, [deferContent]);

  const scrollMessageIntoConversation = useCallback((messageIndex: number, block: 'start' | 'center' = 'center') => (
    scrollElementIntoConversation(`conversation-message-${messageIndex}`, block)
  ), [scrollElementIntoConversation]);

  const isConversationAtBottom = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return true;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= 80;
  }, []);

  const updateConversationBottomState = useCallback(() => {
    const atBottom = isConversationAtBottom();
    wasAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowScrollToBottom(false);
      setUnseenMessageCount(0);
    }
  }, [isConversationAtBottom]);

  const scrollToConversationBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    deferredJump.current = null;
    const bottom = bottomRef.current;
    const container = conversationRef.current;
    const scrollBehavior = deferContent ? 'instant' : behavior;

    if (bottom) {
      bottom.scrollIntoView({ behavior: scrollBehavior, block: 'end' });
    } else if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: scrollBehavior });
    }

    wasAtBottomRef.current = true;
    setShowScrollToBottom(false);
    setUnseenMessageCount(0);
  }, [deferContent]);

  const handleJumpToMessage = useCallback((messageIndexes: number[]) => {
    for (const messageIndex of messageIndexes) {
      if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
      replaceSearchParams({ view: null, agent: null });
      setPendingConversationJump(messageIndex);
      return;
    }
  }, [mainView, scrollMessageIntoConversation, replaceSearchParams]);

  const handleJumpToDiffMessage = useCallback((messageIndex: number) => {
    if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
    replaceSearchParams({ view: null, agent: null });
    setPendingConversationJump(messageIndex);
  }, [mainView, scrollMessageIntoConversation, replaceSearchParams]);

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
    () => buildTranscriptItems(messages, preset, compactionTimestamps, toolFilter, agentFilter),
    [messages, preset, toolFilter, compactionTimestamps, agentFilter],
  );
  const handleCopyVisibleConversation = useCallback(() => {
    void navigator.clipboard.writeText(buildTranscriptMarkdown(groupedMessages, { assistantLabel })).then(() => {
      setCopiedVisibleConversation(true);
      window.setTimeout(() => {
        setCopiedVisibleConversation(false);
      }, 1200);
    });
  }, [assistantLabel, groupedMessages]);
  const presetCounts = useMemo(() => {
    const selected = agentFilter ? messages.filter(message => messageMatchesAgent(message, agentFilter)) : messages;
    return {
      narrative: selected.filter(message => messagePassesPreset(message, 'narrative')).length,
      tools: selected.filter(message => messagePassesPreset(message, 'tools')).length,
      all: selected.length,
    };
  }, [messages, agentFilter]);
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
    if (mainView !== 'conversation' || agentFilter || pendingConversationJump === null) return;
    const frame = window.requestAnimationFrame(() => {
      scrollMessageIntoConversation(pendingConversationJump, 'center');
      setPendingConversationJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agentFilter, mainView, pendingConversationJump, scrollMessageIntoConversation]);

  useEffect(() => {
    if (initialLiveScrollSessionRef.current !== sessionId) {
      initialLiveScrollSessionRef.current = null;
      previousMessageCountRef.current = messages.length;
      const frame = window.requestAnimationFrame(() => {
        setShowScrollToBottom(false);
        setUnseenMessageCount(0);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages.length, sessionId]);

  useEffect(() => {
    if (!isLive || mainView !== 'conversation') {
      previousMessageCountRef.current = messages.length;
      return;
    }

    const previousCount = previousMessageCountRef.current;
    const nextCount = messages.length;
    const addedCount = Math.max(nextCount - previousCount, 0);
    previousMessageCountRef.current = nextCount;

    if (initialLiveScrollSessionRef.current !== sessionId) {
      initialLiveScrollSessionRef.current = sessionId;
      const frame = window.requestAnimationFrame(() => scrollToConversationBottom('auto'));
      return () => window.cancelAnimationFrame(frame);
    }

    if (addedCount === 0 && !liveRevision) return;

    if (wasAtBottomRef.current) {
      const frame = window.requestAnimationFrame(() => scrollToConversationBottom('smooth'));
      return () => window.cancelAnimationFrame(frame);
    }

    if (addedCount > 0) {
      const frame = window.requestAnimationFrame(() => {
        setShowScrollToBottom(true);
        setUnseenMessageCount(count => count + addedCount);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [isLive, liveRevision, mainView, messages.length, scrollToConversationBottom, sessionId]);

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

  const updateMinimapSegments = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollHeight = Math.max(container.scrollHeight, 1);
    const nextSegments = minimapTargets
      .map((target): MinimapSegment | null => {
        const element = document.getElementById(target.targetId);
        if (!element || !container.contains(element)) return null;

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
  }, [minimapTargets]);

  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;

    updateMinimapSegments();
    container.addEventListener('scroll', updateConversationBottomState, { passive: true });
    const releaseJump = () => { deferredJump.current = null; };
    container.addEventListener('wheel', releaseJump, { passive: true });
    container.addEventListener('pointerdown', releaseJump);
    container.addEventListener('keydown', releaseJump);

    let frame = 0;
    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        // Revealing nearby content can move a distant target after the jump.
        const jump = deferredJump.current;
        if (jump) scrollElementIntoConversation(jump.id, jump.block);
        else if (deferContent && isLive && wasAtBottomRef.current) {
          container.scrollTop = container.scrollHeight;
        }
        updateMinimapSegments();
      });
    });
    resizeObserver.observe(container);
    Array.from(container.children).forEach(child => resizeObserver.observe(child));

    return () => {
      releaseJump();
      container.removeEventListener('wheel', releaseJump);
      container.removeEventListener('pointerdown', releaseJump);
      container.removeEventListener('keydown', releaseJump);
      container.removeEventListener('scroll', updateConversationBottomState);
      resizeObserver.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [deferContent, groupedMessages, isLive, mainView, scrollElementIntoConversation, updateConversationBottomState, updateMinimapSegments]);

  return {
    state: {
      agentFilter,
      agentOptions,
      artifactViewer,
      copiedContextPath,
      copiedPatchKey,
      copiedVisibleConversation,
      diffMode,
      effectiveSelectedDiffPath,
      groupedMessages,
      mainView,
      minimapSegments,
      deferContent,
      preset,
      presetCounts,
      showScrollToBottom,
      toolFilter,
      unseenMessageCount,
    },
    refs: {
      bottomRef,
      conversationRef,
    },
    actions: {
      setAgentFilter,
      handleCopyContextPath,
      handleCopyPatch,
      handleCopyVisibleConversation,
      handleJumpToDiffMessage,
      handleJumpToMessage,
      handleOpenDiffForPath,
      handlePresetChange,
      hasDiffForPath,
      scrollElementIntoConversation,
      scrollToConversationBottom,
      setArtifactViewer,
      setDiffMode,
      setMainView,
      setSelectedDiffPath,
      setToolFilter,
    },
  };
}
