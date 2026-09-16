import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { applyEnterpriseHost, mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { parseEnterpriseRequest, parseEnterpriseSnapshot } from '../src/enterprise-schema.ts';
import { ENTERPRISE_BACKUP_PATH, ENTERPRISE_COMMAND_PATH, ENTERPRISE_RESTORE_PATH, ENTERPRISE_SNAPSHOT_PATH } from '../src/enterprise-types.ts';

async function database(context) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-enterprise-'));
  const path = join(root, 'enterprise.sqlite');
  const stores = [];
  context.after(async () => {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => { const store = await openEnterpriseStore(path); stores.push(store); return store; };
  return { path, open, store: await open() };
}

const contact = { id: 'contact-1', name: '王经理', company: '远航科技', stage: 'proposal', nextAction: '确认报价', nextActionDate: '2026-09-15' };
const item = { id: 'item-1', sku: 'A-001', name: '控制器', stock: 12, reorderAt: 3, supplier: '本地供应商' };
const order = (id, kind, quantity = 2) => ({ id, kind, counterparty: '远航科技', orderDate: '2026-09-12', currency: 'CNY', lines: [{ itemId: item.id, quantity, unitPriceMinorUnits: 12345 }], note: '交货前确认' });
const command = (store, value, extra = {}) => store.execute({ generation: store.snapshot().generation, revision: store.snapshot().revision, commandId: randomUUID(), command: value, ...extra });

test('CRM edits, SKU corrections, deletion and audit survive reopening the database', async context => {
  const { store, open } = await database(context);
  assert.deepEqual(store.snapshot(), { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] });
  command(store, { type: 'contact.upsert', contact });
  command(store, { type: 'contact.upsert', contact: { ...contact, stage: 'won', nextActionDate: null } });
  command(store, { type: 'item.upsert', item });
  command(store, { type: 'item.upsert', item: { ...item, stock: 20, supplier: '新供应商' } });
  const expected = store.snapshot();
  assert.equal(expected.contacts[0].stage, 'won');
  assert.equal(expected.inventory[0].stock, 20);
  assert.equal(expected.audit[0].before.stock, 12);
  assert.equal(expected.audit[0].after.stock, 20);
  store.close();
  const reopened = await open();
  assert.deepEqual(reopened.snapshot(), expected);
  command(reopened, { type: 'contact.remove', id: contact.id });
  command(reopened, { type: 'item.remove', id: item.id });
  assert.deepEqual(reopened.snapshot().contacts, []);
  assert.deepEqual(reopened.snapshot().inventory, []);
  assert.equal(reopened.snapshot().audit.length, 6);
});

test('restore replaces records and audit atomically from a complete backup envelope', async context => {
  const { store } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  const backup = store.backup();
  command(store, { type: 'contact.upsert', contact: { ...contact, stage: 'lost' } });
  const restored = store.restore(backup, store.snapshot().revision);
  assert.deepEqual(restored, { ...backup.snapshot, generation: 1 });
  assert.equal(store.backup().auditCommands.length, backup.auditCommands.length);
  assert.throws(() => store.restore(backup, 0), { code: 'revision_conflict' });
});

test('restore rejects pre-restore writes, receipts and confirmations even when revisions repeat', async context => {
  const { store, open } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  const backup = store.backup();
  const oldRequest = { generation: 0, revision: 1, commandId: 'old-request', command: { type: 'contact.upsert', contact: { ...contact, name: 'stale' } } };
  store.execute(oldRequest);
  store.restore(backup, 2, 0);
  for (const method of ['prepare', 'execute']) {
    assert.throws(() => store[method](oldRequest), { code: 'revision_conflict' });
    assert.throws(() => store[method]({ ...oldRequest, commandId: 'uncommitted' }), { code: 'revision_conflict' });
    assert.throws(() => store[method]({ revision: 1, commandId: 'legacy', command: oldRequest.command }), { code: 'revision_conflict' });
  }
  assert.throws(() => store.restore(backup, 1, 0), { code: 'revision_conflict' });
  const reopened = await open();
  assert.equal(reopened.snapshot().generation, 1);
  command(reopened, { type: 'contact.upsert', contact: { ...contact, name: 'reviewed' } });
  reopened.restore(backup, 2, 1);
  assert.equal(store.snapshot().generation, 2);
  assert.equal(store.snapshot().contacts[0].name, contact.name);
});

test('schema 1 gains a restore counter without changing business records or audit', async context => {
  const { store, path, open } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  const expected = store.snapshot();
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE enterprise_meta DROP COLUMN generation; PRAGMA user_version=1;');
  legacy.close();
  const migrated = await open();
  assert.deepEqual(migrated.snapshot(), expected);
  const inspect = new DatabaseSync(path);
  try { assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 3); }
  finally { inspect.close(); }
});

test('a failed restore rolls back records, receipts and the restore counter together', async context => {
  const { store, path } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  const backup = store.backup();
  command(store, { type: 'contact.upsert', contact: { ...contact, name: 'newer' } });
  const before = store.backup();
  const fault = new DatabaseSync(path);
  fault.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON contacts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  fault.close();
  assert.throws(() => store.restore(backup, 2, 0), { code: 'storage_invalid' });
  assert.deepEqual(store.snapshot(), before.snapshot);
  assert.deepEqual(store.backup().auditCommands, before.auditCommands);
});

test('backup receipt content must agree with its audited entity and values', async context => {
  const { store } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  const backup = store.backup();
  for (const changed of [{ ...contact, id: 'wrong-id' }, { ...contact, name: 'different content' }]) {
    const invalid = structuredClone(backup);
    invalid.auditCommands[0].commandJson = JSON.stringify({ type: 'contact.upsert', contact: changed });
    assert.throws(() => store.restore(invalid, 1, 0), { code: 'storage_invalid' });
    assert.deepEqual(store.snapshot(), backup.snapshot);
  }
});

test('route disposal drains a restore body and prevents replacement after shutdown begins', async context => {
  const { store } = await database(context);
  const backup = store.backup();
  command(store, { type: 'contact.upsert', contact });
  const before = store.snapshot();
  const routes = new Map();
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) {
    routes.set(route.path, route.fetch); return async () => { routes.delete(route.path); };
  } } } }, store);
  context.after(remove);
  let release;
  const body = new ReadableStream({ start(controller) { release = () => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ confirm: true, expectedRevision: 1, expectedGeneration: 0, backup })));
    controller.close();
  }; } });
  const response = routes.get(ENTERPRISE_RESTORE_PATH)(new Request('http://fixture/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  }));
  const closing = remove();
  release();
  assert.equal((await response).status, 503);
  await closing;
  assert.deepEqual(store.snapshot(), before);
});

test('purchase and sale submission change stock exactly once and retain integer money', async context => {
  const { store } = await database(context);
  command(store, { type: 'item.upsert', item });
  command(store, { type: 'order.save', order: order('purchase-1', 'purchase', 5) });
  const request = { revision: store.snapshot().revision, commandId: randomUUID(), command: { type: 'order.submit', id: 'purchase-1' } };
  const purchased = store.execute(request);
  assert.equal(purchased.inventory[0].stock, 17);
  assert.equal(purchased.orders[0].totalMinorUnits, 61725);
  assert.equal(purchased.orders[0].status, 'submitted');
  assert.deepEqual(store.execute(request), purchased);
  assert.throws(() => command(store, request.command), { code: 'submitted_order' });
  assert.throws(() => command(store, { type: 'order.save', order: order('purchase-1', 'sale') }), { code: 'submitted_order' });
  assert.throws(() => command(store, { type: 'order.remove', id: 'purchase-1' }), { code: 'submitted_order' });
  command(store, { type: 'order.save', order: order('sale-1', 'sale', 4) });
  const sold = command(store, { type: 'order.submit', id: 'sale-1' });
  assert.equal(sold.inventory[0].stock, 13);
  assert.equal(sold.audit[0].before.inventory[0].stock, 17);
  assert.equal(sold.audit[0].after.inventory[0].stock, 13);
  assert.throws(() => command(store, { type: 'item.remove', id: item.id }), { code: 'referenced_item' });
});

test('insufficient stock rolls back every line, status, revision and audit entry', async context => {
  const { store } = await database(context);
  command(store, { type: 'item.upsert', item });
  command(store, { type: 'item.upsert', item: { ...item, id: 'item-2', sku: 'A-002', stock: 1 } });
  command(store, { type: 'order.save', order: { ...order('sale-1', 'sale'), lines: [
    { itemId: item.id, quantity: 3, unitPriceMinorUnits: 12345 },
    { itemId: 'item-2', quantity: 2, unitPriceMinorUnits: 100 },
  ] } });
  const before = store.snapshot();
  assert.throws(() => command(store, { type: 'order.submit', id: 'sale-1' }), { code: 'insufficient_stock' });
  assert.deepEqual(store.snapshot(), before);
  command(store, { type: 'order.remove', id: 'sale-1' });
  command(store, { type: 'item.remove', id: 'item-2' });
});

test('separate database connections reject stale revisions and conflicting idempotency keys', async context => {
  const { store, open } = await database(context);
  const second = await open();
  const baseline = second.snapshot().revision;
  const commandId = randomUUID();
  command(store, { type: 'contact.upsert', contact }, { commandId });
  assert.throws(() => second.execute({ revision: baseline, commandId: randomUUID(), command: { type: 'item.upsert', item } }), { code: 'revision_conflict', currentRevision: 1 });
  assert.throws(() => command(second, { type: 'item.upsert', item }, { commandId }), { code: 'command_conflict' });
  assert.equal(second.snapshot().inventory.length, 0);
  assert.equal(second.snapshot().audit.length, 1);
});

test('simultaneous SQLite writers serialize their revision check and commit', { timeout: 15000 }, async context => {
  const { path, store } = await database(context);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = [1, 2].map(number => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openEnterpriseStore } = await import(workerData.module);
      const store = await openEnterpriseStore(workerData.path);
      try {
        const revision = store.snapshot().revision;
        const gate = new Int32Array(workerData.gate);
        parentPort.postMessage({ ready: true });
        Atomics.wait(gate, 0, 0);
        try {
          const result = store.execute({ revision, commandId: workerData.id, command: {
            type: 'contact.upsert', contact: { ...workerData.contact, id: workerData.id },
          } });
          parentPort.postMessage({ result: 'committed', revision: result.revision });
        } catch (error) { parentPort.postMessage({ result: error.code, revision: error.currentRevision }); }
      } finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL('../src/enterprise-host.ts', import.meta.url).href, path, gate, contact, id: `writer-${number}` } }));
  context.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const observations = workers.map(worker => {
    let ready;
    const started = new Promise((resolve, reject) => {
      ready = resolve;
      worker.on('error', reject);
    });
    const finished = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', value => { if (value.ready) ready(); else resolve(value); });
    });
    const exited = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`Writer exited with ${code}`)));
    });
    return { started, finished, exited };
  });
  const ready = Promise.all(observations.map(observation => observation.started)).then(() => {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
  });
  const [, outcomes] = await Promise.all([
    ready, Promise.all(observations.map(observation => observation.finished)),
    Promise.all(observations.map(observation => observation.exited)),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.result).sort(), ['committed', 'revision_conflict']);
  assert.ok(outcomes.every(outcome => outcome.revision === 1));
  assert.equal(store.snapshot().contacts.length, 1);
  assert.equal(store.snapshot().audit.length, 1);
});

test('shared response parser rejects malformed records, totals, references and audit history', async context => {
  const { store } = await database(context);
  command(store, { type: 'item.upsert', item });
  command(store, { type: 'order.save', order: order('sale-1', 'sale') });
  const valid = JSON.parse(JSON.stringify(store.snapshot()));
  assert.deepEqual(parseEnterpriseSnapshot(valid), valid);
  const mutations = [
    value => { value.extra = true; },
    value => { value.inventory[0].stock = '12'; },
    value => { value.inventory[0].stock = 1.5; },
    value => { value.inventory.push(value.inventory[0]); },
    value => { value.orders[0].totalMinorUnits += 1; },
    value => { value.orders[0].submittedAt = new Date().toISOString(); },
    value => { value.orders[0].lines[0].itemId = 'missing'; },
    value => { value.audit[0].before = {}; },
    value => { value.audit[0].after.lines = null; },
    value => { value.audit[0].entityId = 'different'; },
    value => { value.audit[0].revision = 1; },
    value => { value.audit[1].commandId = value.audit[0].commandId; },
    value => { value.audit.pop(); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => parseEnterpriseSnapshot(invalid), { code: 'storage_invalid' });
  }
});

test('invalid types, impossible dates, unknown fields and unsafe monetary values cannot mutate records', async context => {
  const { store } = await database(context);
  const invalid = [null, {}, { type: 'unknown' },
    { type: 'contact.upsert', contact: { ...contact, nextActionDate: '2026-02-30' } },
    { type: 'contact.upsert', contact: { ...contact, stage: 'unknown' } },
    { type: 'item.upsert', item: { ...item, stock: -1 } },
    { type: 'item.upsert', item: { ...item, stock: '12' } },
    { type: 'item.upsert', item: { ...item, stock: 1.5 } },
    { type: 'item.upsert', item: { ...item, updatedAt: 'forged' } },
    { type: 'order.save', order: { ...order('sale', 'sale'), lines: [{ itemId: item.id, quantity: 1, unitPriceMinorUnits: 12.5 }] } },
    { type: 'order.save', order: { ...order('sale', 'sale'), lines: [order('sale', 'sale').lines[0], order('sale', 'sale').lines[0]] } },
  ];
  for (const value of invalid) assert.throws(() => command(store, value), { code: 'invalid_request' });
  assert.throws(() => parseEnterpriseRequest({ revision: 0, commandId: '../escape', command: { type: 'contact.upsert', contact } }), { code: 'invalid_request' });
  assert.deepEqual(store.snapshot(), { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] });
  command(store, { type: 'item.upsert', item });
  assert.throws(() => command(store, { type: 'item.upsert', item: { ...item, id: 'duplicate' } }), { code: 'duplicate_sku' });
  assert.throws(() => command(store, { type: 'order.save', order: { ...order('sale', 'sale'), lines: [{ itemId: item.id, quantity: 2, unitPriceMinorUnits: Number.MAX_SAFE_INTEGER }] } }), { code: 'numeric_overflow' });
});

test('foreign, newer and semantically damaged databases fail without erasing existing data', async context => {
  const { store, path, open } = await database(context);
  command(store, { type: 'contact.upsert', contact });
  store.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=99');
  db.close();
  await assert.rejects(open(), { code: 'storage_invalid' });
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare('SELECT name FROM contacts').get().name, contact.name);
  inspect.exec('PRAGMA user_version=1; DROP TABLE enterprise_meta;');
  inspect.close();
  await assert.rejects(open(), { code: 'storage_invalid' });
  const untouched = new DatabaseSync(path);
  assert.equal(untouched.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='enterprise_meta'").get().count, 0);
  untouched.close();
  const foreignPath = join(dirname(path), 'foreign.sqlite');
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec("CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep')");
  foreign.close();
  await assert.rejects(openEnterpriseStore(foreignPath), { code: 'storage_invalid' });
  const corruptPath = join(dirname(path), 'corrupt.sqlite');
  await writeFile(corruptPath, 'user-owned non-SQLite bytes');
  await assert.rejects(openEnterpriseStore(corruptPath), { code: 'storage_invalid' });
  assert.equal(await readFile(corruptPath, 'utf8'), 'user-owned non-SQLite bytes');
});

test('DSH route registration validates JSON, returns conflicts and disposes without late mutations', async context => {
  const { path, store } = await database(context);
  store.close();
  const routes = new Map();
  const dispose = await applyEnterpriseHost({ connection: { fetch: { register(route) {
    assert.equal(route.requestBody, 'buffered');
    routes.set(route.path, route);
    return async () => { routes.delete(route.path); };
  } } } }, { databasePath: path });
  context.after(dispose);
  const get = routes.get(ENTERPRISE_SNAPSHOT_PATH).fetch;
  const backup = routes.get(ENTERPRISE_BACKUP_PATH).fetch;
  const restore = routes.get(ENTERPRISE_RESTORE_PATH).fetch;
  const post = routes.get(ENTERPRISE_COMMAND_PATH).fetch;
  const request = body => new Request(`http://127.0.0.1${ENTERPRISE_COMMAND_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await get(new Request(`http://127.0.0.1${ENTERPRISE_SNAPSHOT_PATH}`))).status, 200);
  const backupResponse = await backup(new Request(`http://127.0.0.1${ENTERPRISE_BACKUP_PATH}`));
  assert.equal(backupResponse.status, 200);
  assert.equal((await backupResponse.json()).schemaVersion, 1);
  assert.equal((await restore(new Request(`http://127.0.0.1${ENTERPRISE_RESTORE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status, 400);
  for (const body of ['{broken', '{}', 'null']) assert.equal((await post(request(body))).status, 400);
  assert.equal((await post(new Request('http://127.0.0.1', { method: 'POST', body: '{}' }))).status, 400);
  const first = JSON.stringify({ revision: 0, commandId: randomUUID(), command: { type: 'contact.upsert', contact } });
  const second = JSON.stringify({ revision: 0, commandId: randomUUID(), command: { type: 'item.upsert', item } });
  const results = await Promise.all([post(request(first)), post(request(second))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const activeRequest = post(request(JSON.stringify({ revision: 1, commandId: randomUUID(), command: { type: 'item.upsert', item } })));
  await Promise.all([dispose(), dispose()]);
  assert.equal((await activeRequest).status, 503);
  assert.equal(routes.size, 0);
  assert.equal((await get(new Request('http://127.0.0.1'))).status, 503);
  const reopened = await openEnterpriseStore(path);
  assert.equal(reopened.snapshot().revision, 1);
  reopened.close();
});

test('receipt-only commands retain stock rollback, revision checks and durable exact replay', async context => {
  const { store, open } = await database(context);
  command(store, { type: 'item.upsert', item: { ...item, stock: 1 } });
  command(store, { type: 'order.save', order: order('receipt-sale', 'sale', 2) });
  const before = store.snapshot();
  assert.throws(() => store.executeReceipt({ revision: before.revision, commandId: 'failed-receipt', command: { type: 'order.submit', id: 'receipt-sale' } }), { code: 'insufficient_stock' });
  assert.deepEqual(store.snapshot(), before);
  const prepared = store.prepare({ revision: before.revision, commandId: 'stale-receipt', command: { type: 'contact.upsert', contact } });
  command(store, { type: 'item.upsert', item: { ...item, stock: 5 } });
  assert.throws(() => store.executeReceipt(prepared.request), { code: 'revision_conflict' });
  const request = { revision: store.snapshot().revision, commandId: 'durable-receipt', command: { type: 'order.submit', id: 'receipt-sale' } };
  const first = store.executeReceipt(request);
  assert.equal(first.receipt.after.inventory[0].stock, 3);
  command(store, { type: 'contact.upsert', contact });
  const expected = store.snapshot();
  store.close();
  const reopened = await open();
  const replay = reopened.executeReceipt(request);
  assert.equal(replay.revision, expected.revision);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(reopened.snapshot(), expected);
  assert.throws(() => reopened.executeReceipt({ ...request, command: { type: 'contact.remove', id: contact.id } }), { code: 'command_conflict' });
});
