import { describe, expect, it } from 'vitest';
import { getCodeLanguageLabel, guessCodeLanguage, tokenizeCode } from '@/lib/code-highlighting';

describe('code highlighting helpers', () => {
  it('guesses common languages from file extensions', () => {
    expect(guessCodeLanguage('src/main.cpp')).toBe('cpp');
    expect(guessCodeLanguage('include/parser.h')).toBe('c');
    expect(guessCodeLanguage('src/app.py')).toBe('python');
    expect(guessCodeLanguage('src/App.tsx')).toBe('typescript');
    expect(guessCodeLanguage('src/index.js')).toBe('javascript');
    expect(guessCodeLanguage('src/Program.cs')).toBe('csharp');
    expect(guessCodeLanguage('scripts/build.sh')).toBe('bash');
    expect(guessCodeLanguage('data/export.jsonl')).toBe('json');
  });

  it('returns friendly labels for supported languages', () => {
    expect(getCodeLanguageLabel('cpp')).toBe('C++');
    expect(getCodeLanguageLabel('csharp')).toBe('C#');
    expect(getCodeLanguageLabel('typescript')).toBe('TypeScript');
  });

  it('tokenizes common code constructs for supported languages', () => {
    const jsLine = tokenizeCode('function renderApp() { return true; }', 'javascript')[0];
    const pyLine = tokenizeCode('def build_app(): return True', 'python')[0];
    const csLine = tokenizeCode('public async Task RunAsync() => await ExecuteAsync();', 'csharp')[0];

    expect(jsLine).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'function', kind: 'keyword' }),
      expect.objectContaining({ text: 'renderApp', kind: 'function' }),
      expect.objectContaining({ text: 'return', kind: 'keyword' }),
    ]));

    expect(pyLine).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'def', kind: 'keyword' }),
      expect.objectContaining({ text: 'build_app', kind: 'function' }),
      expect.objectContaining({ text: 'True', kind: 'type' }),
    ]));

    expect(csLine).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'public', kind: 'keyword' }),
      expect.objectContaining({ text: 'async', kind: 'keyword' }),
      expect.objectContaining({ text: 'Task', kind: 'type' }),
      expect.objectContaining({ text: 'RunAsync', kind: 'function' }),
    ]));
  });
});