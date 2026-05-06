export function getDetailKeyTail(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1] || key;
}

export function detailMatchesKey(key: string, candidates: string[]): boolean {
  const keyTail = getDetailKeyTail(key);
  return candidates.includes(key) || candidates.includes(keyTail);
}

export function normalizeDisplayNewlines(value: string): string {
  if (!value) return value;
  if (/\r\n?|\n/.test(value)) return value;
  return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

export function parseLineNumber(value: string | undefined): number | null {
  if (!value) return null;
  const direct = value.trim().replace(/,/g, '').match(/^\d+$/);
  if (direct) return Number.parseInt(direct[0], 10);

  const labeled = value.match(/\bline\s+(\d+)\b/i) || value.match(/^\D*(\d+)/);
  return labeled ? Number.parseInt(labeled[1], 10) : null;
}
