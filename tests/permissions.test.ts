import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', name)).href);

const lines = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const MCP = 'mcp__plugin_distill_distill__distill_search';
const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: MCP, input: { q: 'x' } }] } };
const reply = (text: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: text }] } });
const done = (extra: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ANSWER: 1', ...extra });

async function run(events: object[]) {
  const { parseStream } = await load('parse.mjs');
  const { classifyPaths } = await load('classify.mjs');
  const parsed = parseStream(lines(events));
  return { parsed, paths: classifyPaths(parsed) };
}

describe('refused tool calls', () => {
  it('labels a refused MCP distill call mcp-denied and not as use', async () => {
    const { parsed, paths } = await run([call, reply(`Claude requested permissions to use ${MCP}, but you haven't granted it yet.`), done()]);
    expect(paths).toEqual(['mcp-denied']);
    expect(parsed.distillUsed).toBe(false);
    expect(parsed.permissionDenials).toBeGreaterThanOrEqual(1);
    expect(parsed.deniedToolUses).toEqual([MCP]);
  });

  it('keeps mcp-distill when the call succeeds', async () => {
    const { parsed, paths } = await run([call, reply('converted text'), done()]);
    expect(paths).toEqual(['mcp-distill']);
    expect(parsed.distillUsed).toBe(true);
    expect(parsed.permissionDenials).toBe(0);
  });

  it('counts a hook block and reads permission_denials from the result', async () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } };
    const blocked = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'PreToolUse:Bash hook error: Blocked by Sage' }] } };
    const { parsed } = await run([bash, blocked, done({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b1' }, { tool_name: 'Read', tool_use_id: 'r9' }] })]);
    expect(parsed.permissionDenials).toBe(2);
    expect(parsed.deniedToolUses).toEqual(['Bash', 'Read']);
  });
});

describe('buildArgs', () => {
  const base = { prompt: 'p', model: 'sonnet', pluginDir: '/plug', maxTurns: 30, runBudgetUsd: 2 };

  it('allows the MCP server only for the distill arm and isolates user settings', async () => {
    const { buildArgs, DISTILL_MCP_RULE } = await load('runner.mjs');
    const distill = buildArgs({ ...base, arm: 'distill' });
    const baseline = buildArgs({ ...base, arm: 'baseline' });
    expect(DISTILL_MCP_RULE).toBe('mcp__plugin_distill_distill');
    expect(distill[distill.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob,Bash,mcp__plugin_distill_distill');
    expect(baseline[baseline.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob,Bash');
    for (const args of [distill, baseline]) expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('leaves out --setting-sources with userSettings', async () => {
    const { buildArgs } = await load('runner.mjs');
    expect(buildArgs({ ...base, arm: 'distill', userSettings: true })).not.toContain('--setting-sources');
  });
});
