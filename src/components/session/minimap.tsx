'use client';

export interface MinimapSegment {
  type: 'user' | 'assistant' | 'system-group' | 'compaction';
  targetId: string;
  topPct: number;
  heightPct: number;
}

export interface MinimapViewport {
  topPct: number;
  heightPct: number;
}

export function findSegmentForRatio(segments: MinimapSegment[], ratio: number): MinimapSegment | undefined {
  if (segments.length === 0) return undefined;
  const targetPct = ratio * 100;
  return segments.find(segment => targetPct >= segment.topPct && targetPct <= segment.topPct + segment.heightPct)
    || segments.reduce((closest, segment) => {
      const closestCenter = closest.topPct + (closest.heightPct / 2);
      const segmentCenter = segment.topPct + (segment.heightPct / 2);
      return Math.abs(segmentCenter - targetPct) < Math.abs(closestCenter - targetPct) ? segment : closest;
    }, segments[0]);
}

export function Minimap({ segments, viewport, onJump }: {
  segments: MinimapSegment[];
  viewport: MinimapViewport;
  onJump: (targetId: string) => void;
}) {
  if (segments.length === 0) return null;

  const barHeight = 560;

  return (
    <div className="sticky top-2 self-start flex flex-col items-center gap-2 w-14 shrink-0">
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Timeline</span>
      <div className="flex flex-col gap-1 text-[9px] text-muted-foreground items-start">
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(56,138,221)]" />You</div>
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(186,117,23)]" />Claude</div>
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(107,114,128)]" />System</div>
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Session timeline"
        data-testid="session-minimap"
        className="relative w-3.5 rounded bg-muted/50 border border-border/40 cursor-pointer transition-colors hover:border-primary/60 hover:bg-muted"
        style={{ height: barHeight }}
        onClick={(event) => {
          const clickedSegment = (event.target as HTMLElement).closest<HTMLElement>('[data-target-id]');
          if (clickedSegment && event.currentTarget.contains(clickedSegment)) {
            const targetId = clickedSegment.dataset.targetId;
            if (targetId) {
              onJump(targetId);
              return;
            }
          }

          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / rect.height;
          const segment = findSegmentForRatio(segments, ratio);
          if (segment) onJump(segment.targetId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Home') {
            event.preventDefault();
            onJump(segments[0].targetId);
          }
          if (event.key === 'End') {
            event.preventDefault();
            onJump(segments[segments.length - 1].targetId);
          }
        }}
      >
        {segments.map((segment, i) => {
          const isCompaction = segment.type === 'compaction';
          const height = isCompaction ? 0.7 : Math.max(segment.heightPct, 0.8);
          let color: string;
          let opacity = 0.7;

          if (isCompaction) {
            color = 'rgb(217, 119, 6)';
            opacity = 1;
          } else if (segment.type === 'user') {
            color = 'rgb(56, 138, 221)';
            opacity = 0.95;
          } else if (segment.type === 'assistant') {
            color = 'rgb(186, 117, 23)';
            opacity = 0.85;
          } else {
            color = 'rgb(107, 114, 128)';
            opacity = 0.4;
          }

          return (
            <div
              key={i}
              data-testid="session-minimap-segment"
              data-marker-type={isCompaction ? 'compaction' : segment.type}
              data-group-index={i}
              data-target-id={segment.targetId}
              className="absolute rounded-sm"
              style={isCompaction
                ? {
                    top: `${segment.topPct}%`,
                    left: '-8px',
                    right: '-8px',
                    height: '3px',
                    background: '#F59E0B',
                    opacity,
                    zIndex: 20,
                    transform: 'translateY(-50%)',
                    boxShadow: '0 0 0 1px rgba(120,53,15,0.9), 0 0 0 4px rgba(245,158,11,0.18)',
                  }
                : { top: `${segment.topPct}%`, left: 0, right: 0, height: `${height}%`, background: color, opacity }}
              title={isCompaction ? 'Context Window Compaction' : undefined}
            />
          );
        })}
        <div
          data-testid="session-minimap-indicator"
          className="absolute -left-2.5 -right-2.5 rounded-sm border-2 border-primary bg-primary/20 shadow-[0_0_0_1px_rgba(255,255,255,0.45),0_2px_8px_rgba(0,0,0,0.22)] pointer-events-none transition-[top] duration-75"
          style={{
            top: `${viewport.topPct}%`,
            height: `${viewport.heightPct}%`,
            minHeight: '8px',
          }}
        />
      </div>
    </div>
  );
}
