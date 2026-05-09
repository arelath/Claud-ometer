'use client';

import { use } from 'react';
import { ManagedPtyConsole } from '@/components/session/managed-pty-console';

export default function SessionConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <div className="h-screen w-screen overflow-hidden bg-black">
      <ManagedPtyConsole sessionId={id} />
    </div>
  );
}
