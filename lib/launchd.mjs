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
    return escapeXml(values[key]);
  });
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

export function plistFor(paths) {
  return renderPlist(readFileSync(paths.template, 'utf8'), { SCRIPT: paths.script, ROOT: paths.root, HOME: paths.home, LOG_DIR: paths.logDir });
}
