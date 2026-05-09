'use client';

import { type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';

function isConsoleRoute(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/console\/?$/.test(pathname);
}

function isSessionDetailRoute(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/?$/.test(pathname);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const contentMaxWidth = isSessionDetailRoute(pathname) ? 'max-w-[104rem]' : 'max-w-7xl';

  if (isConsoleRoute(pathname)) {
    return (
      <main className="h-screen min-h-screen overflow-hidden bg-black">
        {children}
      </main>
    );
  }

  return (
    <>
      <Sidebar />
      <main className="ml-60 min-h-screen">
        <div className={`mx-auto ${contentMaxWidth} px-6 py-6`}>
          {children}
        </div>
      </main>
    </>
  );
}
