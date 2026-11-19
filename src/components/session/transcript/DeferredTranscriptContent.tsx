'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// One observer per scroll pane. Keep visited content mounted so expanded tools
// and text selections survive a trip to another part of the conversation.
const observers = new WeakMap<Element, IntersectionObserver>();
const reveal = new WeakMap<Element, () => void>();

export function DeferredTranscriptContent({ enabled, placeholderHeight, targetId, children }: {
  enabled: boolean;
  placeholderHeight: number;
  targetId?: string;
  children: ReactNode;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(false);
  const deferred = enabled && !visited && typeof IntersectionObserver !== 'undefined';

  useEffect(() => {
    const node = placeholder.current;
    if (!deferred || !node) return;
    const root = node.closest('[data-transcript-scroll]') || document.documentElement;
    let observer = observers.get(root);
    if (!observer) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) reveal.get(entry.target)?.();
        }
      }, { root, rootMargin: '600px 0px' });
      observers.set(root, observer);
    }
    reveal.set(node, () => setVisited(true));
    observer.observe(node);
    return () => {
      observer.unobserve(node);
      reveal.delete(node);
    };
  }, [deferred]);

  return deferred ? <div id={targetId} ref={placeholder} style={{ height: placeholderHeight }} /> : children;
}
