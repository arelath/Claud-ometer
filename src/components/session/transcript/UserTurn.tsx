'use client';

import { format } from 'date-fns';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';

function imageAlt(label: string | undefined, index: number): string {
  return label || `User uploaded image ${index + 1}`;
}

export function UserMessage({ msg, index }: { msg: SessionMessageDisplay; index: number }) {
  const images = (msg.images || []).filter(image => (
    image.url.startsWith('data:image/')
    || image.url.startsWith('blob:')
    || image.url.startsWith('http://')
    || image.url.startsWith('https://')
  ));

  return (
    <div id={`conversation-message-${index}`} className="border-l-2 border-blue-500 pl-3.5 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-blue-500">User</span>
        {msg.timestamp && !Number.isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="text-[11px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm a')}</span>
        )}
      </div>
      <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {msg.content}
      </div>
      {images.length > 0 && (
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(160px,240px))] gap-2">
          {images.map((image, imageIndex) => (
            <a
              key={`${image.mediaType}-${imageIndex}`}
              href={image.url}
              target="_blank"
              rel="noreferrer"
              className="group block overflow-hidden rounded-md border border-border/60 bg-muted/20"
              title={`${image.mediaType} image`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={imageAlt(image.label, imageIndex)}
                width={240}
                height={135}
                loading="lazy"
                decoding="async"
                className="aspect-video h-auto w-full object-contain transition-transform group-hover:scale-[1.01]"
              />
              <div className="border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
                {image.label || `Image ${imageIndex + 1}`}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
