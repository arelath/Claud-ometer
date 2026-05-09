import { z } from 'zod';

export const looseRecordSchema = z.record(z.string(), z.unknown());

export const codexEnvelopeSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: looseRecordSchema.optional(),
}).catchall(z.unknown());

export type CodexEnvelope = z.infer<typeof codexEnvelopeSchema>;

export function getCodexPayloadKind(envelope: CodexEnvelope): string {
  const payloadType = envelope.payload?.type;
  const payloadKind = envelope.payload?.kind;
  if (typeof payloadKind === 'string' && payloadKind.trim()) return payloadKind;
  if (typeof payloadType === 'string' && payloadType.trim()) return payloadType;
  return envelope.type;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
