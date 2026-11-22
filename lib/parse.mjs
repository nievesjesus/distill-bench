const DISTILL = /distill/i;
const REFUSED = /haven't granted it yet|Blocked by/;

export function parseStream(raw) {
  let result = null;
  let lastText = '';
  let malformed = 0;
  let signalUsed = false;
  let permissionDenials = 0;
  const namesById = new Map();
  const deniedIds = new Set();
  const toolCalls = {};
  const toolUses = [];
  let converted = false;
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      malformed += 1;
      continue;
    }
    if (event.type === 'result') {
      result = event;
      continue;
    }
    if (event.type === 'system' && event.subtype === 'hook_response' && typeof event.hook_name === 'string' && event.hook_name.startsWith('PreToolUse')) {
      const output = `${event.output ?? ''}${event.stdout ?? ''}`;
      if (DISTILL.test(output)) signalUsed = true;
      if (output.includes('distill converted')) converted = true;
      continue;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') lastText = block.text;
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') {
            if (seen.has(block.id)) continue;
            seen.add(block.id);
          }
          toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
          const use = { name: block.name, input: block.input ?? {} };
          if (typeof block.id === 'string') {
            use.id = block.id;
            namesById.set(block.id, block.name);
          }
          toolUses.push(use);
        }
      }
      continue;
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        const content = typeof block?.content === 'string' ? block.content : Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? '').join('') : '';
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && REFUSED.test(content)) deniedIds.add(block.tool_use_id);
        if (content.includes('[distill]')) signalUsed = true;
        if (content.includes('distill converted')) converted = true;
      }
    }
  }
  const denials = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  for (const denial of denials) {
    const id = denial?.tool_use_id;
    if (typeof id === 'string') {
      deniedIds.add(id);
      if (typeof denial.tool_name === 'string' && !namesById.has(id)) namesById.set(id, denial.tool_name);
    }
  }
  permissionDenials = Math.max(deniedIds.size, denials.length);
  for (const use of toolUses) {
    if (use.id !== undefined && deniedIds.has(use.id)) use.denied = true;
  }
  const deniedToolUses = [...deniedIds].map((id) => namesById.get(id) ?? 'unknown');
  const toolSignal = toolUses.some((use) => use.denied !== true && (DISTILL.test(use.name) || (use.name === 'Skill' && DISTILL.test(JSON.stringify(use.input)))));
  const distillUsed = signalUsed || toolSignal;
  return { result, lastText, malformed, toolCalls, toolUses, converted, distillUsed, deniedToolUses, permissionDenials };
}

export function summarizeResult(parsed) {
  const { result } = parsed;
  if (result === null) return null;
  const usage = result.usage ?? {};
  return {
    isError: result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success'),
    subtype: result.subtype ?? null,
    text: typeof result.result === 'string' ? result.result : parsed.lastText,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    },
  };
}
