import { forEachCodexJsonlLine } from './io';
import { asRecord, getCodexPayloadKind, type CodexEnvelope } from './schema';
import { collectCodexToolResults, compactCodexToolResult, getCodexFileChangeItem, SUMMARY_TOOL_RESULT, type CodexSummaryEnvelope } from './tool-parser';

function pick(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => key in payload).map(key => [key, payload[key]]));
}

// Preserve the inputs consumed by parsing and subagent scoping, while dropping
// opaque history, encrypted reasoning, images, and unused event payloads.
export async function readCodexSummaryRecords(filePath: string, endOffset?: number): Promise<CodexEnvelope[]> {
  const readCalls = new Set<string>();
  await forEachCodexJsonlLine(filePath, record => {
    const payload = asRecord(record.payload);
    if (record.type === 'response_item' && payload?.name === 'Read') {
      readCalls.add(String(payload.call_id ?? payload.callId ?? payload.id ?? ''));
    }
  }, endOffset);

  const records: CodexSummaryEnvelope[] = [];
  await forEachCodexJsonlLine(filePath, record => {
    const payload = asRecord(record.payload) || {};
    const kind = getCodexPayloadKind(record);
    if (record.type === 'response_item' && payload.name === 'Read') {
      readCalls.add(String(payload.call_id ?? payload.callId ?? payload.id ?? ''));
    }
    const projected: CodexSummaryEnvelope = {
      type: record.type,
      timestamp: record.timestamp?.trim() || (typeof payload.timestamp === 'string' ? payload.timestamp : undefined),
      payload: pick(payload, ['type', 'kind']),
    };
    const result = collectCodexToolResults([record]).values().next().value;
    if (result) {
      projected.payload = pick(payload, ['type', 'kind', 'call_id', 'callId', 'id']);
      projected[SUMMARY_TOOL_RESULT] = compactCodexToolResult(result, readCalls.has(result.callId));
    } else if (record.type === 'session_meta') {
      projected.payload = pick(payload, ['id', 'cwd', 'cli_version', 'version', 'git', 'git_branch', 'gitBranch']);
    } else if (record.type === 'turn_context') {
      projected.payload = pick(payload, ['model', 'cwd']);
    } else if (record.type === 'inter_agent_communication_metadata') {
      projected.payload = pick(payload, ['trigger_turn']);
    } else if (record.type === 'event_msg' && kind === 'item_completed') {
      const item = getCodexFileChangeItem(record);
      if (item) projected.payload = {
        ...projected.payload,
        item: pick(item, ['type', 'id', 'status', 'changes']),
      };
    } else if (record.type === 'response_item' || record.type === 'event_msg') {
      const fields: Record<string, string[]> = {
        message: ['role', 'content'],
        agent_message: ['content', 'message', 'author', 'recipient'],
        user_message: ['content', 'message', 'text_elements', 'images', 'local_images'],
        reasoning: ['summary', 'content', 'text'],
        agent_reasoning: ['summary', 'content', 'text'],
        function_call: ['name', 'call_id', 'callId', 'id', 'arguments', 'input', 'command', 'cwd'],
        custom_tool_call: ['name', 'call_id', 'callId', 'id', 'arguments', 'input', 'command', 'cwd'],
        web_search_call: ['name', 'call_id', 'callId', 'id', 'arguments', 'input'],
        token_count: ['info', 'total_token_usage', 'last_token_usage'],
        context_compacted: ['trigger', 'pre_tokens'],
        error: ['reason', 'message'],
        turn_aborted: ['reason', 'message'],
      };
      projected.payload = pick(payload, ['type', 'kind', ...(fields[kind] || [])]);
      for (const key of ['content', 'text_elements']) {
        const content = projected.payload[key];
        if (Array.isArray(content)) {
          projected.payload[key] = content.map(block => {
            const item = asRecord(block);
            if (item?.type === 'encrypted_content') return { type: item.type };
            return item?.type === 'input_image'
              ? { type: item.type, media_type: item.media_type, mime_type: item.mime_type }
              : block;
          });
        }
      }
      // Only the number of these images contributes to summary text.
      for (const key of ['images', 'local_images']) {
        if (Array.isArray(projected.payload[key])) projected.payload[key] = projected.payload[key].map(() => null);
      }
    }
    records.push(projected);
  }, endOffset);
  return records;
}
