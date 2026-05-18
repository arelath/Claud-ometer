import type { CostMode } from '@/config/pricing';
import type { AgentKind } from '@/lib/agent-data/types';

/** Cost estimates in all three modes */
export type CostEstimates = Record<CostMode, number>;

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
  /** Pre-computed daily cost per model in each cost mode */
  costsByModel?: Record<string, CostEstimates>;
}

export interface ChangeTotals {
  addedLines: number;
  removedLines: number;
  netLineDelta: number;
  changedLines: number;
  fileCount: number;
  editCount: number;
}

export interface DailyChangeActivity extends ChangeTotals {
  date: string;
  sessionCount: number;
}

export type BucketGranularity = 'day' | '4h' | 'hour';

export interface AnalyticsTimeBucket {
  key: string;
  startLocal: string;
  granularity: BucketGranularity;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  sessionStartCount: number;
  activeSessionCount: number;
  tokensByModel: Record<string, number>;
  costsByModel: Record<string, CostEstimates>;
  changeTotals: ChangeTotals;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens?: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  webSearchRequests: number;
}

export interface LongestSession {
  sessionId: string;
  duration: number;
  messageCount: number;
  timestamp: string;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, ModelUsage>;
  totalSessions: number;
  totalMessages: number;
  longestSession: LongestSession;
  firstSessionDate: string;
  hourCounts: Record<string, number>;
  totalSpeculationTimeSavedMs: number;
}

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, unknown>;
  timestamp: number;
  project: string;
}

export interface CompactMetadata {
  trigger: string;
  preTokens: number;
}

export interface MicrocompactMetadata {
  trigger: string;
  preTokens: number;
  tokensSaved: number;
  compactedToolIds: string[];
  clearedAttachmentUUIDs: string[];
}

export interface SessionMessage {
  type: string;
  sessionId: string;
  timestamp: string;
  uuid?: string;
  parentUuid?: string | null;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isMeta?: boolean;
  subtype?: string;
  permissionMode?: string;
  messageId?: string;
  isSnapshotUpdate?: boolean;
  sourceToolAssistantUUID?: string;
  compactMetadata?: CompactMetadata;
  microcompactMetadata?: MicrocompactMetadata;
  isCompactSummary?: boolean;
  attachment?: Record<string, unknown>;
  toolUseResult?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  content?: string;
  lastPrompt?: string;
  leafUuid?: string;
  message?: {
    id?: string;
    role: string;
    model?: string;
    content: unknown;
    usage?: TokenUsage;
    stop_reason?: string | null;
  };
  data?: {
    type: string;
    elapsedTimeMs?: number;
    toolName?: string;
    serverName?: string;
    statusMessage?: string;
  };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
}

export interface ProjectInfo {
  id: string;
  agentKind?: AgentKind;
  nativeId?: string;
  routeId?: string;
  name: string;
  path: string;
  sessionCount: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCost: number;
  estimatedCosts: CostEstimates;
  lastActive: string;
  models: string[];
}

export interface CompactionInfo {
  compactions: number;
  microcompactions: number;
  totalTokensSaved: number;
  compactionTimestamps: string[];
}

export interface SessionInfo {
  id: string;
  agentKind?: AgentKind;
  nativeId?: string;
  routeId?: string;
  projectId: string;
  nativeProjectId?: string;
  projectRouteId?: string;
  projectName: string;
  title?: string;
  sourceFilePath?: string;
  sourceFilePaths?: string[];
  timestamp: string;
  duration: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedCost: number;
  estimatedCosts: CostEstimates;
  model: string;
  models: string[];
  gitBranch: string;
  cwd: string;
  version: string;
  toolsUsed: Record<string, number>;
  compaction: CompactionInfo;
}

export type LiveSessionStatus = 'busy' | 'idle' | 'unknown';

export interface LiveSessionInfo {
  id: string;
  agentKind?: AgentKind;
  nativeId?: string;
  routeId?: string;
  sessionId: string;
  metadataFilePath: string;
  transcriptFilePath?: string;
  pid?: number;
  cwd: string;
  projectName: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  startedAt: string;
  lastActivityAt: string;
  updatedAtMs: number;
  cacheLastActivityAt?: string;
  cacheLastActivityAtMs?: number;
  cacheExpiresAt?: string;
  cacheExpiresAtMs?: number;
  cachePaused?: boolean;
  status: LiveSessionStatus;
  rawStatus?: string;
  statusReason: string;
  busySinceAt?: string;
  busySinceAtMs?: number;
  messageCount: number;
  toolCallCount: number;
  lastPreview: string;
  activeToolName?: string;
  revision: string;
  transcriptRevision?: string;
}

export interface SessionPromptTokenBreakdown {
  totalTokens: number;
  systemTokens: number;
  conversationTokens: number;
  filesTokens: number;
  cacheReadTokens?: number;
  thinkingTokens: number;
  toolTokens: number;
  otherTokens: number;
}

export interface SessionDetail extends SessionInfo {
  messages: SessionMessageDisplay[];
  isLive?: boolean;
  liveStatus?: LiveSessionStatus;
  liveStatusReason?: string;
  liveBusySinceAt?: string;
  liveBusySinceAtMs?: number;
  liveActiveToolName?: string;
  liveCachePaused?: boolean;
  liveMetadataRevision?: string;
  liveTranscriptRevision?: string;
  liveMetadataFilePath?: string;
  liveTranscriptFilePath?: string;
}

export interface SessionToolCallDetail {
  key: string;
  label: string;
  value: string;
}

export interface SessionArtifactDisplay {
  kind: 'text' | 'diff';
  title: string;
  content?: string;
  oldText?: string;
  newText?: string;
  location?: string;
  includeWhenEmpty?: boolean;
  edits?: {
    path?: string;
    oldText: string;
    newText: string;
    location?: string;
    includeWhenEmpty?: boolean;
  }[];
}

export interface SessionToolCallDisplay {
  name: string;
  id: string;
  summary: string;
  details: SessionToolCallDetail[];
  artifact?: SessionArtifactDisplay;
}

export interface SessionMessageBlockDisplay {
  type: 'thinking' | 'tool-result' | 'event';
  title: string;
  summary: string;
  details: SessionToolCallDetail[];
  content?: string;
}

export interface SessionMessageDisplay {
  role: 'user' | 'assistant' | 'system' | 'tool-use' | 'tool-result' | 'command';
  content: string;
  timestamp: string;
  messageId?: string;
  model?: string;
  usage?: TokenUsage;
  estimatedCosts?: CostEstimates;
  promptBreakdown?: SessionPromptTokenBreakdown;
  stopReason?: string | null;
  toolCalls?: SessionToolCallDisplay[];
  blocks?: SessionMessageBlockDisplay[];
  isMeta?: boolean;
}

export interface DashboardStats {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCost: number;
  estimatedCosts: CostEstimates;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  changeTotals: ChangeTotals;
  dailyChangeActivity: DailyChangeActivity[];
  timeZone?: string;
  bucketGranularity?: BucketGranularity;
  usageBuckets?: AnalyticsTimeBucket[];
  modelUsage: Record<string, ModelUsage & { estimatedCost: number; estimatedCosts: CostEstimates }>;
  hourCounts: Record<string, number>;
  firstSessionDate: string;
  longestSession: LongestSession;
  projectCount: number;
  recentSessions: SessionInfo[];
}
