import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logsDir, repoRoot } from './paths.mjs';

export const LABEL = 'dev.distill-bench.nightly';

export function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderPlist(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing plist value ${key}`);
    return key.endsWith('_XML') ? values[key] : escapeXml(values[key]);
  });
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FLAGS = new Set(['weekday', 'hour', 'minute', 'budget']);
const SWITCHES = new Set(['yes', 'dry-run']);

function intFlag(name, raw, min, max) {
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`--${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  return Number(raw);
}

export function parseScheduleArgs(argv) {
  const options = { hour: 2, minute: 30 };
  const switches = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (SWITCHES.has(name) && eq === -1) {
      switches.add(name);
      continue;
    }
    if (!FLAGS.has(name)) throw new Error(`Unknown flag --${name}`);
    let raw;
    if (eq !== -1) raw = arg.slice(eq + 1);
    else {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} needs a value`);
      i += 1;
    }
    if (name === 'weekday') options.weekday = intFlag(name, raw, 0, 6);
    else if (name === 'hour') options.hour = intFlag(name, raw, 0, 23);
    else if (name === 'minute') options.minute = intFlag(name, raw, 0, 59);
    else {
      const budget = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(budget) || budget <= 0) throw new Error(`--budget must be a positive number of USD, got "${raw}"`);
      options.budget = budget;
    }
  }
  return { options, switches };
}

export function describeSchedule({ weekday, hour = 2, minute = 30 } = {}) {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return weekday === undefined ? `every day at ${time}` : `every ${DAY_NAMES[weekday]} at ${time}`;
}

export function launchdPaths(env = process.env) {
  const home = homedir();
  return {
    home,
    root: repoRoot,
    script: join(repoRoot, 'nightly.sh'),
    logDir: logsDir(env),
    template: join(repoRoot, 'launchd', 'dev.distill-bench.nightly.plist.template'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

export function plistFor(paths, { weekday, hour = 2, minute = 30, budget } = {}) {
  const calendar = [];
  if (weekday !== undefined) calendar.push(['Weekday', weekday]);
  calendar.push(['Hour', hour], ['Minute', minute]);
  const CALENDAR_XML = calendar.map(([key, value]) => `    <key>${key}</key>\n    <integer>${Number(value)}</integer>`).join('\n');
  const ENV_XML = budget === undefined ? '' : `\n    <key>DISTILL_BENCH_BUDGET</key>\n    <string>${escapeXml(String(budget))}</string>`;
  return renderPlist(readFileSync(paths.template, 'utf8'), { SCRIPT: paths.script, ROOT: paths.root, HOME: paths.home, LOG_DIR: paths.logDir, CALENDAR_XML, ENV_XML });
}
