import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpaDownloader } from '../src/downloader.js';
import { MemoryCheckpointStore, FileCheckpointStore } from '../src/checkpoint.js';
import { FakeTransport, makeFile } from './helpers.js';

const noSleep = () => Promise.resolve();

function makeDownloader(transport, store, extra = {}) {
  return new RpaDownloader({
    transport,
    checkpointStore: store,
    sleep: noSleep,
    baseDelayMs: 1,
    ...extra,
  });
}

function setupBasic(transport, count = 4) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const file = makeFile(`report-${i}-`.repeat(20));
    transport.addFile(`https://cdn.example.com/f${i}?sig=s${i}`, file);
    items.push({
      id: `f${i}`,
      name: `report-${i}.csv`,
      url: `https://cdn.example.com/f${i}?sig=s${i}`,
      size: file.size,
      digest: file.digest,
    });
  }
  transport.addTask('daily', [
    { cursor: 'p1', items: items.slice(0, 2) },
    { cursor: 'p2', items: items.slice(2) },
  ]);
  return items;
}

test('mid-session expiry: refreshes session and completes all files', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport);
  transport.expireAfter = 3;

  const downloader = makeDownloader(transport, new MemoryCheckpointStore());
  const summary = await downloader.run([{ key: 'daily' }]);

  assert.equal(summary.done, items.length);
  assert.equal(summary.failed, 0);
  assert.ok(transport.refreshSessionCalls >= 2);
  for (const item of items) {
    assert.ok(transport.writes.has(item.name), `${item.name} written`);
  }
});

test('checkpoint resume: second run skips completed files and finishes the rest', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport);
  const store = new MemoryCheckpointStore();

  transport.networkFlakes.set(items[3].url, 10);
  const first = makeDownloader(transport, store, { retries: 1 });
  const summary1 = await first.run([{ key: 'daily' }]);
  assert.equal(summary1.done, 3);
  assert.equal(summary1.failed, 1);

  transport.networkFlakes.set(items[3].url, 0);
  const second = makeDownloader(transport, store);
  const summary2 = await second.run([{ key: 'daily' }]);

  assert.equal(summary2.done, 4);
  assert.equal(summary2.failed, 0);
  for (const item of items.slice(0, 3)) {
    assert.equal(
      transport.downloadCalls.get(item.url),
      1,
      `${item.id} downloaded exactly once across runs`,
    );
  }
  assert.ok(transport.downloadCalls.get(items[3].url) > 1);
});

test('checkpoint resume survives process restart via file store', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-'));
  const storePath = path.join(dir, 'checkpoint.json');

  transport.networkFlakes.set(items[2].url, 10);
  transport.networkFlakes.set(items[3].url, 10);
  const first = makeDownloader(transport, new FileCheckpointStore(storePath), {
    retries: 1,
  });
  const summary1 = await first.run([{ key: 'daily' }]);
  assert.equal(summary1.done, 2);

  transport.networkFlakes.clear();
  const second = makeDownloader(transport, new FileCheckpointStore(storePath));
  const summary2 = await second.run([{ key: 'daily' }]);

  assert.equal(summary2.done, 4);
  assert.equal(transport.downloadCalls.get(items[0].url), 1);
  assert.equal(transport.downloadCalls.get(items[1].url), 1);
});

test('duplicates: same id across tasks and same digest across ids download once', async () => {
  const transport = new FakeTransport();
  const fileA = makeFile('shared-content-'.repeat(30));
  const fileB = makeFile('unique-content-'.repeat(30));
  transport.addFile('https://cdn.example.com/a?sig=1', fileA);
  transport.addFile('https://cdn.example.com/b?sig=1', fileB);
  const itemA = {
    id: 'a',
    name: 'a.csv',
    url: 'https://cdn.example.com/a?sig=1',
    size: fileA.size,
    digest: fileA.digest,
  };
  const itemADup = {
    id: 'a-copy',
    name: 'a-copy.csv',
    url: 'https://cdn.example.com/a?sig=2',
    size: fileA.size,
    digest: fileA.digest,
  };
  const itemB = {
    id: 'b',
    name: 'b.csv',
    url: 'https://cdn.example.com/b?sig=1',
    size: fileB.size,
    digest: fileB.digest,
  };
  transport.addTask('t1', [{ cursor: 'p1', items: [itemA, itemB] }]);
  transport.addTask('t2', [{ cursor: 'p1', items: [itemA, itemADup] }]);

  const downloader = makeDownloader(transport, new MemoryCheckpointStore());
  const summary = await downloader.run([{ key: 't1' }, { key: 't2' }]);

  assert.equal(summary.done, 3);
  assert.equal(transport.downloadCalls.get('https://cdn.example.com/a?sig=1'), 1);
  assert.equal(transport.downloadCalls.get('https://cdn.example.com/b?sig=1'), 1);
  assert.equal(transport.downloadCalls.has('https://cdn.example.com/a?sig=2'), false);
  assert.equal(downloader.state.files['a-copy'].duplicateOf, 'a');
});

test('error pages are quarantined, never counted as done', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport, 2);
  transport.errorPageUrls.add(items[1].url);

  const downloader = makeDownloader(transport, new MemoryCheckpointStore());
  const summary = await downloader.run([{ key: 'daily' }]);

  assert.equal(summary.done, 1);
  assert.equal(summary.quarantined, 1);
  assert.equal(transport.quarantined.length, 1);
  assert.equal(transport.quarantined[0].name, items[1].name);
  assert.equal(transport.writes.has(items[1].name), false);
  assert.equal(downloader.state.files[items[1].id].status, 'quarantined');
});

test('expired signed url: re-locates item and retries with fresh url', async () => {
  const transport = new FakeTransport();
  const file = makeFile('report-body-'.repeat(30));
  const staleUrl = 'https://cdn.example.com/x?sig=old';
  const freshUrl = 'https://cdn.example.com/x?sig=new';
  transport.expiredUrls.add(staleUrl);
  transport.addFile(freshUrl, file);
  const staleItem = {
    id: 'x',
    name: 'x.csv',
    url: staleUrl,
    size: file.size,
    digest: file.digest,
  };
  transport.addTask('daily', [{ cursor: 'p1', items: [staleItem] }]);

  const originalFetchPage = transport.fetchPage.bind(transport);
  let pageCalls = 0;
  transport.fetchPage = async (req, ctx) => {
    pageCalls += 1;
    if (pageCalls > 1) {
      transport.pages.set('daily', [
        { cursor: 'p1', items: [{ ...staleItem, url: freshUrl }] },
      ]);
    }
    return originalFetchPage(req, ctx);
  };

  const downloader = makeDownloader(transport, new MemoryCheckpointStore());
  const summary = await downloader.run([{ key: 'daily' }]);

  assert.equal(summary.done, 1);
  assert.equal(summary.failed, 0);
  assert.ok(transport.writes.has('x.csv'));
});

test('pagination shift: invalid cursor restarts task without duplicating downloads', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport);
  const store = new MemoryCheckpointStore();

  transport.pageErrors.set('p2', 5);
  const first = makeDownloader(transport, store, { retries: 1 });
  await assert.rejects(first.run([{ key: 'daily' }]), /ECONNRESET/);
  assert.equal(transport.downloadCalls.get(items[0].url), 1);

  transport.pages.set('daily', [
    { cursor: 'n1', items: [items[0], items[1], items[2]] },
    { cursor: 'n2', items: [items[3]] },
  ]);
  const second = makeDownloader(transport, store);
  const summary = await second.run([{ key: 'daily' }]);

  assert.equal(summary.done, 4);
  assert.equal(transport.downloadCalls.get(items[0].url), 1);
  assert.equal(transport.downloadCalls.get(items[1].url), 1);
  assert.equal(transport.downloadCalls.get(items[2].url), 1);
  assert.equal(transport.downloadCalls.get(items[3].url), 1);
});

test('transient network errors are retried with backoff', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport, 1);
  transport.networkFlakes.set(items[0].url, 2);

  const downloader = makeDownloader(transport, new MemoryCheckpointStore(), {
    retries: 3,
  });
  const summary = await downloader.run([{ key: 'daily' }]);

  assert.equal(summary.done, 1);
  assert.equal(transport.downloadCalls.get(items[0].url), 3);
});

test('concurrency limit is respected', async () => {
  const transport = new FakeTransport();
  setupBasic(transport, 6);
  transport.addTask('daily', [
    {
      cursor: 'p1',
      items: Array.from({ length: 6 }, (_, i) => ({
        id: `f${i}`,
        name: `report-${i}.csv`,
        url: `https://cdn.example.com/f${i}?sig=s${i}`,
        size: transport.files.get(`https://cdn.example.com/f${i}?sig=s${i}`).size,
        digest: transport.files.get(`https://cdn.example.com/f${i}?sig=s${i}`).digest,
      })),
    },
  ]);

  const downloader = makeDownloader(transport, new MemoryCheckpointStore(), {
    concurrency: 2,
  });
  const summary = await downloader.run([{ key: 'daily' }]);

  assert.equal(summary.done, 6);
  assert.ok(transport.maxActiveDownloads <= 2);
  assert.ok(transport.maxActiveDownloads >= 1);
});

test('digest mismatch is not done: retried, then failed, recovered on next run', async () => {
  const transport = new FakeTransport();
  const items = setupBasic(transport, 1);
  const good = transport.files.get(items[0].url);
  transport.files.set(items[0].url, {
    ...good,
    body: Buffer.from('corrupted-content-that-is-long-enough-to-not-be-an-error-page-'.repeat(4)),
  });

  const store = new MemoryCheckpointStore();
  const first = makeDownloader(transport, store, { retries: 2 });
  const summary1 = await first.run([{ key: 'daily' }]);
  assert.equal(summary1.done, 0);
  assert.equal(summary1.failed, 1);
  assert.equal(transport.writes.has(items[0].name), false);

  transport.files.set(items[0].url, good);
  const second = makeDownloader(transport, store);
  const summary2 = await second.run([{ key: 'daily' }]);
  assert.equal(summary2.done, 1);
  assert.ok(transport.writes.has(items[0].name));
});
