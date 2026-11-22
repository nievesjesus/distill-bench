import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildEnv } from './env.mjs';
import { defaultExec, failureDetail, maskUrls, parseDryRun, SKILL_FILE } from './install-plan.mjs';

export { parseDryRun };

const DISTILL = /distill/i;
const DENIAL = /approv|permission|denied|declined|not allowed|rejected|refused|blocked|cancel/i;
const BUILTIN = { read: 'Read', bash: 'Bash', shell: 'Bash', grep: 'Grep', glob: 'Glob' };
const MCP_CALL = /\btools\.distill\.([A-Za-z0-9_]+)\s*\(/g;

function realHome(baseEnv = {}) {
  return typeof baseEnv.HOME === 'string' && baseEnv.HOME !== '' ? baseEnv.HOME : homedir();
}

function setting(baseEnv, key, fallback) {
  return typeof baseEnv[key] === 'string' && baseEnv[key].trim() !== '' ? baseEnv[key].trim() : fallback;
}

function buildIsolatedEnv({ root, userSettings = false, ...rest }) {
  const env = buildEnv(rest);
  if (userSettings === true || typeof root !== 'string') return env;
  const baseEnv = rest.baseEnv ?? {};
  const home = realHome(baseEnv);
  const fakeHome = join(root, 'home');
  const config = join(root, 'xdg-config');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(config, { recursive: true });
  env.XDG_DATA_HOME = setting(baseEnv, 'XDG_DATA_HOME', join(home, '.local', 'share'));
  env.XDG_CACHE_HOME = setting(baseEnv, 'XDG_CACHE_HOME', join(home, '.cache'));
  env.npm_config_cache = setting(baseEnv, 'npm_config_cache', join(home, '.npm'));
  env.HOME = fakeHome;
  env.XDG_CONFIG_HOME = config;
  return env;
}

function withProjectPwd(env, root) {
  if (typeof root === 'string') env.PWD = join(root, 'project');
  return env;
}

export function buildOpencodeEnv({ root, userSettings = false, ...rest }) {
  return withProjectPwd(buildIsolatedEnv({ root, userSettings, ...rest }), root);
}

export function buildArgs({ prompt, model }) {
  return ['run', '--standalone', '--auto', '--archived', '--format', 'json', '-m', model, prompt];
}

function toolName(tool) {
  if (typeof tool !== 'string') return 'unknown';
  if (BUILTIN[tool] !== undefined) return BUILTIN[tool];
  if (DISTILL.test(tool)) return `mcp__opencode__${tool}`;
  return tool;
}

function errorText(state) {
  const error = state.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (error !== undefined && error !== null) return JSON.stringify(error);
  return typeof state.output === 'string' ? state.output : '';
}

function toolFailure(state) {
  if (typeof state !== 'object' || state === null) return false;
  return (state.status !== undefined && state.status !== 'completed') || (state.error !== undefined && state.error !== null);
}

function readConverted(input, output, cacheDirs) {
  const path = [input?.path, input?.filePath, input?.file_path].find((value) => typeof value === 'string') ?? '';
  const text = typeof output === 'string' ? output : '';
  if (text.includes('[distill]') || text.includes('distill converted')) return true;
  const dirs = cacheDirs.filter((dir) => dir !== '').flatMap((dir) => (dir.startsWith('/private/') ? [dir, dir.slice('/private'.length)] : [dir, `/private${dir}`]));
  return dirs.some((dir) => path.includes(dir) || text.includes(dir));
}

function executeUses(input, state, id) {
  const code = typeof input.code === 'string' ? input.code : '';
  const names = [...code.matchAll(MCP_CALL)].map((match) => `mcp__distill__${match[1]}`);
  if (names.length === 0) return [{ name: 'execute', input, ...id }];
  const denied = toolFailure(state) && (state.status === 'denied' || DENIAL.test(errorText(state)));
  return names.map((name) => ({ name, input, ...id, ...(denied ? { denied: true } : {}) }));
}

function describeError(error) {
  let text;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    const type = typeof error.type === 'string' ? error.type : 'error';
    const status = typeof error.status === 'number' ? ` (${error.status})` : '';
    text = `${type}${status}: ${error.message}`;
  } else {
    text = typeof error === 'string' ? error : (JSON.stringify(error) ?? 'unknown error');
  }
  return maskUrls(text);
}

export function parseOpencodeStream(raw, { cacheDirs = [] } = {}) {
  let lastText = '';
  let malformed = 0;
  let any = false;
  let sawError = false;
  let errorMessage;
  let turns = 0;
  let converted = false;
  let costSeen = false;
  let cost = 0;
  const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const toolCalls = {};
  const slots = [];
  const indexById = new Map();
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
    const part = typeof event.part === 'object' && event.part !== null ? event.part : {};
    if (event.type === 'step_start') {
      turns += 1;
      any = true;
    } else if (event.type === 'step_finish') {
      any = true;
      if (typeof part.cost === 'number') {
        costSeen = true;
        cost += part.cost;
      }
      const tokens = part.tokens ?? {};
      usage.input += tokens.input ?? 0;
      usage.output += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
      usage.cacheRead += tokens.cache?.read ?? 0;
      usage.cacheCreation += tokens.cache?.write ?? 0;
    } else if (event.type === 'text') {
      any = true;
      if (typeof part.text === 'string') lastText = part.text;
    } else if (event.type === 'error') {
      any = true;
      sawError = true;
      if (errorMessage === undefined) errorMessage = describeError(event.error);
    } else if (event.type === 'tool_use' && typeof part.tool === 'string') {
      any = true;
      const state = typeof part.state === 'object' && part.state !== null ? part.state : {};
      const input = typeof state.input === 'object' && state.input !== null ? state.input : {};
      const name = toolName(part.tool);
      const id = typeof part.id === 'string' ? { id: part.id } : {};
      let uses;
      if (part.tool === 'execute') {
        uses = executeUses(input, state, id);
      } else {
        const use = { name, input, ...id };
        if (name.startsWith('mcp__') && toolFailure(state) && (state.status === 'denied' || DENIAL.test(errorText(state)))) use.denied = true;
        if (name === 'Read' && use.denied !== true && readConverted(input, state.output, cacheDirs)) converted = true;
        uses = [use];
      }
      if (typeof part.id === 'string' && indexById.has(part.id)) {
        slots[indexById.get(part.id)] = uses;
        continue;
      }
      if (typeof part.id === 'string') indexById.set(part.id, slots.length);
      slots.push(uses);
      const counted = part.tool === 'execute' ? 'execute' : name;
      toolCalls[counted] = (toolCalls[counted] ?? 0) + 1;
    }
  }
  const toolUses = slots.flat();
  const deniedToolUses = toolUses.filter((use) => use.denied === true).map((use) => use.name);
  const toolSignal = toolUses.some((use) => use.denied !== true && (DISTILL.test(use.name) || (use.name === 'Bash' && /distill-llm/.test(use.input?.command ?? ''))));
  const result = any ? { failed: sawError } : null;
  return { result, errorMessage, lastText, malformed, toolCalls, toolUses, converted, distillUsed: converted || toolSignal, deniedToolUses, permissionDenials: deniedToolUses.length, usage, turns, costUsd: costSeen ? cost : null };
}

export function summarizeOpencode(parsed) {
  const { result } = parsed;
  if (result === null) return null;
  return {
    isError: result.failed,
    subtype: result.failed ? 'error' : 'success',
    text: parsed.lastText,
    numTurns: parsed.turns,
    costUsd: parsed.costUsd,
    durationMs: null,
    usage: parsed.usage,
  };
}

export function mcpConfig({ command, cacheDir }) {
  return { mcp: { servers: { distill: { type: 'local', command, environment: { DISTILL_CACHE_DIR: cacheDir } } } } };
}

export function prepareOpencode({ arm, project, env, packageSpec, cacheDir, exec = defaultExec }) {
  if (arm !== 'distill') return null;
  const run = (args) => exec('npx', ['-y', packageSpec, ...args], { cwd: project, env });
  try {
    run(['hooks', 'install', '--opencode', '--project', '--yes']);
  } catch (error) {
    return `distill hook install failed: ${failureDetail(error)}`;
  }
  let plan;
  try {
    plan = parseDryRun(run(['agents', 'install', '--opencode', '--project', '--dry-run']));
  } catch (error) {
    return `distill agents install --dry-run failed: ${failureDetail(error)}`;
  }
  const command = plan.command ?? ['npx', '-y', packageSpec, 'mcp'];
  try {
    writeFileSync(join(project, 'opencode.jsonc'), `${JSON.stringify(mcpConfig({ command, cacheDir }), null, 2)}\n`);
    if (plan.skill !== null) {
      const skill = join(project, ...SKILL_FILE);
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, plan.skill);
    }
  } catch (error) {
    return `could not write the distill project files: ${failureDetail(error)}`;
  }
  return null;
}

export function resolveCacheDirs(cacheDir) {
  const dirs = [cacheDir];
  try {
    const real = realpathSync(cacheDir);
    if (real !== cacheDir) dirs.push(real);
  } catch {}
  return dirs;
}

export const opencodeAgent = {
  name: 'opencode',
  hasCost: true,
  usesPluginDir: false,
  resolveBin: (args, env) => args['opencode-bin'] || env.DISTILL_BENCH_OPENCODE || 'opencode',
  resolveModel: (args) => ({ model: args['opencode-model'], reasoning: null }),
  modelLabel: ({ model }) => model,
  buildArgs,
  buildEnv: buildOpencodeEnv,
  prepare: prepareOpencode,
  parse(stdout, context = {}) {
    const parsed = parseOpencodeStream(stdout, { cacheDirs: context.cacheDirs ?? [] });
    return { parsed, summary: summarizeOpencode(parsed) };
  },
};
