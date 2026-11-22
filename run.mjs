import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent } from './lib/agents/index.mjs';
import { parseArgs } from './lib/args.mjs';
import { acquireLock } from './lib/lock.mjs';
import { buildPlan, budgetReached, finishedKeys, limitPaired, nightCost, unitKey } from './lib/plan.mjs';
import { resolvePluginDir } from './lib/distill-repo.mjs';
import { corpusDir, resultsDir } from './lib/paths.mjs';
import { runWithRetry } from './lib/runner.mjs';
import { docFileName, loadCorpus, loadTasks, selectTasks, validate } from './lib/tasks.mjs';

function localNight() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readRecords(file) {
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

function resolveDocPath(doc, env) {
  const file = join(corpusDir(env), docFileName(doc));
  return existsSync(file) ? file : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const corpus = loadCorpus(args['corpus-file'] || undefined);
  const allTasks = loadTasks(args['tasks-file'] || undefined);
  const problems = validate(corpus, allTasks);
  if (problems.length > 0) throw new Error(`Invalid corpus or tasks:\n${problems.join('\n')}`);
  const tasks = selectTasks(allTasks, args.tasks);
  if (tasks.length === 0) throw new Error(`No tasks match "${args.tasks}"`);
  const docs = new Map(corpus.map((doc) => [doc.id, doc]));
  const night = args.night || localNight();
  const seed = args.seed || night;
  const results = args.results || resultsDir(env);
  mkdirSync(results, { recursive: true });
  const runsFile = join(results, 'runs.jsonl');
  const agent = getAgent(args.agent);
  const bin = agent.resolveBin(args, env);
  const modelSettings = agent.resolveModel(args, env);
  const modelLabel = agent.modelLabel(modelSettings);
  if (!agent.hasCost) {
    console.log(`${agent.name} reports no cost in USD: --max-cost-usd and --run-budget-usd do not apply. Runs are capped by --max-runs ${args['max-runs']}${args['max-runs-defaulted'] ? ' (default for this agent)' : ''}.`);
  }

  const scenarios = args.scenario === 'both' ? ['dev', 'clean'] : [args.scenario];
  let plan = buildPlan({ tasks, arms: args.arms, repeats: args.repeats, seed, scenarios });
  const pairUp = (units) => (args.paired ? limitPaired(units, args['max-runs']) : units);
  if (args['dry-run']) {
    plan = pairUp(plan);
    if (!agent.hasCost) plan = plan.slice(0, args['max-runs']);
    for (const unit of plan) console.log(`${unit.task.id} ${unit.arm} ${unit.scenario} #${unit.repeat}`);
    console.log(`${plan.length} runs planned for ${night}`);
    return;
  }

  const release = acquireLock(join(results, agent.name === 'claude' ? '.lock' : `.lock-${agent.name}`));
  if (release === null) throw new Error('Another benchmark runner holds the lock.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }

  try {
    const existing = readRecords(runsFile);
    if (args.resume) {
      const done = finishedKeys(existing);
      const before = plan.length;
      plan = plan.filter((unit) => !done.has(unitKey(night, unit.task.id, unit.arm, unit.repeat, modelLabel, unit.scenario, agent.name)));
      console.log(`Resume: ${before - plan.length} of ${before} runs already done for ${night}`);
    }
    plan = pairUp(plan);
    const spent = Object.fromEntries(scenarios.map((scenario) => [scenario, nightCost(existing, night, scenario, agent.name)]));
    const limit = args['max-cost-usd'] / scenarios.length;
    const exhausted = new Set();
    const spentLabel = () => (!agent.hasCost ? 'n/a' :scenarios.length === 1 ? `$${spent[scenarios[0]].toFixed(2)}` : scenarios.map((scenario) => `$${spent[scenario].toFixed(2)} ${scenario}`).join(', '));
    const pluginDir = args.arms.includes('distill') && agent.usesPluginDir !== false ? resolvePluginDir({ distillRepo: args['distill-repo'], packageSpec: args.package }) : null;
    if (pluginDir !== null) console.log(`distill plugin: ${pluginDir}`);
    const options = {
      agent: agent.name,
      bin,
      model: modelSettings.model,
      reasoning: modelSettings.reasoning,
      night,
      packageSpec: args.package,
      pluginDir,
      maxTurns: args['max-turns'],
      runBudgetUsd: args['run-budget-usd'],
      timeoutMs: args['timeout-ms'],
      baseEnv: env,
      keep: args.keep,
      userSettings: args['user-settings'],
    };
    let started = 0;
    let failures = 0;
    for (const unit of plan) {
      if (started >= args['max-runs']) {
        console.log(`Stopping: reached --max-runs ${args['max-runs']}`);
        break;
      }
      if (budgetReached(spent[unit.scenario], limit)) {
        exhausted.add(unit.scenario);
        if (exhausted.size === scenarios.length) {
          console.log(`Stopping: spent ${spentLabel()} of the $${args['max-cost-usd']} budget for ${night}`);
          break;
        }
        continue;
      }
      const doc = docs.get(unit.task.doc);
      const docPath = resolveDocPath(doc, env);
      if (docPath === null) {
        console.error(`Skipping ${unit.task.id}: document ${doc.id} is not available (run bench:fetch)`);
        continue;
      }
      started += 1;
      const final = await runWithRetry({ task: unit.task, doc, docPath, arm: unit.arm, repeat: unit.repeat, scenario: unit.scenario }, options, (record) => {
        appendFileSync(runsFile, `${JSON.stringify(record)}\n`);
        if (typeof record.costUsd === 'number') spent[unit.scenario] += record.costUsd;
      });
      if (!final.ok) failures += 1;
      const verdict = final.ok ? (final.correct === true ? 'correct' : final.correct === false ? 'wrong' : 'no answer') : `failed (${final.error})`;
      console.log(`[${started}/${plan.length}] ${unit.task.id} ${unit.arm} ${unit.scenario} #${unit.repeat}: ${verdict} ${typeof final.costUsd === 'number' ? `$${final.costUsd.toFixed(3)}` : 'n/a'}`);
    }
    console.log(`Done: ${started} runs, ${failures} failed, ${spentLabel()} spent tonight, results in ${runsFile}`);
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
