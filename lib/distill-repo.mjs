import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { benchDir } from './paths.mjs';

export const DISTILL_GIT_URL = 'https://github.com/nievesjesus/distill';

function defaultExec(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

export function isTarball(spec) {
  return /\.(tgz|tar\.gz)$/.test(spec) && existsSync(spec);
}

export function packageVersion(spec, exec = defaultExec) {
  if (isTarball(spec)) {
    const json = exec('tar', ['-xOzf', spec, 'package/package.json']);
    const version = JSON.parse(json).version;
    if (typeof version !== 'string') throw new Error(`No version in ${spec}`);
    return version;
  }
  const version = exec('npm', ['view', spec, 'version']).trim().split('\n').pop().trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Could not resolve the version of ${spec}`);
  return version;
}

export function ensureDistillRepo(version, { exec = defaultExec, root = benchDir(), url = DISTILL_GIT_URL } = {}) {
  const dir = join(root, `distill-${version}`);
  if (existsSync(join(dir, 'plugins', 'distill'))) return dir;
  mkdirSync(root, { recursive: true });
  const temp = `${dir}.part-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  try {
    exec('git', ['clone', '--quiet', '--depth', '1', '--branch', `v${version}`, url, temp]);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`Could not clone ${url} at v${version} (${detail}). Pass --distill-repo <path> to use a local checkout.`);
  }
  if (!existsSync(join(temp, 'plugins', 'distill'))) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(`${url} at v${version} has no plugins/distill. Pass --distill-repo <path>.`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(temp, dir);
  return dir;
}

export function resolvePluginDir({ distillRepo, packageSpec, exec, root }) {
  if (distillRepo) {
    const dir = join(distillRepo, 'plugins', 'distill');
    if (!existsSync(dir)) throw new Error(`${dir} does not exist; --distill-repo must be a distill checkout.`);
    return dir;
  }
  const version = packageVersion(packageSpec, exec);
  return join(ensureDistillRepo(version, { exec, root }), 'plugins', 'distill');
}
