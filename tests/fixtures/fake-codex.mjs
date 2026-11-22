#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.FAKE_CODEX_CFG, 'utf8'));
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const arm = argv.some((a) => a.startsWith('mcp_servers.distill.command')) ? 'distill' : 'baseline';
const file = /file (\S+) in this folder/.exec(prompt)?.[1] ?? 'unknown';
const key = `${file}|${arm}`;

appendFileSync(
  cfg.log,
  `${JSON.stringify({
    key,
    argv,
    cwd: process.cwd(),
    files: readdirSync(process.cwd()),
    cacheDir: process.env.DISTILL_CACHE_DIR ?? null,
    pathHead: (process.env.PATH ?? '').split(':')[0],
    pid: process.pid,
  })}\n`,
);

const counterFile = `${cfg.counter}.${key.replace(/[^a-z0-9]/gi, '_')}`;
const count = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) + 1 : 1;
writeFileSync(counterFile, String(count));

const plan = cfg.behaviors[key] ?? cfg.behaviors.default ?? [{ kind: 'ok', answer: '1' }];
const behavior = plan[Math.min(count, plan.length) - 1];

const emit = (events) => process.stdout.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
const shell = (id, inner, output) => [
  { type: 'item.started', item: { id, type: 'command_execution', command: `/bin/zsh -lc '${inner}'`, aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id, type: 'command_execution', command: `/bin/zsh -lc '${inner}'`, aggregated_output: output, exit_code: 0, status: 'completed' } },
];
const mcp = (id, mode) => {
  const base = { id, type: 'mcp_tool_call', server: 'distill', tool: 'convert', arguments: { path: 'a.pdf' } };
  if (mode === 'denied') return { type: 'item.completed', item: { ...base, status: 'failed', error: { message: 'user cancelled MCP tool call' } } };
  if (mode === 'failed') return { type: 'item.completed', item: { ...base, status: 'failed', error: { message: 'conversion crashed' } } };
  return { type: 'item.completed', item: { ...base, status: 'completed', result: { content: [{ type: 'text', text: 'converted' }] } } };
};

if (behavior.kind === 'hang') {
  setInterval(() => {}, 1000);
} else if (behavior.kind === 'exit') {
  process.stderr.write('boom\n');
  process.exit(behavior.code ?? 1);
} else if (behavior.kind === 'garbage') {
  process.stdout.write('not json at all\n{"type":\n');
} else if (behavior.kind === 'fail') {
  emit([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'error', message: 'quota exceeded' }, { type: 'turn.failed', error: { message: 'quota exceeded' } }]);
} else {
  const events = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }];
  for (const [index, command] of (behavior.commands ?? ['head -n 1 a.txt']).entries()) events.push(...shell(`item_${index}`, command, 'hello file\n'));
  if (behavior.mcp) events.push(mcp('item_mcp', behavior.mcp));
  events.push({ type: 'item.completed', item: { id: 'item_last', type: 'agent_message', text: behavior.kind === 'noanswer' ? 'I could not tell.' : `Looked it up.\nANSWER: ${behavior.answer}` } });
  events.push({ type: 'turn.completed', usage: { input_tokens: 35708, cached_input_tokens: 29824, cache_write_input_tokens: 0, output_tokens: 43, reasoning_output_tokens: 0 } });
  emit(events);
}
