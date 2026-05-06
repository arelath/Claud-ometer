import { describe, expect, it } from 'vitest';
import { formatDisplayPath, normalizeDisplayPath, splitDisplayPath } from '@/lib/path-utils';
import { detailMatchesKey, getDetailKeyTail, normalizeDisplayNewlines, parseLineNumber } from '@/lib/string-utils';

describe('path utilities', () => {
  it('normalizes Windows separators and duplicate slashes', () => {
    expect(normalizeDisplayPath('C:\\Users\\Ada\\project//src\\app.ts')).toBe('C:/Users/Ada/project/src/app.ts');
  });

  it('formats paths relative to a project root across multiple lines', () => {
    const formatted = formatDisplayPath(
      'C:\\Repo\\App\\src\\index.ts\nC:/Repo/App/package.json\nD:/other/file.ts',
      'c:/repo/app',
    );

    expect(formatted).toBe('src/index.ts\npackage.json\nD:/other/file.ts');
  });

  it('uses dot for exact project root matches', () => {
    expect(formatDisplayPath('C:/Repo/App', 'c:/repo/app/')).toBe('.');
  });

  it('splits long paths into a compact prefix and basename', () => {
    expect(splitDisplayPath('src/lib/file.ts')).toEqual({ prefix: 'src/lib/', basename: 'file.ts' });
    expect(splitDisplayPath('C:/very/long/project/path/with/many/segments/session.jsonl')).toEqual({
      prefix: 'C:.../',
      basename: 'session.jsonl',
    });
  });
});

describe('string utilities', () => {
  it('matches detail keys by full path or tail', () => {
    expect(getDetailKeyTail('content.file.filePath')).toBe('filePath');
    expect(detailMatchesKey('content.file.filePath', ['filePath'])).toBe(true);
    expect(detailMatchesKey('content.file.filePath', ['content.file.filePath'])).toBe(true);
    expect(detailMatchesKey('content.file.filePath', ['path'])).toBe(false);
  });

  it('normalizes escaped newline sequences without touching real newlines', () => {
    expect(normalizeDisplayNewlines('one\\ntwo\\r\\nthree')).toBe('one\ntwo\nthree');
    expect(normalizeDisplayNewlines('one\ntwo\\nthree')).toBe('one\ntwo\\nthree');
  });

  it('parses direct, comma-formatted, and labeled line numbers', () => {
    expect(parseLineNumber('1,234')).toBe(1234);
    expect(parseLineNumber('line 42')).toBe(42);
    expect(parseLineNumber('L17: match')).toBe(17);
    expect(parseLineNumber('no line here')).toBeNull();
    expect(parseLineNumber(undefined)).toBeNull();
  });
});
