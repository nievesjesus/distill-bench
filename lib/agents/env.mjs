import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { PDF_TOOLS } from '../classify.mjs';

export function writeShims(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of PDF_TOOLS) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name}: command not found" >&2\nexit 127\n`);
    chmodSync(file, 0o755);
  }
}

export function buildEnv({ baseEnv, arm, packageSpec, cacheDir, scenario = 'dev', shimDir }) {
  const env = { ...baseEnv };
  if (scenario === 'clean' && shimDir) env.PATH = `${shimDir}${delimiter}${baseEnv.PATH ?? ''}`;
  delete env.DISTILL_PLUGIN_PACKAGE;
  delete env.DISTILL_CACHE_DIR;
  env.DISTILL_CACHE_DIR = cacheDir;
  if (scenario === 'clean') env.PYTHONNOUSERSITE = '1';
  if (arm === 'distill') env.DISTILL_PLUGIN_PACKAGE = packageSpec;
  return env;
}
