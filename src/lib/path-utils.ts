import { normalizeDisplayNewlines } from '@/lib/string-utils';

export function normalizeDisplayPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function formatDisplayPath(pathValue: string, projectRoot?: string): string {
  const normalizedRoot = projectRoot ? normalizeDisplayPath(projectRoot).replace(/\/$/, '') : undefined;
  return normalizeDisplayNewlines(pathValue)
    .split(/\r\n?|\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return trimmed;
      const normalizedLine = normalizeDisplayPath(trimmed);
      if (!normalizedRoot) return normalizedLine;
      if (normalizedLine.toLowerCase() === normalizedRoot.toLowerCase()) return '.';
      const prefix = `${normalizedRoot}/`;
      if (normalizedLine.toLowerCase().startsWith(prefix.toLowerCase())) {
        return normalizedLine.slice(prefix.length);
      }
      return normalizedLine;
    })
    .join('\n');
}

export function splitDisplayPath(pathValue: string): { prefix: string; basename: string } {
  const normalized = normalizeDisplayPath(pathValue);
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return { prefix: '', basename: normalized };
  }

  const basename = parts[parts.length - 1];
  const prefixParts = parts.slice(0, -1);
  if (normalized.length <= 42) {
    return { prefix: `${prefixParts.join('/')}/`, basename };
  }

  return { prefix: `${prefixParts[0]}.../`, basename };
}
