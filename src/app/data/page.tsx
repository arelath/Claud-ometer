'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import useSWR, { mutate } from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Download,
  Upload,
  HardDrive,
  Cloud,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileArchive,
  ArrowRightLeft,
} from 'lucide-react';
import type { AgentKind } from '@/lib/agent-data/types';
import { AGENT_KINDS, getAgentLabel } from '@/lib/agent-data/types';
import { AgentBadge } from '@/components/agent-badge';

const fetcher = (url: string) => fetch(url).then(r => r.json());

type ExportFormat = 'full' | 'standardized';
type SourceUpdate = { source?: DataSourceInfo['active']; agents?: AgentKind[] };

interface DataSourceInfo {
  active: 'live' | 'imported';
  agents: AgentKind[];
  detectedAgents: AgentKind[];
  hasImportedData: boolean;
  importMeta: {
    importedAt: string;
    exportedAt: string;
    exportedFrom: string;
    projectCount: number;
    sessionCount: number;
    fileCount: number;
    totalSize: number;
    agents?: AgentKind[];
  } | null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sameAgents(left: AgentKind[], right: AgentKind[]): boolean {
  return left.length === right.length && left.every((agent, index) => agent === right[index]);
}

export default function DataPage() {
  const { data: sourceInfo, mutate: mutateSource } = useSWR<DataSourceInfo>('/api/data-source', fetcher);
  const [optimisticSourceInfo, setOptimisticSourceInfo] = useState<DataSourceInfo | null>(null);
  const [sourceUpdatePending, setSourceUpdatePending] = useState(false);
  const pendingSourceUpdates = useRef(0);
  const latestSourceUpdate = useRef(0);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const displayedSourceInfo = optimisticSourceInfo || sourceInfo;

  useEffect(() => {
    if (
      sourceInfo
      && optimisticSourceInfo
      && !sourceUpdatePending
      && sourceInfo.active === optimisticSourceInfo.active
      && sameAgents(sourceInfo.agents, optimisticSourceInfo.agents)
    ) {
      setOptimisticSourceInfo(null);
    }
  }, [optimisticSourceInfo, sourceInfo, sourceUpdatePending]);

  const applyOptimisticSourceUpdate = useCallback((update: SourceUpdate): DataSourceInfo | null => {
    const base = optimisticSourceInfo || sourceInfo;
    if (!base) return null;

    const next: DataSourceInfo = {
      ...base,
      active: update.source || base.active,
      agents: update.agents ?? base.agents,
    };
    setOptimisticSourceInfo(next);
    void mutateSource(next, { revalidate: false });
    return next;
  }, [mutateSource, optimisticSourceInfo, sourceInfo]);

  const commitSourceUpdate = useCallback(async (
    update: SourceUpdate,
    successText: string,
  ) => {
    const previous = optimisticSourceInfo || sourceInfo || null;
    const next = applyOptimisticSourceUpdate(update);
    if (!next) return;
    const requestId = latestSourceUpdate.current + 1;
    latestSourceUpdate.current = requestId;
    pendingSourceUpdates.current += 1;

    setSourceUpdatePending(true);
    setMessage({ type: 'success', text: successText });

    try {
      const res = await fetch('/api/data-source', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: next.active,
          ...(update.agents !== undefined ? { agents: next.agents } : {}),
        }),
      });
      if (!res.ok) throw new Error('Failed to update sources');
      const confirmed = await res.json() as Partial<DataSourceInfo>;
      const settled: DataSourceInfo = {
        ...next,
        ...confirmed,
        active: confirmed.active || next.active,
        agents: confirmed.agents || next.agents,
        detectedAgents: confirmed.detectedAgents || next.detectedAgents,
        hasImportedData: confirmed.hasImportedData ?? next.hasImportedData,
        importMeta: confirmed.importMeta === undefined ? next.importMeta : confirmed.importMeta,
      };
      if (requestId === latestSourceUpdate.current) {
        setOptimisticSourceInfo(settled);
        void mutateSource(settled, { revalidate: false });
        void mutate(() => true);
      }
    } catch {
      if (requestId === latestSourceUpdate.current) {
        setOptimisticSourceInfo(previous);
        if (previous) void mutateSource(previous, { revalidate: false });
        setMessage({ type: 'error', text: 'Failed to update data sources. Reverted to the previous selection.' });
      }
    } finally {
      pendingSourceUpdates.current = Math.max(0, pendingSourceUpdates.current - 1);
      if (pendingSourceUpdates.current === 0) setSourceUpdatePending(false);
      if (requestId === latestSourceUpdate.current) void mutateSource();
    }
  }, [applyOptimisticSourceUpdate, mutateSource, optimisticSourceInfo, sourceInfo]);

  const handleExport = useCallback(async (format: ExportFormat) => {
    setExporting(format);
    setMessage(null);
    try {
      const res = await fetch(format === 'standardized' ? '/api/export?format=standardized' : '/api/export');
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1]
        || `agent-data${format === 'standardized' ? '-standardized' : ''}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage({
        type: 'success',
        text: format === 'standardized'
          ? 'Standardized export downloaded successfully!'
          : 'Full export downloaded successfully!',
      });
    } catch {
      setMessage({ type: 'error', text: 'Failed to export data.' });
    } finally {
      setExporting(null);
    }
  }, []);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/import', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setMessage({
        type: 'success',
        text: `Imported ${data.meta.projectCount} projects, ${data.meta.sessionCount} sessions. Dashboard switched to imported data.`,
      });
      void mutateSource();
      // Revalidate all data
      void mutate(() => true);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to import data.' });
    } finally {
      setImporting(false);
      // Reset file input
      e.target.value = '';
    }
  }, [mutateSource]);

  const handleSwitchSource = useCallback(async (source: 'live' | 'imported') => {
    await commitSourceUpdate(
      { source },
      `Switched to ${source === 'live' ? 'live agent' : 'imported'} data. Updating views in the background.`,
    );
  }, [commitSourceUpdate]);

  const handleClearImport = useCallback(async () => {
    setMessage(null);
    try {
      const res = await fetch('/api/import', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear');
      void mutateSource();
      void mutate(() => true);
      setMessage({ type: 'success', text: 'Imported data cleared. Switched back to live data.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to clear imported data.' });
    }
  }, [mutateSource]);

  const handleSetAgents = useCallback(async (agents: AgentKind[]) => {
    await commitSourceUpdate(
      { agents },
      agents.length > 0
        ? `Selected ${agents.map(getAgentLabel).join(' + ')} data. Updating views in the background.`
        : 'No agent sources selected. Dashboard will show no sessions.',
    );
  }, [commitSourceUpdate]);

  const selectableAgents = AGENT_KINDS;
  const selectedAgents = displayedSourceInfo?.agents || [];
  const detectedAgents = displayedSourceInfo?.detectedAgents || [];
  const selectedAgentCount = selectedAgents.length;
  const selectedAgentNames = selectedAgents.map(getAgentLabel).join(' + ');
  const allDetectedSelected = detectedAgents.length > 0
    && detectedAgents.every(agent => selectedAgents.includes(agent))
    && selectedAgents.every(agent => detectedAgents.includes(agent));
  const hasSelectedAgents = selectedAgents.length > 0;

  const toggleAgent = useCallback((agent: AgentKind) => {
    const current = displayedSourceInfo?.agents || [];
    const nextSet = new Set(current);
    if (nextSet.has(agent)) {
      nextSet.delete(agent);
    } else {
      nextSet.add(agent);
    }
    handleSetAgents(AGENT_KINDS.filter(item => nextSet.has(item)));
  }, [displayedSourceInfo?.agents, handleSetAgents]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Data Management</h1>
        <p className="text-sm text-muted-foreground">Export, import, and manage your agent dashboard data</p>
      </div>

      {/* Status Message */}
      {message && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
          message.type === 'success'
            ? 'bg-green-50 text-green-700 border border-green-200'
            : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {/* Active Data Source */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4" />
              Active Data Source
            </CardTitle>
            <Badge variant={displayedSourceInfo?.active === 'live' ? 'default' : 'secondary'}>
              {displayedSourceInfo?.active === 'live' ? 'Live' : 'Imported'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => handleSwitchSource('live')}
              className={`flex items-center gap-3 rounded-lg border-2 p-4 transition-all ${
                displayedSourceInfo?.active === 'live'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <HardDrive className={`h-5 w-5 ${displayedSourceInfo?.active === 'live' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">Live Data</p>
                <p className="text-xs text-muted-foreground">Read from selected local agent directories</p>
              </div>
              {displayedSourceInfo?.active === 'live' && (
                <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
              )}
            </button>
            <button
              onClick={() => displayedSourceInfo?.hasImportedData && handleSwitchSource('imported')}
              disabled={!displayedSourceInfo?.hasImportedData}
              className={`flex items-center gap-3 rounded-lg border-2 p-4 transition-all ${
                displayedSourceInfo?.active === 'imported'
                  ? 'border-primary bg-primary/5'
                  : displayedSourceInfo?.hasImportedData
                    ? 'border-border hover:border-primary/50'
                    : 'border-border/50 opacity-50 cursor-not-allowed'
              }`}
            >
              <Cloud className={`h-5 w-5 ${displayedSourceInfo?.active === 'imported' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">Imported Data</p>
                <p className="text-xs text-muted-foreground">
                  {displayedSourceInfo?.hasImportedData ? 'View previously imported snapshot' : 'No imported data yet'}
                </p>
              </div>
              {displayedSourceInfo?.active === 'imported' && (
                <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
              )}
            </button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-semibold">Agent Sources</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Toggle each detected provider independently.</p>
            </div>
            <Badge variant={selectedAgentCount > 0 ? 'default' : 'secondary'}>
              {sourceUpdatePending
                ? 'Updating'
                : selectedAgentCount > 0
                  ? `${selectedAgentCount} selected`
                  : 'None selected'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={detectedAgents.length === 0 || allDetectedSelected}
              onClick={() => handleSetAgents(detectedAgents)}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Enable all detected
            </button>
            <button
              type="button"
              disabled={selectedAgentCount === 0}
              onClick={() => handleSetAgents([])}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Disable all
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {selectableAgents.map(agent => {
              const detected = detectedAgents.includes(agent);
              const selected = selectedAgents.includes(agent);
              const canToggle = detected || selected;
              return (
                <label
                  key={agent}
                  className={`flex min-h-24 items-center justify-between gap-3 rounded-lg border-2 p-3 text-left transition-all ${
                    selected
                      ? 'border-primary bg-primary/5'
                      : canToggle
                        ? 'border-border hover:border-primary/50'
                        : 'border-border/50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="space-y-1.5">
                    <AgentBadge agentKind={agent} />
                    <p className="text-xs text-muted-foreground">
                      {detected
                        ? `${getAgentLabel(agent)} data detected`
                        : selected
                          ? `${getAgentLabel(agent)} selected but not detected`
                          : `${getAgentLabel(agent)} not found`}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    aria-label={`Toggle ${getAgentLabel(agent)} data`}
                    checked={selected}
                    disabled={!canToggle}
                    onChange={() => toggleAgent(agent)}
                    className="h-4 w-4 shrink-0 accent-primary"
                  />
                </label>
              );
            })}
          </div>
          {selectedAgentCount === 0 ? (
            <div className="rounded-lg border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
              No agent sources are selected. Dashboard, session, project, and stats views will show empty results until at least one source is enabled.
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Reading {selectedAgentNames} data.
            </div>
          )}
          {sourceUpdatePending && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
              Source changes are saved. Dashboard views are updating in the background.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Export */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Download className="h-4 w-4" />
              Export Data
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Download a complete backup with raw provider files, or a smaller standardized archive
              that uses the same normalized schema for every selected provider.
            </p>
            {!hasSelectedAgents && (
              <p className="rounded-md bg-accent/50 px-3 py-2 text-xs text-muted-foreground">
                Select at least one agent source before exporting.
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-accent/50 p-3 space-y-1.5">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Full Export Includes</p>
                <div className="grid grid-cols-1 gap-1 text-xs">
                  <span>Raw provider session files</span>
                  <span>Stats cache</span>
                  <span>Prompt history</span>
                  <span>Plans & Todos</span>
                  <span>Settings</span>
                  <span>Standardized copy</span>
                </div>
              </div>
              <div className="rounded-lg bg-accent/50 p-3 space-y-1.5">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Standardized Only Includes</p>
                <div className="grid grid-cols-1 gap-1 text-xs">
                  <span>Projects JSON</span>
                  <span>Sessions JSON</span>
                  <span>Session details</span>
                  <span>Schema metadata</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                onClick={() => handleExport('full')}
                disabled={Boolean(exporting) || !hasSelectedAgents}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {exporting === 'full' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing full export...
                  </>
                ) : (
                  <>
                    <FileArchive className="h-4 w-4" />
                    Full export ZIP
                  </>
                )}
              </button>
              <button
                onClick={() => handleExport('standardized')}
                disabled={Boolean(exporting) || !hasSelectedAgents}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                {exporting === 'standardized' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing standardized export...
                  </>
                ) : (
                  <>
                    <FileArchive className="h-4 w-4" />
                    Standardized only ZIP
                  </>
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Import */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Import Data
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Upload a previously exported ZIP archive to view that data in the dashboard.
              The dashboard will switch to showing the imported data automatically.
            </p>

            {sourceInfo?.importMeta && (
              <div className="rounded-lg border border-border/50 p-3 space-y-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Current Import
                </p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">From</span>
                    <span className="font-medium">{sourceInfo.importMeta.exportedFrom}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Exported</span>
                    <span className="font-medium">
                      {new Date(sourceInfo.importMeta.exportedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Projects</span>
                    <span className="font-medium">{sourceInfo.importMeta.projectCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sessions</span>
                    <span className="font-medium">{sourceInfo.importMeta.sessionCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Size</span>
                    <span className="font-medium">{formatBytes(sourceInfo.importMeta.totalSize)}</span>
                  </div>
                </div>
                <Separator />
                <button
                  onClick={handleClearImport}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear Imported Data
                </button>
              </div>
            )}

            <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-accent/50">
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  {sourceInfo?.hasImportedData ? 'Replace with new ZIP' : 'Upload ZIP file'}
                </>
              )}
              <input
                type="file"
                accept=".zip"
                onChange={handleImport}
                disabled={importing}
                className="hidden"
              />
            </label>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
