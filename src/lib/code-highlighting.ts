export type CodeLanguage =
  | 'bash'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'powershell'
  | 'python'
  | 'rust'
  | 'sql'
  | 'typescript'
  | 'xml'
  | 'yaml';

export type HighlightTokenKind =
  | 'comment'
  | 'function'
  | 'keyword'
  | 'number'
  | 'operator'
  | 'plain'
  | 'string'
  | 'type';

export interface HighlightToken {
  text: string;
  kind: HighlightTokenKind;
}

interface LanguageConfig {
  blockComment?: { start: string; end: string };
  builtins: Set<string>;
  caseInsensitive?: boolean;
  keywords: Set<string>;
  lineComments: string[];
}

interface ParserState {
  blockCommentEnd?: string;
}

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  powershell: 'PowerShell',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

const FILE_EXTENSION_LANGUAGE_MAP: Record<string, CodeLanguage> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  hxx: 'cpp',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonl: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'markdown',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

function createWordSet(words: string[]): Set<string> {
  return new Set(words);
}

const LANGUAGE_CONFIGS: Record<CodeLanguage, LanguageConfig> = {
  bash: {
    keywords: createWordSet(['case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'local', 'select', 'then', 'until', 'while']),
    builtins: createWordSet(['echo', 'export', 'printf', 'pwd', 'read', 'set', 'shift', 'source', 'test', 'trap', 'unset']),
    lineComments: ['#'],
  },
  c: {
    keywords: createWordSet(['auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while']),
    builtins: createWordSet(['bool', 'char', 'double', 'false', 'float', 'int', 'long', 'NULL', 'short', 'signed', 'size_t', 'true', 'unsigned', 'void']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  cpp: {
    keywords: createWordSet(['alignas', 'alignof', 'auto', 'break', 'case', 'catch', 'class', 'const', 'consteval', 'constexpr', 'constinit', 'continue', 'co_await', 'co_return', 'co_yield', 'default', 'delete', 'do', 'else', 'enum', 'explicit', 'export', 'final', 'for', 'friend', 'if', 'mutable', 'namespace', 'new', 'noexcept', 'operator', 'override', 'private', 'protected', 'public', 'return', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'try', 'typedef', 'typename', 'union', 'using', 'virtual', 'while']),
    builtins: createWordSet(['bool', 'char', 'double', 'false', 'float', 'int', 'long', 'nullptr', 'short', 'signed', 'size_t', 'std', 'string', 'true', 'unsigned', 'void']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  csharp: {
    keywords: createWordSet(['abstract', 'as', 'async', 'await', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue', 'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'extern', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'interface', 'internal', 'is', 'lock', 'namespace', 'new', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'record', 'ref', 'return', 'sealed', 'stackalloc', 'static', 'struct', 'switch', 'throw', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual', 'volatile', 'while', 'yield']),
    builtins: createWordSet(['bool', 'byte', 'char', 'decimal', 'double', 'dynamic', 'false', 'float', 'Guid', 'int', 'List', 'long', 'null', 'object', 'string', 'Task', 'true', 'var', 'void']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  css: {
    keywords: createWordSet(['@import', '@keyframes', '@layer', '@media', '@supports', 'from', 'to']),
    builtins: createWordSet(['auto', 'block', 'flex', 'grid', 'important', 'inherit', 'none', 'relative']),
    lineComments: [],
    blockComment: { start: '/*', end: '*/' },
  },
  go: {
    keywords: createWordSet(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),
    builtins: createWordSet(['any', 'bool', 'byte', 'error', 'false', 'float32', 'float64', 'int', 'int32', 'int64', 'nil', 'rune', 'string', 'true', 'uint', 'uint32', 'uint64']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  html: {
    keywords: createWordSet(['DOCTYPE']),
    builtins: createWordSet([]),
    lineComments: [],
    blockComment: { start: '<!--', end: '-->' },
  },
  java: {
    keywords: createWordSet(['abstract', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for', 'if', 'implements', 'import', 'instanceof', 'interface', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'volatile', 'while']),
    builtins: createWordSet(['boolean', 'double', 'false', 'float', 'int', 'Integer', 'List', 'long', 'Map', 'null', 'Object', 'String', 'true', 'void']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  javascript: {
    keywords: createWordSet(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'while', 'yield']),
    builtins: createWordSet(['Array', 'Boolean', 'Date', 'false', 'Map', 'null', 'Number', 'Object', 'Promise', 'Set', 'String', 'true', 'undefined']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  json: {
    keywords: createWordSet([]),
    builtins: createWordSet(['false', 'null', 'true']),
    lineComments: [],
  },
  markdown: {
    keywords: createWordSet(['###', '##', '#']),
    builtins: createWordSet([]),
    lineComments: [],
  },
  powershell: {
    keywords: createWordSet(['begin', 'break', 'catch', 'class', 'continue', 'data', 'do', 'else', 'elseif', 'end', 'enum', 'exit', 'filter', 'finally', 'for', 'foreach', 'from', 'function', 'if', 'in', 'param', 'process', 'return', 'switch', 'throw', 'trap', 'try', 'until', 'using', 'while']),
    builtins: createWordSet(['$false', '$null', '$true', 'Get-ChildItem', 'Get-Content', 'Select-Object', 'Test-Path', 'Where-Object', 'Write-Host']),
    caseInsensitive: true,
    lineComments: ['#'],
  },
  python: {
    keywords: createWordSet(['and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']),
    builtins: createWordSet(['False', 'None', 'True', 'bool', 'dict', 'float', 'int', 'list', 'set', 'str', 'tuple']),
    lineComments: ['#'],
  },
  rust: {
    keywords: createWordSet(['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'fn', 'for', 'if', 'impl', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'trait', 'type', 'unsafe', 'use', 'where', 'while']),
    builtins: createWordSet(['bool', 'false', 'i32', 'i64', 'None', 'Option', 'Result', 'Self', 'Some', 'String', 'true', 'u32', 'u64', 'usize']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  sql: {
    keywords: createWordSet(['alter', 'and', 'as', 'by', 'case', 'create', 'delete', 'desc', 'drop', 'else', 'end', 'from', 'group', 'having', 'insert', 'into', 'join', 'left', 'limit', 'not', 'null', 'on', 'or', 'order', 'right', 'select', 'set', 'table', 'then', 'union', 'update', 'values', 'when', 'where']),
    builtins: createWordSet(['count', 'false', 'null', 'true']),
    caseInsensitive: true,
    lineComments: ['--'],
    blockComment: { start: '/*', end: '*/' },
  },
  typescript: {
    keywords: createWordSet(['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'keyof', 'let', 'namespace', 'new', 'readonly', 'return', 'satisfies', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'while', 'yield']),
    builtins: createWordSet(['Array', 'false', 'Map', 'null', 'Promise', 'Record', 'Set', 'string', 'true', 'undefined']),
    lineComments: ['//'],
    blockComment: { start: '/*', end: '*/' },
  },
  xml: {
    keywords: createWordSet([]),
    builtins: createWordSet([]),
    lineComments: [],
    blockComment: { start: '<!--', end: '-->' },
  },
  yaml: {
    keywords: createWordSet(['anchors', 'false', 'null', 'true']),
    builtins: createWordSet([]),
    lineComments: ['#'],
  },
};

function pushToken(tokens: HighlightToken[], next: HighlightToken): void {
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === next.kind) {
    previous.text += next.text;
    return;
  }
  tokens.push(next);
}

function getExtension(source: string): string | undefined {
  const normalized = source.trim().toLowerCase().split(/[?#]/)[0];
  const fileName = normalized.replace(/^.*[\\/]/, '');

  if (!fileName) return undefined;
  if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) return 'ts';

  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) return undefined;
  return fileName.slice(lastDotIndex + 1);
}

function getLookupValue(value: string, config: LanguageConfig): string {
  return config.caseInsensitive ? value.toLowerCase() : value;
}

function peekNextNonWhitespace(line: string, startIndex: number): string | undefined {
  for (let index = startIndex; index < line.length; index += 1) {
    if (!/\s/.test(line[index])) return line[index];
  }
  return undefined;
}

function consumeEscapedString(line: string, startIndex: number, quote: string): { value: string; nextIndex: number } {
  let index = startIndex + quote.length;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line.startsWith(quote, index)) {
      index += quote.length;
      return { value: line.slice(startIndex, index), nextIndex: index };
    }
    index += 1;
  }

  return { value: line.slice(startIndex), nextIndex: line.length };
}

function consumeVerbatimCSharpString(line: string, startIndex: number, prefix: string): { value: string; nextIndex: number } {
  let index = startIndex + prefix.length;
  while (index < line.length) {
    if (line[index] !== '"') {
      index += 1;
      continue;
    }
    if (line[index + 1] === '"') {
      index += 2;
      continue;
    }
    index += 1;
    return { value: line.slice(startIndex, index), nextIndex: index };
  }

  return { value: line.slice(startIndex), nextIndex: line.length };
}

function isLikelyTypeName(language: CodeLanguage, word: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(word)) return false;
  return language !== 'bash' && language !== 'markdown' && language !== 'yaml';
}

function tokenizeLine(line: string, language: CodeLanguage, state: ParserState): HighlightToken[] {
  const config = LANGUAGE_CONFIGS[language];
  const tokens: HighlightToken[] = [];
  let index = 0;

  const flushBlockComment = () => {
    const endDelimiter = state.blockCommentEnd;
    if (!endDelimiter) return false;

    const endIndex = line.indexOf(endDelimiter, index);
    if (endIndex === -1) {
      pushToken(tokens, { text: line.slice(index), kind: 'comment' });
      index = line.length;
      return true;
    }

    const nextIndex = endIndex + endDelimiter.length;
    pushToken(tokens, { text: line.slice(index, nextIndex), kind: 'comment' });
    state.blockCommentEnd = undefined;
    index = nextIndex;
    return false;
  };

  if (flushBlockComment()) return tokens;

  while (index < line.length) {
    if (flushBlockComment()) break;

    const remaining = line.slice(index);

    if ((language === 'c' || language === 'cpp') && /^\s*#\w+/.test(remaining)) {
      const match = remaining.match(/^\s*#\w+/)?.[0] || remaining;
      pushToken(tokens, { text: match, kind: 'keyword' });
      index += match.length;
      continue;
    }

    const lineComment = config.lineComments.find(marker => marker && remaining.startsWith(marker));
    if (lineComment) {
      pushToken(tokens, { text: remaining, kind: 'comment' });
      break;
    }

    if (config.blockComment && remaining.startsWith(config.blockComment.start)) {
      const commentEndIndex = line.indexOf(config.blockComment.end, index + config.blockComment.start.length);
      if (commentEndIndex === -1) {
        pushToken(tokens, { text: remaining, kind: 'comment' });
        state.blockCommentEnd = config.blockComment.end;
        break;
      }

      const nextIndex = commentEndIndex + config.blockComment.end.length;
      pushToken(tokens, { text: line.slice(index, nextIndex), kind: 'comment' });
      index = nextIndex;
      continue;
    }

    if (language === 'python' && (remaining.startsWith("'''") || remaining.startsWith('"""'))) {
      const delimiter = remaining.slice(0, 3);
      const endIndex = line.indexOf(delimiter, index + 3);
      const nextIndex = endIndex === -1 ? line.length : endIndex + 3;
      pushToken(tokens, { text: line.slice(index, nextIndex), kind: 'string' });
      index = nextIndex;
      continue;
    }

    if (language === 'csharp' && (remaining.startsWith('@"') || remaining.startsWith('$@"') || remaining.startsWith('@$"'))) {
      const prefix = remaining.startsWith('@"') ? '@"' : remaining.startsWith('$@"') ? '$@"' : '@$"';
      const { value, nextIndex } = consumeVerbatimCSharpString(line, index, prefix);
      pushToken(tokens, { text: value, kind: 'string' });
      index = nextIndex;
      continue;
    }

    const stringPrefix = remaining[0];
    if (stringPrefix === '"' || stringPrefix === '\'' || stringPrefix === '`') {
      const { value, nextIndex } = consumeEscapedString(line, index, stringPrefix);
      pushToken(tokens, { text: value, kind: 'string' });
      index = nextIndex;
      continue;
    }

    const whitespace = remaining.match(/^\s+/)?.[0];
    if (whitespace) {
      pushToken(tokens, { text: whitespace, kind: 'plain' });
      index += whitespace.length;
      continue;
    }

    const numberMatch = remaining.match(/^(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (numberMatch) {
      pushToken(tokens, { text: numberMatch, kind: 'number' });
      index += numberMatch.length;
      continue;
    }

    const identifier = remaining.match(/^[$@A-Za-z_][\w$-]*/)?.[0];
    if (identifier) {
      const lookupValue = getLookupValue(identifier, config);
      const nextCharacter = peekNextNonWhitespace(line, index + identifier.length);

      let kind: HighlightTokenKind = 'plain';
      if (config.keywords.has(lookupValue)) {
        kind = 'keyword';
      } else if (config.builtins.has(lookupValue) || isLikelyTypeName(language, identifier)) {
        kind = 'type';
      } else if (nextCharacter === '(') {
        kind = 'function';
      }

      pushToken(tokens, { text: identifier, kind });
      index += identifier.length;
      continue;
    }

    const operator = remaining.match(/^(=>|==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||\?\?|\?\.|::|->|:=|[=+\-*/%<>!&|^~?:]+)/)?.[0];
    if (operator) {
      pushToken(tokens, { text: operator, kind: 'operator' });
      index += operator.length;
      continue;
    }

    pushToken(tokens, { text: line[index], kind: 'plain' });
    index += 1;
  }

  return tokens;
}

export function guessCodeLanguage(source?: string): CodeLanguage | undefined {
  if (!source) return undefined;

  const normalized = source.trim();
  if (!normalized) return undefined;

  const lowerValue = normalized.toLowerCase();
  if (lowerValue.endsWith('dockerfile')) return 'bash';

  const extension = getExtension(normalized);
  if (!extension) return undefined;

  return FILE_EXTENSION_LANGUAGE_MAP[extension];
}

export function getCodeLanguageLabel(language: CodeLanguage): string {
  return LANGUAGE_LABELS[language];
}

export function tokenizeCode(content: string, language?: CodeLanguage): HighlightToken[][] {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  if (!language) {
    return lines.map(line => [{ text: line, kind: 'plain' }]);
  }

  const state: ParserState = {};
  return lines.map(line => tokenizeLine(line, language, state));
}