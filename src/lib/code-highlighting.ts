import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-xml-doc';
import 'prismjs/components/prism-yaml';

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

const PRISM_LANGUAGE_MAP: Record<CodeLanguage, string> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  css: 'css',
  go: 'go',
  html: 'markup',
  java: 'java',
  javascript: 'javascript',
  json: 'json',
  markdown: 'markdown',
  powershell: 'powershell',
  python: 'python',
  rust: 'rust',
  sql: 'sql',
  typescript: 'typescript',
  xml: 'markup',
  yaml: 'yaml',
};

function getExtension(source: string): string | undefined {
  const normalized = source.trim().toLowerCase().split(/[?#]/)[0];
  const fileName = normalized.replace(/^.*[\\/]/, '');

  if (!fileName) return undefined;
  if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) return 'ts';

  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) return undefined;
  return fileName.slice(lastDotIndex + 1);
}

function mapPrismKind(tokenType: string): HighlightTokenKind {
  if (tokenType.includes('comment')) return 'comment';
  if (tokenType.includes('function') || tokenType.includes('method')) return 'function';
  if (tokenType.includes('keyword') || tokenType.includes('atrule') || tokenType.includes('tag')) return 'keyword';
  if (tokenType.includes('number')) return 'number';
  if (tokenType.includes('operator') || tokenType.includes('punctuation')) return 'operator';
  if (tokenType.includes('string') || tokenType.includes('char') || tokenType.includes('regex')) return 'string';
  if (
    tokenType.includes('builtin')
    || tokenType.includes('boolean')
    || tokenType.includes('class-name')
    || tokenType.includes('constant')
    || tokenType.includes('namespace')
  ) {
    return 'type';
  }
  return 'plain';
}

function pushToken(tokens: HighlightToken[], next: HighlightToken): void {
  if (!next.text) return;
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === next.kind) {
    previous.text += next.text;
    return;
  }
  tokens.push(next);
}

function flattenPrismTokens(value: string | Prism.Token | Array<string | Prism.Token>, inheritedKind: HighlightTokenKind = 'plain'): HighlightToken[] {
  if (typeof value === 'string') return [{ text: value, kind: inheritedKind }];
  if (Array.isArray(value)) return value.flatMap(child => flattenPrismTokens(child, inheritedKind));

  const tokenKind = mapPrismKind(value.type);
  return flattenPrismTokens(value.content, tokenKind);
}

function splitTokensByLine(tokens: HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];

  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) pushToken(lines[lines.length - 1], { text: part, kind: token.kind });
    });
  }

  return lines;
}

function promoteLikelyFunctions(tokens: HighlightToken[]): HighlightToken[] {
  return tokens.map((token, index) => {
    if (token.kind !== 'plain' || !/^[A-Za-z_$][\w$-]*$/.test(token.text)) return token;

    const nextToken = tokens.slice(index + 1).find(next => next.text.trim());
    if (nextToken?.text === '(') return { ...token, kind: 'function' };

    return token;
  });
}

function splitLikelyTypeNames(tokens: HighlightToken[]): HighlightToken[] {
  const refined: HighlightToken[] = [];

  for (const token of tokens) {
    if (token.kind !== 'plain') {
      pushToken(refined, token);
      continue;
    }

    const parts = token.text.split(/(\b[A-Z][A-Za-z0-9_]*\b)/);
    for (const part of parts) {
      if (!part) continue;
      pushToken(refined, {
        text: part,
        kind: /^[A-Z][A-Za-z0-9_]*$/.test(part) ? 'type' : 'plain',
      });
    }
  }

  return refined;
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
  if (!language) return normalized.split('\n').map(line => [{ text: line, kind: 'plain' }]);

  const prismLanguage = PRISM_LANGUAGE_MAP[language];
  const grammar = Prism.languages[prismLanguage];
  if (!grammar) return normalized.split('\n').map(line => [{ text: line, kind: 'plain' }]);

  const tokens = flattenPrismTokens(Prism.tokenize(normalized, grammar));
  return splitTokensByLine(tokens).map(lineTokens => promoteLikelyFunctions(splitLikelyTypeNames(lineTokens)));
}
