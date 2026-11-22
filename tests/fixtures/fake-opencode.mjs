#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_CFG, 'utf8'));
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const arm = existsSync('opencode.jsonc') ? 'distill' : 'baseline';
const file = /file (\S+) in this folder/.exec(prompt)?.[1] ?? 'unknown';
const key = `${file}|${arm}`;
const env = process.env;

appendFileSync(
  cfg.log,
  `${JSON.stringify({
    key,
    argv,
    cwd: process.cwd(),
    files: readdirSync(process.cwd()),
    mcp: existsSync('opencode.jsonc') ? JSON.parse(readFileSync('opencode.jsonc', 'utf8')) : null,
    skill: existsSync('.agents/skills/distill-documents/SKILL.md'),
    plugin: existsSync('.opencode/plugins/distill.js'),
    env: { HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME, npm_config_cache: env.npm_config_cache, DISTILL_CACHE_DIR: env.DISTILL_CACHE_DIR },
    pathHead: (env.PATH ?? '').split(':')[0],
  })}\n`,
);

const counterFile = `${cfg.counter}.${key.replace(/[^a-z0-9]/gi, '_')}`;
const count = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) + 1 : 1;
writeFileSync(counterFile, String(count));
const plan = cfg.behaviors[key] ?? cfg.behaviors.default ?? [{ kind: 'ok', answer: '1' }];
const behavior = plan[Math.min(count, plan.length) - 1];

const emit = (events) => process.stdout.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
const start = { type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start' } };
const finish = (reason, cost, input, output, read) => ({ type: 'step_finish', part: { type: 'step-finish', reason, cost, tokens: { input, output, reasoning: 0, cache: { read, write: 0 } } } });
const tool = (id, name, input, output, status = 'completed', error) => ({ type: 'tool_use', part: { type: 'tool', id, tool: name, state: { status, input, output, ...(error ? { error } : {}), title: name } } });

if (behavior.kind === 'exit') {
  process.stderr.write('boom\n');
  process.exit(behavior.code ?? 1);
} else if (behavior.kind === 'fail') {
  emit([start, { type: 'error', error: { name: 'APIError', data: { message: 'quota exceeded' } } }]);
} else {
  const events = [start];
  for (const [index, spec] of (behavior.tools ?? ['bash:head -n 1 a.txt']).entries()) {
    const id = `tool_${index}`;
    if (spec === 'mcp') events.push(tool(id, 'distill_distill_file', { path: 'a.pdf' }, 'converted'));
    else if (spec === 'mcp-denied') events.push(tool(id, 'distill_distill_file', { path: 'a.pdf' }, '', 'error', 'The user rejected permission to use this tool'));
    else if (spec === 'read-converted') events.push(tool(id, 'read', { path: `${env.DISTILL_CACHE_DIR}/abc.md` }, 'Read file'));
    else if (spec === 'read') events.push(tool(id, 'read', { path: 'a.txt' }, 'Read file a.txt'));
    else events.push(tool(id, 'bash', { command: spec.replace(/^bash:/, '') }, 'out'));
  }
  events.push(finish('tool-calls', 0.0027210816, 14956, 39, 256), start, { type: 'text', part: { type: 'text', text: behavior.kind === 'noanswer' ? 'I could not tell.' : `Looked it up.\nANSWER: ${behavior.answer}` } }, finish('stop', 0.0002092752, 846, 3, 15232));
  emit(events);
}
