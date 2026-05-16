import { Suspense } from 'react';
import { DashboardClient } from '@/components/pages/dashboard-client';

export default function DashboardPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading analytics..." />}>
      <DashboardClient />
    </Suspense>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="flex h-[80vh] items-center justify-center">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
