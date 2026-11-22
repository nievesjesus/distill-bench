import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, DISTILL_MCP_RULE } from './agents/claude.mjs';
import { buildEnv, writeShims } from './agents/env.mjs';
import { getAgent } from './agents/index.mjs';
import { classifyPaths } from './classify.mjs';
import { gradeReply } from './grade.mjs';
import { docFileName } from './tasks.mjs';

export { buildArgs, buildEnv, DISTILL_MCP_RULE, writeShims };

const OUTPUT_CAP = 128 * 1024 * 1024;

export function buildPrompt(docName, question) {
  return `Answer this question about the file ${docName} in this folder: ${question} Finish your reply with one line: ANSWER: <answer>.`;
}

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function execute(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let done = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child, 'SIGKILL');
      resolve({ stdout, stderr, code, timedOut, spawnError });
    };
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export async function runOnce(spec, options) {
  const { task, doc, docPath, arm, repeat, attempt, scenario = 'dev' } = spec;
  const { model, reasoning = null, night, packageSpec, pluginDir, maxTurns, runBudgetUsd, timeoutMs, baseEnv, keep, userSettings = false } = options;
  const agent = getAgent(options.agent);
  const bin = options.bin ?? options.claude;
  const root = mkdtempSync(join(tmpdir(), 'distill-bench-run-'));
  const project = join(root, 'project');
  const cacheDir = join(root, 'cache');
  mkdirSync(project);
  mkdirSync(cacheDir);
  const shimDir = join(root, 'shims');
  if (scenario === 'clean') writeShims(shimDir);
  const docName = docFileName(doc);
  copyFileSync(docPath, join(project, docName));
  const prompt = buildPrompt(docName, task.question);
  const args = agent.buildArgs({ prompt, model, reasoning, arm, pluginDir, packageSpec, cacheDir, scenario, shimDir, baseEnv, maxTurns, runBudgetUsd, userSettings });
  const env = agent.buildEnv({ baseEnv, arm, packageSpec, cacheDir, scenario, shimDir, root, userSettings });
  const started = Date.now();
  let outcome;
  try {
    outcome = await execute(bin, args, { cwd: project, env, timeoutMs });
  } finally {
    if (keep !== true) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const wall = Date.now() - started;
  const { parsed, summary } = agent.parse(outcome.stdout);
  let error;
  if (outcome.spawnError) error = `spawn failed: ${outcome.spawnError}`;
  else if (outcome.timedOut) error = `timed out after ${timeoutMs} ms`;
  else if (outcome.code !== 0) error = `exit code ${outcome.code}`;
  else if (summary === null) error = 'no result event in output';
  else if (summary.isError) error = `${agent.name} reported ${summary.subtype ?? 'error'}`;
  const ok = error === undefined;
  const text = summary?.text ?? parsed.lastText;
  const graded = ok ? gradeReply(text, task.expected) : { answer: null, correct: null };
  const record = {
    night,
    ts: new Date().toISOString(),
    task: task.id,
    doc: task.doc,
    arm,
    agent: agent.name,
    scenario,
    model: agent.modelLabel({ model, reasoning }),
    package: arm === 'distill' ? packageSpec : null,
    repeat,
    attempt,
    ok,
    timedOut: outcome.timedOut,
    durationMs: summary?.durationMs ?? wall,
    numTurns: summary?.numTurns ?? null,
    costUsd: agent.hasCost ? (summary?.costUsd ?? 0) : null,
    usage: summary?.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    toolCalls: parsed.toolCalls,
    distillUsed: parsed.distillUsed,
    permissionDenials: parsed.permissionDenials,
    userSettings: userSettings === true,
    paths: classifyPaths(parsed),
    answer: graded.answer,
    correct: graded.correct,
  };
  if (!ok) {
    record.error = error;
    const tail = outcome.stderr.trim().split('\n').slice(-3).join(' | ');
    if (tail !== '') record.stderrTail = tail.slice(0, 500);
  }
  return record;
}

export async function runWithRetry(spec, options, onRecord) {
  const first = await runOnce({ ...spec, attempt: 1 }, options);
  onRecord(first);
  if (first.ok) return first;
  const second = await runOnce({ ...spec, attempt: 2 }, options);
  onRecord(second);
  return second;
}
