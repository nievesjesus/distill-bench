import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', name)).href);

const doc = { id: 'a', url: 'https://example.com/a.pdf', sha256: 'a'.repeat(64), ext: 'pdf', license: 'PD', title: 'A' };
const task = { id: 't1', doc: 'a', question: 'q?', expected: { type: 'number', value: 1 }, tags: ['simple'], source: 'p1' };

describe('shipped corpus and tasks', () => {
  it('validate with no errors', async () => {
    const { loadCorpus, loadTasks, validate } = await load('tasks.mjs');
    expect(validate(loadCorpus(), loadTasks())).toEqual([]);
  });

  it('cover every tag and keep the size in range', async () => {
    const { loadCorpus, loadTasks, TAGS } = await load('tasks.mjs');
    const tasks = loadTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(35);
    expect(loadCorpus().length).toBeGreaterThanOrEqual(20);
    for (const tag of TAGS) expect(tasks.some((t: { tags: string[] }) => t.tags.includes(tag))).toBe(true);
  });

  it('only stores https urls with a license', async () => {
    const { loadCorpus } = await load('tasks.mjs');
    for (const d of loadCorpus()) {
      expect(d.local).toBeUndefined();
      expect(d.url.startsWith('https://')).toBe(true);
      expect(d.license.length).toBeGreaterThan(0);
    }
  });
});

describe('validate', () => {
  it('accepts a minimal valid pair', async () => {
    const { validate } = await load('tasks.mjs');
    expect(validate([doc], [task])).toEqual([]);
  });

  it('flags unknown docs, tags and duplicate ids', async () => {
    const { validate } = await load('tasks.mjs');
    const errors = validate([doc, doc], [{ ...task, doc: 'zzz', tags: ['bogus'] }, task, task]);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('duplicate doc id a'), expect.stringContaining('unknown doc zzz'), expect.stringContaining('unknown tag bogus'), expect.stringContaining('duplicate task id t1')]));
  });

  it('flags bad expected values and missing sources', async () => {
    const { validate } = await load('tasks.mjs');
    const errors = validate(
      [doc],
      [
        { ...task, id: 'n', expected: { type: 'number', value: 'x' } },
        { ...task, id: 't', expected: { type: 'text', value: '' } },
        { ...task, id: 'o', expected: { type: 'oneOf', value: [] } },
        { ...task, id: 's', source: '' },
        { ...task, id: 'k', expected: { type: 'regex', value: 'x' } },
      ],
    );
    expect(errors.length).toBe(5);
  });

  it('validates facts expectations', async () => {
    const { validate } = await load('tasks.mjs');
    const ok = { ...task, id: 'f', tags: ['summary'], expected: { type: 'facts', value: ['a', 'b', 3], min: 2 } };
    expect(validate([doc], [ok])).toEqual([]);
    const bad = [
      { ...ok, id: 'f1', expected: { type: 'facts', value: ['a'], min: 1 } },
      { ...ok, id: 'f2', expected: { type: 'facts', value: ['a', 'b'], min: 3 } },
      { ...ok, id: 'f3', expected: { type: 'facts', value: ['a', 'b'] } },
      { ...ok, id: 'f4', expected: { type: 'facts', value: ['a', ''], min: 1 } },
    ];
    expect(validate([doc], bad).length).toBe(4);
  });

  it('flags bad sha256, non-https url and a local-only entry', async () => {
    const { validate } = await load('tasks.mjs');
    const errors = validate(
      [
        { ...doc, id: 'b', sha256: 'zz' },
        { ...doc, id: 'c', url: 'http://example.com/c.pdf' },
        { id: 'd', ext: 'pdf', local: '../etc/passwd' },
      ],
      [],
    );
    expect(errors.length).toBe(5);
  });
});

describe('validate with multiple documents', () => {
  const docB = { ...doc, id: 'b' };
  const { doc: _single, ...rest } = task;

  it('accepts docs with every id in the corpus', async () => {
    const { validate } = await load('tasks.mjs');
    expect(validate([doc, docB], [{ ...rest, docs: ['a', 'b'] }])).toEqual([]);
  });

  it('requires exactly one of doc or docs', async () => {
    const { validate } = await load('tasks.mjs');
    expect(validate([doc, docB], [{ ...rest }])).toEqual([expect.stringContaining('exactly one of doc or docs')]);
    expect(validate([doc, docB], [{ ...task, docs: ['a', 'b'] }])).toEqual([expect.stringContaining('exactly one of doc or docs')]);
  });

  it('flags unknown ids, duplicates and malformed docs', async () => {
    const { validate } = await load('tasks.mjs');
    expect(validate([doc, docB], [{ ...rest, docs: ['a', 'zzz'] }])).toEqual([expect.stringContaining('unknown doc zzz')]);
    expect(validate([doc, docB], [{ ...rest, docs: ['a', 'a'] }])).toEqual([expect.stringContaining('duplicate doc in docs')]);
    expect(validate([doc, docB], [{ ...rest, docs: [] }])).toEqual([expect.stringContaining('non-empty array')]);
    expect(validate([doc, docB], [{ ...rest, docs: 'a' }])).toEqual([expect.stringContaining('non-empty array')]);
  });

  it('accepts the audio and video tags and labels a task by its joined ids', async () => {
    const { validate, taskDocLabel, taskDocIds, selectTasks } = await load('tasks.mjs');
    expect(validate([doc], [{ ...task, tags: ['audio', 'video'] }])).toEqual([]);
    const multi = { ...rest, docs: ['a', 'b'] };
    expect(taskDocLabel(multi)).toBe('a+b');
    expect(taskDocLabel(task)).toBe('a');
    expect(taskDocIds(multi)).toEqual(['a', 'b']);
    expect(selectTasks([multi, task], 'doc:b')).toEqual([multi]);
  });
});

describe('tagCoverage', () => {
  it('counts tasks per tag and lists empty tags', async () => {
    const { tagCoverage, TAGS } = await load('tasks.mjs');
    const result = tagCoverage([{ tags: ['simple', 'deep'] }, { tags: ['simple'] }]);
    expect(result.counts.simple).toBe(2);
    expect(result.counts.deep).toBe(1);
    expect(result.empty).toEqual(TAGS.filter((t: string) => t !== 'simple' && t !== 'deep'));
  });

  it('finds no empty tag in the shipped tasks', async () => {
    const { tagCoverage, loadTasks } = await load('tasks.mjs');
    expect(tagCoverage(loadTasks()).empty).toEqual([]);
  });

  it('replaced the task a model could answer from memory', async () => {
    const { loadTasks } = await load('tasks.mjs');
    expect(loadTasks().some((t: { id: string }) => t.id === '53r5-sc12')).toBe(false);
    expect(loadTasks().some((t: { id: string }) => t.id === '53r5-si13-mttf-example')).toBe(true);
  });
});

describe('selectTasks', () => {
  it('filters by tag, doc and id', async () => {
    const { selectTasks } = await load('tasks.mjs');
    const tasks = [
      { ...task, id: 'a1', tags: ['simple'] },
      { ...task, id: 'a2', tags: ['deep'], doc: 'b' },
      { ...task, id: 'a3', tags: ['deep', 'chart'] },
    ];
    expect(selectTasks(tasks, 'tag:deep').map((t: { id: string }) => t.id)).toEqual(['a2', 'a3']);
    expect(selectTasks(tasks, 'tag:simple,id:a3').map((t: { id: string }) => t.id)).toEqual(['a1', 'a3']);
    expect(selectTasks(tasks, 'doc:b').map((t: { id: string }) => t.id)).toEqual(['a2']);
    expect(selectTasks(tasks, undefined)).toHaveLength(3);
  });
});
