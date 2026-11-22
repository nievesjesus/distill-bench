import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', name)).href);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-bench-asr-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('asrDir', () => {
  it('defaults to asr-cache under the bench dir and honours DISTILL_BENCH_ASR_DIR', async () => {
    const { asrDir } = await load('paths.mjs');
    expect(asrDir({ DISTILL_BENCH_DIR: '/b' })).toBe('/b/asr-cache');
    expect(asrDir({ DISTILL_BENCH_DIR: '/b', DISTILL_BENCH_ASR_DIR: ' /x/asr ' })).toBe('/x/asr');
    expect(asrDir({ DISTILL_BENCH_DIR: '/b', DISTILL_BENCH_ASR_DIR: '  ' })).toBe('/b/asr-cache');
  });
});

describe('shared speech models', () => {
  it('needs them for audio and video tasks only', async () => {
    const { taskNeedsAsr } = await load('asr.mjs');
    expect(taskNeedsAsr({ tags: ['simple', 'audio'] })).toBe(true);
    expect(taskNeedsAsr({ tags: ['video'] })).toBe(true);
    expect(taskNeedsAsr({ tags: ['simple', 'table'] })).toBe(false);
  });

  it('links the runtime and model folders of the cache dir to the shared dir', async () => {
    const { linkSharedAsr } = await load('asr.mjs');
    const cache = join(dir, 'cache');
    const shared = join(dir, 'shared');
    mkdirSync(cache);
    linkSharedAsr(cache, shared);
    for (const name of ['asr', 'asr-models']) {
      expect(lstatSync(join(cache, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(cache, name))).toBe(join(shared, name));
      expect(existsSync(join(shared, name))).toBe(true);
    }
  });

  it('detects installed models from the runtime package and a non-empty models folder', async () => {
    const { asrModelsInstalled, asrWarning } = await load('asr.mjs');
    expect(asrModelsInstalled(dir)).toBe(false);
    mkdirSync(join(dir, 'asr', 'node_modules'), { recursive: true });
    expect(asrModelsInstalled(dir)).toBe(false);
    mkdirSync(join(dir, 'asr-models', 'm'), { recursive: true });
    expect(asrModelsInstalled(dir)).toBe(true);
    expect(asrWarning('/x')).toContain('npm run bench:asr-install');
  });
});

describe('bench:asr-install', () => {
  it('runs distill asr install with DISTILL_CACHE_DIR set to the shared dir', async () => {
    const { asrInstallCommand } = await load('asr-install.mjs');
    const plan = asrInstallCommand([], { DISTILL_BENCH_DIR: '/b', PATH: '/bin', DISTILL_CACHE_DIR: '/other' });
    expect(plan.command).toBe('npx');
    expect(plan.args).toEqual(['-y', 'distill-llm@latest', 'asr', 'install']);
    expect(plan.env).toMatchObject({ DISTILL_CACHE_DIR: '/b/asr-cache', PATH: '/bin' });
  });

  it('accepts --package and the override dir, and rejects anything else', async () => {
    const { asrInstallCommand } = await load('asr-install.mjs');
    const plan = asrInstallCommand(['--', '--package', 'distill-llm@0.9.0'], { DISTILL_BENCH_ASR_DIR: '/s' });
    expect(plan.args).toEqual(['-y', 'distill-llm@0.9.0', 'asr', 'install']);
    expect(plan.env.DISTILL_CACHE_DIR).toBe('/s');
    expect(() => asrInstallCommand(['--nope'])).toThrow('Unknown option --nope');
    expect(() => asrInstallCommand(['--package'])).toThrow('--package needs a value');
  });
});
