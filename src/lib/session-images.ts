import type { SessionMessageImageDisplay } from '@/lib/claude-data/types';

const DATA_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const DATA_IMAGE_CAPTURE_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_CHARS_RE = /^[a-z0-9+/=\s]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isImageMediaType(value: string | undefined): value is string {
  return Boolean(value && /^image\/[a-z0-9.+-]+$/i.test(value));
}

export function getDataImageMediaType(url: string): string | null {
  const match = DATA_IMAGE_RE.exec(url.trim());
  return match?.[1].toLowerCase() || null;
}

export function getImageMediaTypeFromBase64(data: string, mediaTypeHint?: string): string | null {
  const compact = data.replace(/\s+/g, '');
  if (compact.length < 64 || !BASE64_CHARS_RE.test(compact)) return null;
  if (isImageMediaType(mediaTypeHint)) return mediaTypeHint.toLowerCase();
  if (compact.startsWith('iVBORw0KGgo')) return 'image/png';
  if (compact.startsWith('/9j/')) return 'image/jpeg';
  if (compact.startsWith('R0lGOD')) return 'image/gif';
  if (compact.startsWith('UklGR')) return 'image/webp';
  if (compact.startsWith('PHN2Zy') || compact.startsWith('PD94bWwg')) return 'image/svg+xml';
  return null;
}

export function imageFromDataUrl(url: string, label?: string): SessionMessageImageDisplay | null {
  const mediaType = getDataImageMediaType(url);
  if (!mediaType) return null;
  return { url: url.trim(), mediaType, label };
}

export function imageFromBase64(data: string, mediaTypeHint?: string, label?: string): SessionMessageImageDisplay | null {
  const mediaType = getImageMediaTypeFromBase64(data, mediaTypeHint);
  if (!mediaType) return null;
  const compact = data.replace(/\s+/g, '');
  return {
    url: `data:${mediaType};base64,${compact}`,
    mediaType,
    label,
  };
}

function imageFromUrlOrBase64(value: string, mediaTypeHint?: string, label?: string): SessionMessageImageDisplay | null {
  const dataUrl = imageFromDataUrl(value, label);
  if (dataUrl) return dataUrl;
  return imageFromBase64(value, mediaTypeHint, label);
}

export function dedupeImages(images: SessionMessageImageDisplay[]): SessionMessageImageDisplay[] {
  const seen = new Set<string>();
  const result: SessionMessageImageDisplay[] = [];
  for (const image of images) {
    if (!image.url || seen.has(image.url)) continue;
    seen.add(image.url);
    result.push(image);
  }
  return result;
}

function nextLabel(prefix: string, count: number, explicit?: string): string {
  return explicit?.trim() || `${prefix} ${count + 1}`;
}

export function extractClaudeImages(value: unknown, labelPrefix = 'Image'): SessionMessageImageDisplay[] {
  const images: SessionMessageImageDisplay[] = [];

  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    if (!isRecord(item)) return;

    if (item.type === 'image') {
      const source = isRecord(item.source) ? item.source : null;
      const label = nextLabel(labelPrefix, images.length);
      if (source?.type === 'base64') {
        const mediaType = getString(source, 'media_type') || getString(source, 'mediaType');
        const data = getString(source, 'data');
        const image = data ? imageFromBase64(data, mediaType, label) : null;
        if (image) images.push(image);
      } else if (source?.type === 'url') {
        const url = getString(source, 'url');
        const image = url ? imageFromDataUrl(url, label) : null;
        if (image) images.push(image);
      }
    }

    for (const child of Object.values(item)) visit(child);
  };

  visit(value);
  return dedupeImages(images);
}

export function extractCopilotImages(value: unknown, labelPrefix = 'Image'): SessionMessageImageDisplay[] {
  const images: SessionMessageImageDisplay[] = [];

  const add = (image: SessionMessageImageDisplay | null) => {
    if (image) images.push(image);
  };

  const visit = (item: unknown, inheritedLabel?: string) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, inheritedLabel);
      return;
    }

    if (!isRecord(item)) return;

    const explicitLabel = getString(item, 'name')
      || getString(item, 'fullName')
      || getString(item, 'fileName')
      || getString(item, 'filePath')
      || inheritedLabel;
    const label = nextLabel(labelPrefix, images.length, explicitLabel);
    const mediaType = getString(item, 'mimeType')
      || getString(item, 'mediaType')
      || getString(item, 'media_type');

    const imageUrl = isRecord(item.imageUrl) ? item.imageUrl : null;
    const imageUrlValue = getString(imageUrl || {}, 'url');
    if (imageUrlValue) {
      const urlMediaType = getString(imageUrl || {}, 'mediaType') || mediaType;
      const image = imageFromDataUrl(imageUrlValue, label)
        || (imageUrlValue.startsWith('http://') || imageUrlValue.startsWith('https://')
          ? { url: imageUrlValue, mediaType: isImageMediaType(urlMediaType) ? urlMediaType.toLowerCase() : 'image/*', label }
          : null);
      add(image);
    }

    const base64Value = getString(item, '$base64');
    if (base64Value) add(imageFromBase64(base64Value, mediaType, label));

    const dataValue = getString(item, 'data');
    if (dataValue) add(imageFromUrlOrBase64(dataValue, mediaType, label));

    const value = isRecord(item.value) ? item.value : null;
    const nestedBase64 = value ? getString(value, '$base64') : undefined;
    if (nestedBase64) add(imageFromBase64(nestedBase64, mediaType, label));

    for (const [key, child] of Object.entries(item)) {
      if (key === '$base64' || key === 'data' || key === 'imageUrl') continue;
      visit(child, explicitLabel);
    }
  };

  visit(value);
  return dedupeImages(images);
}

export function summarizeImages(images: SessionMessageImageDisplay[]): string {
  return `${images.length} image${images.length === 1 ? '' : 's'}`;
}

export function extractDataUrlImage(value: string): SessionMessageImageDisplay | null {
  const match = DATA_IMAGE_CAPTURE_RE.exec(value.trim());
  if (!match) return null;
  return imageFromBase64(match[2], match[1]);
}
