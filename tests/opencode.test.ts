import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const repo = resolve(__dirname, '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', name)).href);
const sha = 'a'.repeat(64);
const MODEL = 'openrouter/z-ai/glm-5.3';

interface Rec {
  [key: string]: unknown;
}
const lines = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const start = { type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start' } };
const finish = (reason: string, cost: number, input: number, output: number, read: number, extra: object = {}) => ({
  type: 'step_finish',
  part: { type: 'step-finish', reason, cost, tokens: { input, output, reasoning: 0, cache: { read, write: 0 }, ...extra } },
});
const tool = (name: string, input: object, output = '', state: object = {}, id = `tool_${name}`) => ({ type: 'tool_use', part: { type: 'tool', id, tool: name, state: { status: 'completed', input, output, title: name, ...state } } });
const text = (value: string) => ({ type: 'text', part: { type: 'text', text: value } });

const trivial = lines([
  start,
  tool('read', { path: 'a.txt' }, 'Read file a.txt, lines 1-1\n1: hello file', {}, 'chatcmpl-tool-1'),
  finish('tool-calls', 0.0027210816, 14956, 39, 256),
  start,
  text('hello'),
  finish('stop', 0.0002092752, 846, 3, 15232),
]);

describe('parseOpencodeStream', () => {
  it('parses the real trivial run: cost, tokens, turns, last text and tools', async () => {
    const { parseOpencodeStream, summarizeOpencode } = await load('agents/opencode.mjs');
    const parsed = parseOpencodeStream(trivial);
    expect(parsed.result).toEqual({ failed: false });
    expect(parsed.lastText).toBe('hello');
    expect(parsed.toolCalls).toEqual({ Read: 1 });
    expect(parsed.toolUses).toEqual([{ name: 'Read', input: { path: 'a.txt' }, id: 'chatcmpl-tool-1' }]);
    const summary = summarizeOpencode(parsed);
    expect(summary).toMatchObject({ isError: false, text: 'hello', numTurns: 2, durationMs: null, usage: { input: 15802, output: 42, cacheRead: 15488, cacheCreation: 0 } });
    expect(summary.costUsd).toBeCloseTo(0.0029303568, 10);
  });

  it('adds reasoning tokens to the output and cache writes to cacheCreation', async () => {
    const { parseOpencodeStream } = await load('agents/opencode.mjs');
    const parsed = parseOpencodeStream(lines([start, finish('stop', 0.1, 10, 5, 100, { reasoning: 7, cache: { read: 100, write: 30 } }), text('x')]));
    expect(parsed.usage).toEqual({ input: 10, output: 12, cacheRead: 100, cacheCreation: 30 });
  });

  it('treats any error event as a failed run and survives garbage', async () => {
    const { parseOpencodeStream, summarizeOpencode } = await load('agents/opencode.mjs');
    const failed = parseOpencodeStream(lines([start, { type: 'error', error: { name: 'APIError' } }, text('late'), finish('stop', 0.1, 1, 1, 0)]));
    expect(summarizeOpencode(failed)).toMatchObject({ isError: true, subtype: 'error' });
    const garbage = parseOpencodeStream('not json\n{"type":\n[1]\n');
    expect(garbage.result).toBeNull();
    expect(garbage.malformed).toBe(3);
    expect(summarizeOpencode(garbage)).toBeNull();
  });

  it('reports a null cost when no step carries one', async () => {
    const { parseOpencodeStream, summarizeOpencode } = await load('agents/opencode.mjs');
    expect(summarizeOpencode(parseOpencodeStream(lines([start, text('x')]))).costUsd).toBeNull();
  });

  it('maps tool names and keeps one entry per tool id', async () => {
    const { parseOpencodeStream } = await load('agents/opencode.mjs');
    const parsed = parseOpencodeStream(
      lines([start, tool('bash', { command: 'ls' }, '', { status: 'running' }, 'b1'), tool('bash', { command: 'ls' }, 'a.txt', {}, 'b1'), tool('grep', { pattern: 'x' }), tool('glob', {}), tool('webfetch', {})]),
    );
    expect(parsed.toolUses.map((u: Rec) => u.name)).toEqual(['Bash', 'Grep', 'Glob', 'webfetch']);
    expect(parsed.toolCalls).toEqual({ Bash: 1, Grep: 1, Glob: 1, webfetch: 1 });
  });
});

describe('opencode classification', () => {
  const classify = async (events: object[], cacheDirs: string[] = []) => {
    const { parseOpencodeStream } = await load('agents/opencode.mjs');
    const { classifyPaths } = await load('classify.mjs');
    const parsed = parseOpencodeStream(lines(events), { cacheDirs });
    return { parsed, paths: classifyPaths(parsed) };
  };

  it('maps a plain read to read and a pages-like field to read-pages', async () => {
    expect((await classify([start, tool('read', { path: 'a.txt' })])).paths).toEqual(['read']);
    expect((await classify([start, tool('read', { path: 'a.pdf', pages: '1-3' })])).paths).toEqual(['read-pages']);
  });

  it('maps a bash pdftotext call to bash-pdftools', async () => {
    const { paths } = await classify([start, tool('bash', { command: 'pdftotext -layout a.pdf - | head' })]);
    expect(paths).toEqual(['bash-pdftools']);
  });

  it('maps bash python and other commands', async () => {
    expect((await classify([start, tool('bash', { command: 'python3 -c "import pypdf"' })])).paths).toEqual(['bash-python']);
    expect((await classify([start, tool('bash', { command: 'ls' })])).paths).toEqual(['bash-other']);
  });

  it('maps a distill MCP tool to mcp-distill and counts it as use', async () => {
    const { parsed, paths } = await classify([start, tool('distill_distill_search', { query: 'x' }, 'hit')]);
    expect(paths).toEqual(['mcp-distill']);
    expect(parsed.distillUsed).toBe(true);
    expect(parsed.toolCalls).toEqual({ mcp__opencode__distill_distill_search: 1 });
  });

  it('maps a refused distill MCP call to mcp-denied and not to use', async () => {
    const { parsed, paths } = await classify([start, tool('distill_distill_file', {}, '', { status: 'error', error: 'The user rejected permission to use this tool' })]);
    expect(paths).toEqual(['mcp-denied']);
    expect(parsed.distillUsed).toBe(false);
    expect(parsed.permissionDenials).toBe(1);
    expect(parsed.deniedToolUses).toEqual(['mcp__opencode__distill_distill_file']);
  });

  it('treats a generic MCP failure as use', async () => {
    const { parsed, paths } = await classify([start, tool('distill_distill_file', {}, '', { status: 'error', error: 'conversion crashed' })]);
    expect(paths).toEqual(['mcp-distill']);
    expect(parsed.distillUsed).toBe(true);
    expect(parsed.permissionDenials).toBe(0);
  });

  it('maps a read the distill plugin rewrote into the cache to read-converted', async () => {
    const { parsed, paths } = await classify([start, tool('read', { path: '/run/cache/abc.md' }, 'Read file /run/cache/abc.md')], ['/run/cache']);
    expect(paths).toEqual(['read', 'read-converted']);
    expect(parsed.distillUsed).toBe(true);
  });

  it('maps the shell tool like bash', async () => {
    const { parsed, paths } = await classify([start, tool('shell', { command: 'pdftotext a.pdf -' })]);
    expect(paths).toEqual(['bash-pdftools']);
    expect(parsed.toolCalls).toEqual({ Bash: 1 });
  });

  it('classifies distill calls inside an execute as mcp-distill use', async () => {
    const code = 'const r = await tools.distill.distill_search({ path: "911-report.pdf", query: "Moussaoui" });\nreturn r;';
    const { parsed, paths } = await classify([start, tool('execute', { code }, 'ok')]);
    expect(paths).toEqual(['mcp-distill']);
    expect(parsed.distillUsed).toBe(true);
    expect(parsed.toolCalls).toEqual({ execute: 1 });
    expect(parsed.toolUses.map((u: Rec) => u.name)).toEqual(['mcp__distill__distill_search']);
  });

  it('emits one use per distill call in an execute', async () => {
    const code = 'await tools.distill.distill_outline({ path: "a" }); await tools.distill.distill_search({ path: "a" });';
    const { parsed } = await classify([start, tool('execute', { code })]);
    expect(parsed.toolUses.map((u: Rec) => u.name)).toEqual(['mcp__distill__distill_outline', 'mcp__distill__distill_search']);
  });

  it('maps a refused execute distill call to mcp-denied', async () => {
    const code = 'return await tools.distill.distill_file({ path: "a" });';
    const { parsed, paths } = await classify([start, tool('execute', { code }, '', { status: 'error', error: 'The user rejected permission' })]);
    expect(paths).toEqual(['mcp-denied']);
    expect(parsed.distillUsed).toBe(false);
    expect(parsed.deniedToolUses).toEqual(['mcp__distill__distill_file']);
  });

  it('does not count discovery or other-server execute calls as paths or use', async () => {
    const { parsed, paths } = await classify([
      start,
      tool('execute', { code: 'const r = await search({ query: "distill" }); return r.items;' }, '[]', {}, 'e1'),
      tool('execute', { code: 'return await tools.opencode.read({ path: "a" });' }, '', {}, 'e2'),
    ]);
    expect(paths).toEqual([]);
    expect(parsed.distillUsed).toBe(false);
    expect(parsed.toolCalls).toEqual({ execute: 2 });
  });

  it('detects a plugin rewrite whose output names the per-run cache under /var and /private/var', async () => {
    const out = 'Read file /var/folders/ab/xyz/T/distill-bench-run-1/cache/out/0123abcd.md, lines 1-50';
    const read = tool('read', { path: '911-report.pdf' }, out);
    expect((await classify([start, read], ['/var/folders/ab/xyz/T/distill-bench-run-1/cache'])).paths).toEqual(['read', 'read-converted']);
    expect((await classify([start, read], ['/private/var/folders/ab/xyz/T/distill-bench-run-1/cache'])).paths).toEqual(['read', 'read-converted']);
  });

  it('detects a rewrite by the output or by a [distill] marker', async () => {
    expect((await classify([start, tool('read', { path: 'a.pdf' }, 'Read /run/cache/abc.md')], ['/run/cache'])).paths).toContain('read-converted');
    expect((await classify([start, tool('read', { path: 'a.pdf' }, '[distill] converted')])).paths).toContain('read-converted');
    expect((await classify([start, tool('read', { path: 'a.pdf' }, 'raw bytes')], ['/run/cache'])).paths).toEqual(['read']);
  });
});

describe('opencode args and env', () => {
  const base = { arm: 'baseline', packageSpec: 'distill-llm@1', cacheDir: '/c', scenario: 'dev' };

  it('builds the exact command with the prompt last', async () => {
    const { opencodeAgent } = await load('agents/opencode.mjs');
    expect(opencodeAgent.buildArgs({ prompt: 'p q', model: MODEL })).toEqual(['run', '--standalone', '--auto', '--archived', '--format', 'json', '-m', MODEL, 'p q']);
  });

  it('resolves model, label and executable', async () => {
    const { opencodeAgent } = await load('agents/opencode.mjs');
    expect(opencodeAgent.resolveModel({ 'opencode-model': MODEL })).toEqual({ model: MODEL, reasoning: null });
    expect(opencodeAgent.modelLabel({ model: MODEL })).toBe(MODEL);
    expect(opencodeAgent.resolveBin({ 'opencode-bin': '/x/oc' }, {})).toBe('/x/oc');
    expect(opencodeAgent.resolveBin({ 'opencode-bin': '' }, { DISTILL_BENCH_OPENCODE: '/y' })).toBe('/y');
    expect(opencodeAgent.resolveBin({ 'opencode-bin': '' }, {})).toBe('opencode');
    expect(opencodeAgent.hasCost).toBe(true);
  });

  describe('isolation', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'distill-bench-ocenv-'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('points HOME and XDG_CONFIG_HOME at empty per-run dirs and keeps data, cache and npm real', async () => {
      const { buildOpencodeEnv } = await load('agents/opencode.mjs');
      const env = buildOpencodeEnv({ ...base, root, baseEnv: { HOME: '/real', PATH: '/bin' } });
      expect(env.HOME).toBe(join(root, 'home'));
      expect(env.XDG_CONFIG_HOME).toBe(join(root, 'xdg-config'));
      expect(existsSync(env.HOME)).toBe(true);
      expect(existsSync(env.XDG_CONFIG_HOME)).toBe(true);
      expect(env.XDG_DATA_HOME).toBe('/real/.local/share');
      expect(env.XDG_CACHE_HOME).toBe('/real/.cache');
      expect(env.npm_config_cache).toBe('/real/.npm');
      expect(env.DISTILL_CACHE_DIR).toBe('/c');
    });

    it('honours an explicit XDG_DATA_HOME and npm cache from the operator', async () => {
      const { buildOpencodeEnv } = await load('agents/opencode.mjs');
      const env = buildOpencodeEnv({ ...base, root, baseEnv: { HOME: '/real', XDG_DATA_HOME: '/data', XDG_CACHE_HOME: '/cache', npm_config_cache: '/npm' } });
      expect(env).toMatchObject({ XDG_DATA_HOME: '/data', XDG_CACHE_HOME: '/cache', npm_config_cache: '/npm' });
    });

    it('points PWD at the run project dir, also with userSettings', async () => {
      const { buildOpencodeEnv } = await load('agents/opencode.mjs');
      expect(buildOpencodeEnv({ ...base, root, baseEnv: { HOME: '/real', PWD: '/launch' } }).PWD).toBe(join(root, 'project'));
      expect(buildOpencodeEnv({ ...base, root, userSettings: true, baseEnv: { HOME: '/real', PWD: '/launch' } }).PWD).toBe(join(root, 'project'));
    });

    it('skips the isolation with userSettings', async () => {
      const { buildOpencodeEnv } = await load('agents/opencode.mjs');
      const env = buildOpencodeEnv({ ...base, root, userSettings: true, baseEnv: { HOME: '/real', PATH: '/bin' } });
      expect(env.HOME).toBe('/real');
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'npm_config_cache']) expect(env).not.toHaveProperty(key);
      expect(existsSync(join(root, 'home'))).toBe(false);
    });
  });
});

describe('prepareOpencode', () => {
  const sample = `Command: npx -y distill-llm@0.9.0
== OpenCode ==
Manual step: OpenCode 2.x: add the server by hand
File: /p/opencode.jsonc
  {
    "mcp": {
      "servers": {
        "distill": { "type": "local", "command": ["/n/node","/c/dist/cli.js","mcp"] }
      }
    }
  }
File: /p/.opencode/plugins/distill.js
+ const a = 1;
== shared skill (~/.agents/skills) ==
File: /p/.agents/skills/distill-documents/SKILL.md
+ ---
+ name: distill-documents
+ ---
+ 
+ body
`;
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'distill-bench-prep-'));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('parses the dry run into the skill text and the MCP command', async () => {
    const { parseDryRun } = await load('agents/opencode.mjs');
    expect(parseDryRun(sample)).toEqual({ skill: '---\nname: distill-documents\n---\n\nbody\n', command: ['/n/node', '/c/dist/cli.js', 'mcp'] });
    expect(parseDryRun('nothing')).toEqual({ skill: null, command: null });
  });

  it('does nothing on the baseline arm', async () => {
    const { prepareOpencode } = await load('agents/opencode.mjs');
    const exec = vi.fn();
    expect(prepareOpencode({ arm: 'baseline', project, env: {}, packageSpec: 'distill-llm@0.9.0', cacheDir: '/c', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(join(project, 'opencode.jsonc'))).toBe(false);
  });

  it('installs the hook plugin, then writes the MCP config with DISTILL_CACHE_DIR and the skill, on the distill arm', async () => {
    const { prepareOpencode } = await load('agents/opencode.mjs');
    const calls: { args: string[]; options: Rec }[] = [];
    const exec = (command: string, args: string[], options: Rec) => {
      calls.push({ args: [command, ...args], options });
      return args.includes('--dry-run') ? sample : '';
    };
    const env = { PATH: '/bin' };
    expect(prepareOpencode({ arm: 'distill', project, env, packageSpec: 'distill-llm@0.9.0', cacheDir: '/run/cache', exec })).toBeNull();
    expect(calls.map((c) => c.args)).toEqual([
      ['npx', '-y', 'distill-llm@0.9.0', 'hooks', 'install', '--opencode', '--project', '--yes'],
      ['npx', '-y', 'distill-llm@0.9.0', 'agents', 'install', '--opencode', '--project', '--dry-run'],
    ]);
    expect(calls.every((c) => c.options.cwd === project && c.options.env === env)).toBe(true);
    expect(JSON.parse(readFileSync(join(project, 'opencode.jsonc'), 'utf8'))).toEqual({
      mcp: { servers: { distill: { type: 'local', command: ['/n/node', '/c/dist/cli.js', 'mcp'], environment: { DISTILL_CACHE_DIR: '/run/cache' } } } },
    });
    expect(readFileSync(join(project, '.agents', 'skills', 'distill-documents', 'SKILL.md'), 'utf8')).toBe('---\nname: distill-documents\n---\n\nbody\n');
  });

  it('falls back to an npx MCP command when the dry run shows none', async () => {
    const { prepareOpencode } = await load('agents/opencode.mjs');
    prepareOpencode({ arm: 'distill', project, env: {}, packageSpec: 'distill-llm@0.9.0', cacheDir: '/c', exec: () => '' });
    expect(JSON.parse(readFileSync(join(project, 'opencode.jsonc'), 'utf8')).mcp.servers.distill.command).toEqual(['npx', '-y', 'distill-llm@0.9.0', 'mcp']);
  });

  it('returns the failure of either npx step as an error message', async () => {
    const { prepareOpencode } = await load('agents/opencode.mjs');
    const failing = (which: string) => (_c: string, args: string[]) => {
      if (args.includes(which)) throw Object.assign(new Error('Command failed'), { stderr: 'npm error network down\n' });
      return '';
    };
    expect(prepareOpencode({ arm: 'distill', project, env: {}, packageSpec: 's', cacheDir: '/c', exec: failing('hooks') })).toBe('distill hook install failed: npm error network down');
    expect(prepareOpencode({ arm: 'distill', project, env: {}, packageSpec: 's', cacheDir: '/c', exec: failing('--dry-run') })).toContain('agents install --dry-run failed');
  });
});

describe('opencode options', () => {
  it('requires --opencode-model for the opencode agent only', async () => {
    const { parseArgs } = await load('args.mjs');
    expect(() => parseArgs(['--agent', 'opencode'])).toThrow('--opencode-model');
    expect(parseArgs(['--agent', 'opencode', '--opencode-model', MODEL, '--opencode-bin', '/x'])).toMatchObject({ agent: 'opencode', 'opencode-model': MODEL, 'opencode-bin': '/x', 'max-runs': Number.POSITIVE_INFINITY, 'max-runs-defaulted': false });
    expect(parseArgs(['--agent', 'codex'])).toMatchObject({ agent: 'codex' });
  });

  it('includes the model in the resume key', async () => {
    const { unitKey, finishedKeys } = await load('plan.mjs');
    const base = { night: 'n', task: 't', arm: 'baseline', repeat: 1, ok: true, agent: 'opencode' };
    const keys = finishedKeys([{ ...base, model: 'openrouter/a' }]);
    expect(keys.has(unitKey('n', 't', 'baseline', 1, 'openrouter/a', 'dev', 'opencode'))).toBe(true);
    expect(keys.has(unitKey('n', 't', 'baseline', 1, 'openrouter/b', 'dev', 'opencode'))).toBe(false);
  });
});

const rec = (over: Rec = {}): Rec => ({
  night: '2026-11-19',
  task: 't1',
  doc: 'd1',
  arm: 'baseline',
  agent: 'opencode',
  model: 'openrouter/a',
  package: null,
  repeat: 1,
  attempt: 1,
  ok: true,
  costUsd: 1,
  usage: { input: 1000, output: 50, cacheCreation: 0, cacheRead: 9000 },
  numTurns: 3,
  durationMs: 20_000,
  distillUsed: false,
  correct: true,
  ...over,
});
const distillRec = (over: Rec = {}) => rec({ arm: 'distill', package: 'distill-llm@1', distillUsed: true, costUsd: 0.5, ...over });
const tasks = [{ id: 't1', doc: 'd1', tags: ['simple'] }];

describe('opencode in aggregate and report', () => {
  it('never mixes or pairs two models of the same agent', async () => {
    const { aggregate, finalRecords } = await load('aggregate.mjs');
    const records = [rec(), distillRec(), rec({ model: 'openrouter/b', costUsd: 4 }), distillRec({ model: 'openrouter/b', costUsd: 1 })];
    expect(finalRecords(records)).toHaveLength(4);
    const data = aggregate(records, tasks);
    expect(data.header.agents).toEqual(['opencode · openrouter/a', 'opencode · openrouter/b']);
    const a = data.agents['opencode · openrouter/a'];
    const b = data.agents['opencode · openrouter/b'];
    expect(a.agent).toBe('opencode');
    expect(a.header.models).toEqual(['openrouter/a']);
    expect(a.scenarios.dev.pairs[0].costRatio).toBeCloseTo(0.5);
    expect(b.scenarios.dev.pairs[0].costRatio).toBeCloseTo(0.25);
    expect(a.scenarios.dev.arms.baseline.runs).toBe(1);
  });

  it('keeps claude and codex grouped by agent name only', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const data = aggregate([rec({ agent: 'claude', model: 'sonnet' }), rec({ agent: 'claude', model: 'opus', repeat: 2 }), rec({ agent: 'codex', model: 'gpt/high', costUsd: null })], tasks);
    expect(data.header.agents).toEqual(['claude', 'codex']);
  });

  it('renders one section per model labelled with agent and model, with real cost', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    const md = renderReport(aggregate([rec(), distillRec(), rec({ model: 'openrouter/b', costUsd: 4 }), distillRec({ model: 'openrouter/b', costUsd: 1 })], tasks));
    const a = md.indexOf('## Agent opencode · openrouter/a');
    const b = md.indexOf('## Agent opencode · openrouter/b');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(md.slice(a, b)).toContain('0.50x');
    expect(md.slice(b)).toContain('0.25x');
    expect(md.slice(a, b)).not.toContain('0.25x');
    expect(md.slice(a, b)).toContain('OpenCode. Cost is the USD OpenCode reports');
    expect(md.slice(a, b)).not.toContain('Cost: n/a');
    expect(md).toContain('| baseline | 1 | 0% (0) | 100% | $1.000');
  });

  it('report CLI filters by --agent opencode and --model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-report-oc-'));
    try {
      const results = join(dir, 'results');
      mkdirSync(results);
      const all = [rec(), rec({ model: 'openrouter/b' }), rec({ agent: 'claude', model: 'sonnet' })].map((r) => JSON.stringify(r));
      writeFileSync(join(results, 'runs.jsonl'), `${all.join('\n')}\n`);
      const run = (args: string[]) => spawnSync(process.execPath, [join(repo, 'report.mjs'), '--results', results, ...args], { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'home') } });
      expect(run(['--agent', 'opencode']).status).toBe(0);
      expect(JSON.parse(readFileSync(join(results, 'report.json'), 'utf8')).header.agents).toEqual(['opencode · openrouter/a', 'opencode · openrouter/b']);
      expect(run(['--agent', 'opencode', '--model', 'openrouter/b']).status).toBe(0);
      expect(JSON.parse(readFileSync(join(results, 'report.json'), 'utf8')).header.agents).toEqual(['opencode · openrouter/b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('bench runner with a fake opencode', () => {
  let dir: string;
  let results: string;
  let log: string;
  let npxLog: string;
  let home: string;
  let shims: string;
  let fake: string;

  const task = (id: string, doc: string, value: number) => ({ id, doc, question: `What is ${id}?`, expected: { type: 'number', value }, tags: ['simple'], source: 'test' });
  const docEntry = (id: string) => ({ id, url: `https://example.com/${id}.pdf`, sha256: sha, ext: 'pdf', license: 'test', title: id });

  function setup(behaviors: Record<string, unknown[]>, tasksList = [task('t1', 'd1', 5), task('t2', 'd2', 7)], extra: Rec = {}) {
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(['d1', 'd2'].map(docEntry)));
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasksList));
    writeFileSync(join(dir, 'cfg.json'), JSON.stringify({ log, npxLog, counter: join(dir, 'counter'), behaviors, ...extra }));
  }

  function bench(args: string[], model = MODEL, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${shims}:${process.env.PATH}`, HOME: home, DISTILL_BENCH_DIR: join(dir, 'bench'), FAKE_OPENCODE_CFG: join(dir, 'cfg.json'), ...extraEnv };
    for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_cache']) if (!(key in extraEnv)) delete env[key];
    return spawnSync(
      process.execPath,
      [join(repo, 'run.mjs'), '--agent', 'opencode', '--opencode-model', model, '--tasks-file', join(dir, 'tasks.json'), '--corpus-file', join(dir, 'corpus.json'), '--results', results, '--opencode-bin', fake, '--package', 'distill-llm@9.9.9', '--night', '2026-11-19', ...args],
      { encoding: 'utf8', env: env as NodeJS.ProcessEnv, timeout: 60_000 },
    );
  }

  const readLines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const records = () => readLines(join(results, 'runs.jsonl'));
  const calls = () => readLines(log);
  const npxCalls = () => readLines(npxLog);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-bench-oc-'));
    results = join(dir, 'results');
    log = join(dir, 'calls.jsonl');
    npxLog = join(dir, 'npx.jsonl');
    home = join(dir, 'real-home');
    shims = join(dir, 'shims');
    fake = join(dir, 'fake-opencode.mjs');
    mkdirSync(home);
    mkdirSync(shims);
    copyFileSync(join(repo, 'tests', 'fixtures', 'fake-opencode.mjs'), fake);
    copyFileSync(join(repo, 'tests', 'fixtures', 'fake-npx.mjs'), join(shims, 'npx'));
    chmodSync(fake, 0o755);
    chmodSync(join(shims, 'npx'), 0o755);
    const corpus = join(dir, 'bench', 'corpus');
    mkdirSync(corpus, { recursive: true });
    for (const id of ['d1', 'd2']) writeFileSync(join(corpus, `${id}.pdf`), `%PDF fake ${id}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs both arms end to end with real cost, isolation, and the install only on the distill arm', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }], 'd2.pdf|distill': [{ kind: 'ok', answer: '7', tools: ['mcp', 'read-converted', 'bash:ls'] }] });
    const out = bench([]);
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain('reports no cost');
    const recs = records();
    expect(recs).toHaveLength(4);
    expect(recs.every((r) => r.agent === 'opencode' && r.model === MODEL && r.ok === true && r.night === '2026-11-19')).toBe(true);
    expect(recs.find((r) => r.task === 't1' && r.arm === 'baseline')).toMatchObject({
      correct: true,
      answer: '5',
      package: null,
      numTurns: 2,
      usage: { input: 15802, output: 42, cacheCreation: 0, cacheRead: 15488 },
      toolCalls: { Bash: 1 },
      paths: ['bash-other'],
      distillUsed: false,
    });
    expect(recs.find((r) => r.task === 't1')?.costUsd).toBeCloseTo(0.0029303568, 10);
    expect(recs.find((r) => r.task === 't2' && r.arm === 'distill')).toMatchObject({
      package: 'distill-llm@9.9.9',
      distillUsed: true,
      paths: ['read', 'read-converted', 'mcp-distill', 'bash-other'],
      permissionDenials: 0,
    });
    const c = calls();
    expect(c).toHaveLength(4);
    for (const x of c) {
      expect(x.argv).toEqual(['run', '--standalone', '--auto', '--archived', '--format', 'json', '-m', MODEL, expect.stringContaining('in this folder')]);
      expect(x.env.HOME).toMatch(/distill-bench-run-[^/]+\/home$/);
      expect(x.env.XDG_CONFIG_HOME).toMatch(/distill-bench-run-[^/]+\/xdg-config$/);
      expect(x.env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'));
      expect(x.env.npm_config_cache).toBe(join(home, '.npm'));
      expect(x.env.DISTILL_CACHE_DIR).toMatch(/distill-bench-run-[^/]+\/cache$/);
      expect(existsSync(x.cwd)).toBe(false);
    }
    const baseline = c.filter((x) => x.key.endsWith('baseline'));
    const distill = c.filter((x) => x.key.endsWith('distill'));
    expect(baseline.every((x) => x.mcp === null && !x.skill && !x.plugin && x.files.length === 1)).toBe(true);
    expect(distill.every((x) => x.skill && x.plugin)).toBe(true);
    expect(distill.every((x) => x.mcp.mcp.servers.distill.environment.DISTILL_CACHE_DIR === x.env.DISTILL_CACHE_DIR)).toBe(true);
    expect(distill.every((x) => x.mcp.mcp.servers.distill.command.join(' ') === '/usr/bin/node /cache/distill-llm/dist/cli.js mcp')).toBe(true);
    const npx = npxCalls();
    expect(npx).toHaveLength(4);
    expect(npx.map((n) => n.argv.slice(0, 4)).sort()).toEqual([
      ['-y', 'distill-llm@9.9.9', 'agents', 'install'],
      ['-y', 'distill-llm@9.9.9', 'agents', 'install'],
      ['-y', 'distill-llm@9.9.9', 'hooks', 'install'],
      ['-y', 'distill-llm@9.9.9', 'hooks', 'install'],
    ]);
    expect(npx.every((n) => n.cwd.includes('distill-bench-run-') && n.cacheDir !== null && n.npmCache === join(home, '.npm'))).toBe(true);
    expect(existsSync(join(results, '.lock-opencode'))).toBe(false);
    expect(existsSync(join(results, '.lock'))).toBe(false);
  });

  it('keeps the real HOME and skips the isolation with --user-settings', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline', '--user-settings']);
    const [x] = calls();
    expect(x.env.HOME).toBe(home);
    expect(x.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(x.env.XDG_DATA_HOME).toBeUndefined();
    expect(records()[0].userSettings).toBe(true);
  });

  it('records an install failure as a run error and never starts opencode', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)], { npxFail: 'hooks' });
    bench(['--arms', 'baseline,distill']);
    const recs = records();
    expect(recs.filter((r) => r.arm === 'baseline')).toHaveLength(1);
    const failed = recs.filter((r) => r.arm === 'distill');
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.ok === false && r.correct === null && r.error === 'distill hook install failed: npm error network down')).toBe(true);
    expect(calls().filter((x) => x.key.endsWith('distill'))).toHaveLength(0);
  });

  it('records an opencode error event as a failed run and retries once', () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'fail' }, { kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline']);
    const recs = records();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: false, attempt: 1, error: 'opencode reported error', correct: null });
    expect(recs[1]).toMatchObject({ ok: true, attempt: 2, correct: true });
  });

  it('records a refused distill MCP call as mcp-denied', () => {
    setup({ 'd1.pdf|distill': [{ kind: 'ok', answer: '5', tools: ['mcp-denied'] }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'distill']);
    expect(records()[0]).toMatchObject({ distillUsed: false, permissionDenials: 1, paths: ['mcp-denied'] });
  });

  it('keeps models apart when resuming', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    expect(bench(['--arms', 'baseline', '--resume']).stdout).toContain('Resume: 0 of 1');
    expect(bench(['--arms', 'baseline', '--resume']).stdout).toContain('Resume: 1 of 1');
    expect(bench(['--arms', 'baseline', '--resume'], 'openrouter/other').stdout).toContain('Resume: 0 of 1');
    expect(records().map((r) => r.model)).toEqual([MODEL, 'openrouter/other']);
  });

  it('stops on the USD budget and honours --max-runs', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5), task('t2', 'd2', 5)]);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'runs.jsonl'), `${JSON.stringify({ night: '2026-11-19', task: 'old', arm: 'baseline', repeat: 1, model: MODEL, agent: 'opencode', scenario: 'dev', ok: true, attempt: 1, costUsd: 999 })}\n`);
    expect(bench(['--arms', 'baseline', '--max-cost-usd', '1']).stdout).toContain('Stopping: spent');
    expect(records()).toHaveLength(1);
    rmSync(join(results, 'runs.jsonl'));
    expect(bench(['--arms', 'baseline', '--max-runs', '1']).stdout).toContain('Stopping: reached --max-runs 1');
  });

  it('adds the clean scenario shims to the PATH', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline', '--scenario', 'clean']);
    expect(calls()[0].pathHead).toMatch(/shims$/);
    expect(records()[0].scenario).toBe('clean');
  });

  it('refuses to start while another opencode runner holds its lock', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] });
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, '.lock-opencode'), String(process.pid));
    const out = bench([]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Another benchmark runner');
  });

  it('fails the dry run without a model, and plans without calling anything with one', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] });
    const missing = spawnSync(process.execPath, [join(repo, 'run.mjs'), '--dry-run', '--agent', 'opencode', '--tasks-file', join(dir, 'tasks.json'), '--corpus-file', join(dir, 'corpus.json')], { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'bench') } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--opencode-model');
    const out = bench(['--dry-run', '--scenario', 'both', '--paired', '--max-runs', '6']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('6 runs planned');
    expect(calls()).toHaveLength(0);
    expect(npxCalls()).toHaveLength(0);
  });
});
