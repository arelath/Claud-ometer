export interface FileSignature {
  mtimeMs: number;
  size: number;
}

export interface ProviderCacheKey {
  provider: string;
  filePath: string;
  signature: FileSignature;
  scope?: string;
}

interface CacheEntry<T> {
  key: ProviderCacheKey;
  value: T;
}

function keyToString(key: ProviderCacheKey): string {
  return [key.provider, key.scope || 'default', key.filePath].join(':');
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export class AgentDataCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: ProviderCacheKey): T | undefined {
    const cached = this.entries.get(keyToString(key));
    if (!cached) return undefined;
    return sameSignature(cached.key.signature, key.signature) ? cached.value : undefined;
  }

  set(key: ProviderCacheKey, value: T): void {
    this.entries.set(keyToString(key), { key, value });
  }

  delete(key: ProviderCacheKey): void {
    this.entries.delete(keyToString(key));
  }

  clear(): void {
    this.entries.clear();
  }
}
