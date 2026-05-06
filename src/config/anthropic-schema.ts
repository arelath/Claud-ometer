export const ANTHROPIC_TOOL_NAMES = {
  bash: 'Bash',
  edit: 'Edit',
  grep: 'Grep',
  read: 'Read',
  toolSearch: 'ToolSearch',
  write: 'Write',
} as const;

export const ANTHROPIC_FILE_DETAIL_KEYS = [
  'file_path',
  'filePath',
  'path',
  'displayPath',
  'filename',
  'content.file.filePath',
] as const;

export const ANTHROPIC_START_LINE_DETAIL_KEYS = [
  'startLine',
  'start_line',
  'lineStart',
  'line_start',
  'offset',
] as const;

export const ANTHROPIC_END_LINE_DETAIL_KEYS = [
  'endLine',
  'end_line',
  'lineEnd',
  'line_end',
] as const;

export const ANTHROPIC_CODE_PATH_DETAIL_KEYS = [
  'originalFile',
  'content.file.filePath',
  'displayPath',
  'filePath',
  'file_path',
  'filename',
  'path',
] as const;

export const ANTHROPIC_MONOSPACE_DETAIL_KEYS = [
  'args',
  'command',
  'displayPath',
  'file_path',
  'filePath',
  'filename',
  'includePattern',
  'leafUuid',
  'lineContent',
  'messageId',
  'path',
  'paths',
  'query',
  'scope',
  'selector',
  'signature',
  'sourceToolAssistantUUID',
  'symbol',
  'tool_use_id',
  'toolUseId',
  'url',
  'uuid',
] as const;

export const ANTHROPIC_TOOL_DETAIL_PRIORITY: Record<string, string[]> = {
  [ANTHROPIC_TOOL_NAMES.bash]: ['command', 'goal', 'mode', 'timeout'],
  [ANTHROPIC_TOOL_NAMES.edit]: ['file_path', 'replace_all', 'old_string', 'new_string'],
  [ANTHROPIC_TOOL_NAMES.read]: ['file_path', 'startLine', 'endLine'],
  [ANTHROPIC_TOOL_NAMES.toolSearch]: ['query', 'max_results'],
  [ANTHROPIC_TOOL_NAMES.write]: ['file_path', 'content'],
};

export const ANTHROPIC_COMMON_TOOL_DETAIL_KEYS = [
  'file_path',
  'filePath',
  'path',
  'paths',
  'command',
  'query',
  'goal',
  'mode',
  'url',
  'selector',
  'symbol',
  'newName',
  'scope',
  'includePattern',
  'lineContent',
  'args',
  'startLine',
  'endLine',
  'replace_all',
  'max_results',
  'maxResults',
] as const;
