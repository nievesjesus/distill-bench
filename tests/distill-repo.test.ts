import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', 'distill-repo.mjs')).href);

type Call = { command: string; args: string[] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-bench-repo-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cloneStub(calls: Call[], opts: { fail?: boolean; withPlugin?: boolean } = {}) {
  return (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === 'git') {
      if (opts.fail) throw new Error('fatal: Remote branch v9.9.9 not found');
      const target = args[args.length - 1];
      mkdirSync(opts.withPlugin === false ? target : join(target, 'plugins', 'distill'), { recursive: true });
      return '';
    }
    return '';
  };
}

describe('packageVersion', () => {
  it('asks npm for a registry spec', async () => {
    const { packageVersion } = await load();
    const calls: Call[] = [];
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args });
      return 'npm warn something\n0.7.0\n';
    };
    expect(packageVersion('distill-llm@latest', exec)).toBe('0.7.0');
    expect(calls[0]).toEqual({ command: 'npm', args: ['view', 'distill-llm@latest', 'version'] });
  });

  it('reads the version from a tarball', async () => {
    const { packageVersion } = await load();
    const tgz = join(dir, 'distill-llm-1.2.3.tgz');
    writeFileSync(tgz, 'x');
    const calls: Call[] = [];
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args });
      return JSON.stringify({ name: 'distill-llm', version: '1.2.3' });
    };
    expect(packageVersion(tgz, exec)).toBe('1.2.3');
    expect(calls[0]).toEqual({ command: 'tar', args: ['-xOzf', tgz, 'package/package.json'] });
  });

  it('rejects a non-version answer', async () => {
    const { packageVersion } = await load();
    expect(() => packageVersion('nope@1', () => 'not a version')).toThrow('Could not resolve');
  });
});

describe('ensureDistillRepo', () => {
  it('shallow-clones the version tag into distill-<version> once', async () => {
    const { ensureDistillRepo, DISTILL_GIT_URL } = await load();
    const calls: Call[] = [];
    const exec = cloneStub(calls);
    const first = ensureDistillRepo('9.9.9', { exec, root: dir });
    expect(first).toBe(join(dir, 'distill-9.9.9'));
    expect(existsSync(join(first, 'plugins', 'distill'))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('git');
    expect(calls[0].args.slice(0, 6)).toEqual(['clone', '--quiet', '--depth', '1', '--branch', 'v9.9.9']);
    expect(calls[0].args[6]).toBe(DISTILL_GIT_URL);
    expect(DISTILL_GIT_URL).toBe('https://github.com/nievesjesus/distill');
    expect(ensureDistillRepo('9.9.9', { exec, root: dir })).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('explains a failed clone and leaves nothing behind', async () => {
    const { ensureDistillRepo } = await load();
    expect(() => ensureDistillRepo('9.9.9', { exec: cloneStub([], { fail: true }), root: dir })).toThrow('--distill-repo');
    expect(existsSync(join(dir, 'distill-9.9.9'))).toBe(false);
  });

  it('rejects a checkout without the plugin', async () => {
    const { ensureDistillRepo } = await load();
    expect(() => ensureDistillRepo('9.9.9', { exec: cloneStub([], { withPlugin: false }), root: dir })).toThrow('no plugins/distill');
    expect(existsSync(join(dir, 'distill-9.9.9'))).toBe(false);
  });
});

describe('resolvePluginDir', () => {
  it('uses --distill-repo without touching npm or git', async () => {
    const { resolvePluginDir } = await load();
    mkdirSync(join(dir, 'checkout', 'plugins', 'distill'), { recursive: true });
    const calls: Call[] = [];
    expect(resolvePluginDir({ distillRepo: join(dir, 'checkout'), packageSpec: 'x', exec: cloneStub(calls), root: dir })).toBe(join(dir, 'checkout', 'plugins', 'distill'));
    expect(calls).toHaveLength(0);
  });

  it('rejects a --distill-repo that is not a distill checkout', async () => {
    const { resolvePluginDir } = await load();
    expect(() => resolvePluginDir({ distillRepo: dir, packageSpec: 'x' })).toThrow('must be a distill checkout');
  });

  it('resolves the package version and clones its tag by default', async () => {
    const { resolvePluginDir } = await load();
    const calls: Call[] = [];
    const base = cloneStub(calls);
    const exec = (command: string, args: string[]) => (command === 'npm' ? '9.9.9\n' : base(command, args));
    expect(resolvePluginDir({ packageSpec: 'distill-llm@latest', exec, root: dir })).toBe(join(dir, 'distill-9.9.9', 'plugins', 'distill'));
    expect(calls.map((c) => c.command)).toEqual(['git']);
  });
});
