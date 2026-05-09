'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastTone = 'error' | 'info' | 'success';

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
};

type ToastMessage = Required<Pick<ToastInput, 'title' | 'tone'>> & {
  id: number;
  description?: string;
};

type ToastContextValue = {
  showToast: (toast: ToastInput) => number;
  dismissToast: (id: number) => void;
  error: (title: string, description?: string) => number;
  success: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const toastStyles: Record<ToastTone, string> = {
  error: 'border-red-500/30 bg-red-50 text-red-950 shadow-red-950/10 dark:bg-red-950/90 dark:text-red-50',
  info: 'border-border bg-popover text-popover-foreground',
  success: 'border-green-500/30 bg-green-50 text-green-950 shadow-green-950/10 dark:bg-green-950/90 dark:text-green-50',
};

const toastIcons = {
  error: AlertCircle,
  info: Info,
  success: CheckCircle2,
} satisfies Record<ToastTone, typeof AlertCircle>;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextIdRef = useRef(1);
  const timeoutRefs = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;

    const tone = toast.tone ?? 'info';
    setToasts((current) => [
      ...current.slice(-3),
      {
        id,
        title: toast.title,
        description: toast.description,
        tone,
      },
    ]);

    const durationMs = toast.durationMs ?? (tone === 'error' ? 7000 : 4500);
    if (durationMs > 0) {
      const timeoutId = window.setTimeout(() => dismissToast(id), durationMs);
      timeoutRefs.current.set(id, timeoutId);
    }

    return id;
  }, [dismissToast]);

  const value = useMemo<ToastContextValue>(() => ({
    showToast,
    dismissToast,
    error: (title, description) => showToast({ title, description, tone: 'error' }),
    info: (title, description) => showToast({ title, description, tone: 'info' }),
    success: (title, description) => showToast({ title, description, tone: 'success' }),
  }), [dismissToast, showToast]);

  useEffect(() => () => {
    for (const timeoutId of timeoutRefs.current.values()) {
      window.clearTimeout(timeoutId);
    }
    timeoutRefs.current.clear();
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => {
          const Icon = toastIcons[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto grid grid-cols-[auto_1fr_auto] gap-3 rounded-md border px-3 py-2.5 text-sm shadow-lg',
                toastStyles[toast.tone],
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium leading-5">{toast.title}</p>
                {toast.description && (
                  <p className="mt-0.5 break-words text-xs leading-5 opacity-85">{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
                className="rounded-sm p-0.5 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
