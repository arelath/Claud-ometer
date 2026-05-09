import type { AgentDataProvider } from '@/lib/agent-data/provider';
import * as reader from './reader';

export const codexProvider: AgentDataProvider = {
  kind: 'codex',
  canResume: false,
  getProjects: reader.getProjects,
  getSessions: reader.getSessions,
  getProjectSessions: reader.getProjectSessions,
  getSessionDetail: reader.getSessionDetail,
  searchSessions: reader.searchSessions,
  getDashboardStats: reader.getDashboardStats,
};
