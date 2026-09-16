/** SQLite enterprise records and authenticated DSH Fetch routes; owns no listener or Session. */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { appendResponsibility, initializeResponsibilityHistory, queryResponsibility, verifyResponsibility, LOCAL_HTTP_IDENTITY, UNKNOWN_IDENTITY } from './governance-audit.ts';
import type { ExecutionIdentity } from './governance-audit.ts';
import {
  EnterpriseError, ENTERPRISE_COMMAND_PATH, ENTERPRISE_SNAPSHOT_PATH,
  ENTERPRISE_BACKUP_PATH, ENTERPRISE_RESTORE_PATH,
} from './enterprise-types.ts';
import type {
  EnterpriseBackup, AuditEntry, BusinessOrder, Contact, EnterpriseCommand, EnterpriseCommandRequest, EnterpriseSnapshot, InventoryItem, EnterpriseId,
} from './enterprise-types.ts';
import {
  contactSchema, itemSchema, orderSchema, auditSchema, parseEnterpriseRequest,
  parseEnterpriseBackup, parseEnterpriseRestoreRequest, parseEnterpriseSnapshot, enterpriseOrderTotal,
} from './enterprise-schema.ts';

const SCHEMA_VERSION = 3;
const APPLICATION_ID = 0x434d454e;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sqliteRow = z.record(z.string(), z.unknown());

// The frontend's npm lock pins Node 22.10 types; Node >=22.19 provides both SQLite APIs.
interface SearchDatabase extends DatabaseSync {
  function(name: string, options: { deterministic: boolean }, callback: (value: unknown, search: unknown) => number): void;
}
interface IterableStatement extends StatementSync {
  iterate(...parameters: Array<string | number>): IterableIterator<unknown>;
}

/** Collection-scoped query already validated by the tool parser. */
export interface EnterpriseQuerySpec {
  collection: 'contacts' | 'inventory' | 'orders' | 'audit';
  id?: EnterpriseId;
  search?: string;
  offset: number;
  limit: number;
  revision?: number;
  generation?: number;
}

/** Bounded tool page; total counts matching records before pagination. */
export interface EnterpriseQueryPage {
  generation: number;
  revision: number;
  collection: EnterpriseQuerySpec['collection'];
  offset: number;
  total: number;
  nextOffset: number | null;
  records: Array<Contact | InventoryItem | BusinessOrder | AuditEntry>;
}

/** Current revision and one durable command receipt. */
export interface EnterpriseCommitReceipt { generation: number; revision: number; receipt: AuditEntry; }

/** Facts needed for approval; exact committed replays carry their existing receipt. */
export interface EnterprisePreparation {
  request: EnterpriseCommandRequest;
  generation: number;
  revision: number;
  before: Contact | InventoryItem | BusinessOrder | null;
  inventory?: InventoryItem[];
  receipt?: AuditEntry;
}

// All SQL identifiers and JSON keys are deployment-independent literals.
const jsonFields = (columns: readonly string[]): string => columns.map(column => `'${column}', r.${column}`).join(', ');
const orderLinesJson = `(SELECT json_group_array(json(line)) FROM (SELECT json_object('itemId', itemId, 'quantity', quantity, 'unitPriceMinorUnits', unitPriceMinorUnits) AS line FROM order_lines WHERE orderId = r.id ORDER BY position))`;
const collections = {
  contacts: { table: 'contacts', order: 'r.name, r.id', schema: contactSchema,
    json: `json_object(${jsonFields(['id', 'name', 'company', 'stage', 'nextAction', 'nextActionDate', 'updatedAt'])})` },
  inventory: { table: 'inventory', order: 'r.sku, r.id', schema: itemSchema,
    json: `json_object(${jsonFields(['id', 'sku', 'name', 'stock', 'reorderAt', 'supplier', 'updatedAt'])})` },
  orders: { table: 'orders', order: 'r.updatedAt DESC, r.id', schema: orderSchema,
    json: `json_object(${jsonFields(['id', 'kind', 'counterparty', 'orderDate', 'currency'])}, 'lines', json(${orderLinesJson}), ${jsonFields(['note', 'status', 'totalMinorUnits', 'updatedAt', 'submittedAt'])})` },
  audit: { table: 'enterprise_audit', order: 'r.revision DESC', schema: auditSchema,
    json: `json_object(${jsonFields(['revision', 'commandId', 'entityId', 'at', 'type'])}, 'before', json(r.beforeJson), 'after', json(r.afterJson))` },
} as const;

/** Public database owner; close is idempotent and rejects all subsequent operations. */
export class EnterpriseStore {
  private closed = false;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    (db as SearchDatabase).function('clawmaster_contains', { deterministic: true }, (value, search) => {
      if (typeof value !== 'string' || typeof search !== 'string') throw new Error('Enterprise search requires text.');
      return Number(value.toLowerCase().includes(search));
    });
  }

  /** Query responsibility metadata that is never replaced by business restore. */
  responsibility(value: unknown = {}) {
    this.assertOpen();
    return queryResponsibility(this.db, value);
  }

  /** Record a denied or cancelled action without storing its business body. */
  recordOutcome(identity: ExecutionIdentity, operation: string, outcome: 'denied' | 'cancelled' | 'failed', commandId: string | undefined, reasonCode: string): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const generation = this.generation();
      const revision = this.revision();
      appendResponsibility(this.db, { identity, operation, outcome, ...(commandId === undefined ? {} : { commandId }), reasonCode,
        generationBefore: generation, generationAfter: generation, revisionBefore: revision, revisionAfter: revision });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private assertOpen(): void {
    if (this.closed) throw new EnterpriseError('storage_unavailable', 'Enterprise storage is closed.');
  }

  private revision(): number {
    const result = this.db.prepare('SELECT revision FROM enterprise_meta WHERE singleton = 1').get();
    return z.object({ revision: integer }).strict().parse(result).revision;
  }

  private generation(): number {
    const row = this.db.prepare('SELECT generation FROM enterprise_meta WHERE singleton = 1').get();
    return z.object({ generation: integer }).strict().parse(row).generation;
  }

  private assertGeneration(expected: number): void {
    if (expected !== this.generation()) throw new EnterpriseError('revision_conflict', 'Enterprise data was restored. Reload before saving.', this.revision());
  }

  private contacts(): Contact[] {
    return this.db.prepare('SELECT * FROM contacts ORDER BY name, id').all().map(row => contactSchema.parse(row));
  }

  private items(): InventoryItem[] {
    return this.db.prepare('SELECT * FROM inventory ORDER BY sku, id').all().map(row => itemSchema.parse(row));
  }

  private orderFromRow(value: unknown): BusinessOrder {
    const header = sqliteRow.parse(value);
    const lines = this.db.prepare('SELECT itemId, quantity, unitPriceMinorUnits FROM order_lines WHERE orderId = ? ORDER BY position')
      .all(String(header.id));
    return orderSchema.parse({ ...header, lines });
  }

  private order(id: string): BusinessOrder | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return row === undefined ? undefined : this.orderFromRow(row);
  }

  private orders(): BusinessOrder[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY updatedAt DESC, id').all().map(row => this.orderFromRow(row));
  }

  private auditEntry(value: unknown): AuditEntry {
    const row = sqliteRow.parse(value);
    return auditSchema.parse({
      revision: row.revision, commandId: row.commandId, type: row.type, entityId: row.entityId,
      at: row.at, before: JSON.parse(String(row.beforeJson)), after: JSON.parse(String(row.afterJson)),
    });
  }

  private readSnapshot(): EnterpriseSnapshot {
    const revision = this.revision();
    const audit = this.db.prepare('SELECT revision, commandId, type, entityId, at, beforeJson, afterJson FROM enterprise_audit ORDER BY revision DESC')
      .all().map(value => this.auditEntry(value));
    return parseEnterpriseSnapshot({ generation: this.generation(), revision, contacts: this.contacts(), inventory: this.items(), orders: this.orders(), audit });
  }

  /**
   * Read a consistent full snapshot, including its audit history.
   * @returns Validated records observed in a single SQLite read transaction.
   */
  snapshot(): EnterpriseSnapshot {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const result = this.readSnapshot();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise records cannot be read.');
    }
  }

  /**
   * Read only the requested collection and page in one SQLite read transaction.
   * @param query Validated filters, revision and pagination fields.
   * @param maxBytes Maximum UTF-8 bytes in the returned page; an oversized first record fails.
   * @returns Matching record count and a bounded page without unrelated collections or audit history.
   */
  queryPage(query: EnterpriseQuerySpec, maxBytes: number): EnterpriseQueryPage {
    this.assertOpen();
    const source = collections[query.collection];
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.id !== undefined) {
      conditions.push(query.collection === 'audit' ? '(r.entityId = ? OR r.commandId = ?)' : 'r.id = ?');
      parameters.push(query.id);
      if (query.collection === 'audit') parameters.push(query.id);
    }
    if (query.search !== undefined) {
      conditions.push(`clawmaster_contains(${source.json}, ?) = 1`);
      parameters.push(query.search.toLowerCase());
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    this.db.exec('BEGIN');
    try {
      const revision = this.revision();
      const generation = this.generation();
      if ((query.revision !== undefined && (query.revision !== revision || (query.generation ?? 0) !== generation)) || (query.generation !== undefined && query.generation !== generation)) {
        throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Restart pagination.', revision);
      }
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM ${source.table} r${where}`).get(...parameters);
      const total = z.object({ total: integer }).strict().parse(count).total;
      const records: EnterpriseQueryPage['records'] = [];
      const page = (): EnterpriseQueryPage => ({
        generation, revision, collection: query.collection, offset: query.offset, total,
        nextOffset: query.offset + records.length < total ? query.offset + records.length : null, records,
      });
      const rows = this.db.prepare(`SELECT ${source.json} AS recordJson FROM ${source.table} r${where} ORDER BY ${source.order} LIMIT ? OFFSET ?`);
      for (const row of (rows as IterableStatement).iterate(...parameters, query.limit, query.offset)) {
        const serialized = z.object({ recordJson: z.string() }).strict().parse(row).recordJson;
        records.push(source.schema.parse(JSON.parse(serialized)));
        if (Buffer.byteLength(JSON.stringify(page()), 'utf8') > maxBytes) {
          records.pop();
          if (records.length === 0) throw new Error('result_too_large: A record exceeds maxQueryBytes. Increase the configured page byte budget to read it.');
          break;
        }
      }
      const result = page();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new EnterpriseError('storage_invalid', 'Enterprise page records cannot be read.');
      }
      throw error;
    }
  }

  /** Read a restore-capable backup, retaining command receipts for idempotent replay. */
  backup(identity: ExecutionIdentity = UNKNOWN_IDENTITY): EnterpriseBackup {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = this.readSnapshot();
      const auditCommands = this.db.prepare('SELECT revision, commandId, commandJson FROM enterprise_audit ORDER BY revision').all()
        .map(value => {
          const row = sqliteRow.parse(value);
          return { revision: integer.parse(row.revision), commandId: String(row.commandId) as EnterpriseBackup['auditCommands'][number]['commandId'], commandJson: String(row.commandJson) };
        });
      const result: EnterpriseBackup = { schemaVersion: 1, exportedAt: new Date().toISOString(), snapshot, auditCommands };
      appendResponsibility(this.db, { identity, operation: 'backup.export', outcome: 'succeeded',
        generationBefore: snapshot.generation, generationAfter: snapshot.generation, revisionBefore: snapshot.revision, revisionAfter: snapshot.revision,
        backupSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Restore a validated backup only when the caller proves the database has
   * not changed since its confirmation. The replacement and audit receipts
   * commit atomically; a failed validation or write leaves the current data.
   * @param value Complete backup envelope obtained from {@link backup}.
   * @param expectedRevision Revision the operator explicitly confirmed.
   * @param expectedGeneration Restore counter the operator observed; legacy callers belong to generation zero.
   * @returns The restored snapshot.
   */
  restore(value: unknown, expectedRevision: number, expectedGeneration = 0, identity: ExecutionIdentity = UNKNOWN_IDENTITY, commandId: string = randomUUID()): EnterpriseSnapshot {
    this.assertOpen();
    let backup: EnterpriseBackup;
    try { backup = parseEnterpriseBackup(value); }
    catch (error) { this.recordOutcome(identity, 'backup.restore', 'failed', commandId, 'backup_invalid'); throw error; }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new EnterpriseError('invalid_request', 'Restore confirmation revision is invalid.');
    }
    const commands = new Map(backup.auditCommands.map(entry => [entry.revision, entry.commandJson]));
    const backupSha256 = createHash('sha256').update(JSON.stringify(backup)).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify({ backupSha256, expectedGeneration, expectedRevision, actor: identity.actor, organizationId: identity.organizationId })).digest('hex');
    const before = { generation: this.generation(), revision: this.revision() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT requestHash FROM restore_receipts WHERE commandId = ?').get(commandId);
      if (receipt) {
        if (sqliteRow.parse(receipt).requestHash !== requestHash) throw new EnterpriseError('command_conflict', 'Restore identifier was used for a different request.');
        const result = this.readSnapshot();
        this.db.exec('COMMIT');
        return result;
      }
      this.assertGeneration(expectedGeneration);
      if (this.revision() !== expectedRevision) throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Refresh before restoring.', this.revision());
      if (!Number.isSafeInteger(expectedGeneration + 1)) throw new EnterpriseError('numeric_overflow', 'Enterprise restore counter exceeds the supported integer range.');
      this.db.exec('DELETE FROM order_lines; DELETE FROM orders; DELETE FROM contacts; DELETE FROM inventory; DELETE FROM enterprise_audit;');
      const insertContact = this.db.prepare('INSERT INTO contacts (id, name, company, stage, nextAction, nextActionDate, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.contacts) insertContact.run(row.id, row.name, row.company, row.stage, row.nextAction, row.nextActionDate, row.updatedAt);
      const insertItem = this.db.prepare('INSERT INTO inventory (id, sku, name, stock, reorderAt, supplier, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.inventory) insertItem.run(row.id, row.sku, row.name, row.stock, row.reorderAt, row.supplier, row.updatedAt);
      const insertOrder = this.db.prepare('INSERT INTO orders (id, kind, counterparty, orderDate, currency, status, totalMinorUnits, note, updatedAt, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertLine = this.db.prepare('INSERT INTO order_lines (orderId, position, itemId, quantity, unitPriceMinorUnits) VALUES (?, ?, ?, ?, ?)');
      for (const row of backup.snapshot.orders) {
        insertOrder.run(row.id, row.kind, row.counterparty, row.orderDate, row.currency, row.status, row.totalMinorUnits, row.note, row.updatedAt, row.submittedAt);
        row.lines.forEach((line, position) => insertLine.run(row.id, position, line.itemId, line.quantity, line.unitPriceMinorUnits));
      }
      const auditByRevision = new Map(backup.snapshot.audit.map(entry => [entry.revision, entry]));
      const insertAudit = this.db.prepare('INSERT INTO enterprise_audit (revision, commandId, type, entityId, at, commandJson, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (let revision = 1; revision <= backup.snapshot.revision; revision++) {
        const entry = auditByRevision.get(revision);
        const commandJson = commands.get(revision);
        if (!entry || commandJson === undefined) throw new EnterpriseError('storage_invalid', 'Enterprise backup audit revisions are incomplete.');
        insertAudit.run(entry.revision, entry.commandId, entry.type, entry.entityId, entry.at, commandJson, JSON.stringify(entry.before), JSON.stringify(entry.after));
      }
      this.db.prepare('UPDATE enterprise_meta SET revision = ?, generation = ? WHERE singleton = 1').run(backup.snapshot.revision, expectedGeneration + 1);
      appendResponsibility(this.db, { identity, operation: 'backup.restore', outcome: 'succeeded', commandId, backupSha256,
        generationBefore: before.generation, revisionBefore: before.revision,
        generationAfter: expectedGeneration + 1, revisionAfter: backup.snapshot.revision });
      this.db.prepare('INSERT INTO restore_receipts(commandId, requestHash, generation, revision) VALUES (?, ?, ?, ?)')
        .run(commandId, requestHash, expectedGeneration + 1, backup.snapshot.revision);
      const result = this.readSnapshot();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        appendResponsibility(this.db, { identity, operation: 'backup.restore', outcome: 'failed', commandId, backupSha256,
          generationBefore: before.generation, revisionBefore: before.revision, generationAfter: this.generation(), revisionAfter: this.revision(),
          reasonCode: error instanceof EnterpriseError ? error.code : 'transaction_failed' });
        this.db.exec('COMMIT');
      } catch (auditError) { this.db.exec('ROLLBACK'); throw new EnterpriseError('storage_unavailable', 'Restore failed and its failure could not be recorded.'); }
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise backup could not be restored.');
    }
  }

  private existingReceipt(request: EnterpriseCommandRequest): AuditEntry | undefined {
    const value = this.db.prepare('SELECT * FROM enterprise_audit WHERE commandId = ?').get(request.commandId);
    if (!value) return undefined;
    const row = sqliteRow.parse(value);
    if (row.commandJson !== JSON.stringify(request.command)) {
      throw new EnterpriseError('command_conflict', 'Command identifier was already used for a different command.');
    }
    return this.auditEntry(row);
  }

  /**
   * Read the target records for approval or find one exact committed receipt.
   * @param value Untrusted command envelope, identical to execute's input.
   * @returns Validated request, current revision and the affected records only.
   */
  prepare(value: unknown): EnterprisePreparation {
    this.assertOpen();
    const request = parseEnterpriseRequest(value);
    this.db.exec('BEGIN');
    try {
      this.assertGeneration(request.generation);
      const receipt = this.existingReceipt(request);
      const revision = this.revision();
      if (!receipt && request.revision !== revision) {
        throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Reload before saving.', revision);
      }
      const result: EnterprisePreparation = { request, generation: this.generation(), revision, before: null };
      if (receipt) result.receipt = receipt;
      else {
        const command = request.command;
        const id = 'id' in command ? command.id : 'contact' in command ? command.contact.id : 'item' in command ? command.item.id : command.order.id;
        if (command.type.startsWith('contact.')) {
          const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
          result.before = row === undefined ? null : contactSchema.parse(row);
        } else if (command.type.startsWith('item.')) {
          const row = this.db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
          result.before = row === undefined ? null : itemSchema.parse(row);
        } else {
          const order = this.order(id);
          result.before = order ?? null;
          if (command.type === 'order.submit' && order !== undefined) {
            result.inventory = order.lines.map(line => itemSchema.parse(this.requireRow('inventory', line.itemId)));
          }
        }
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise command cannot be prepared.');
    }
  }

  /**
   * Commit stock changes, revision, and audit together; replayed commands do not mutate again.
   * @param value Untrusted command request JSON.
   * @returns The full snapshot after the command or its idempotent replay.
   */
  execute(value: unknown, identity: ExecutionIdentity = UNKNOWN_IDENTITY): EnterpriseSnapshot {
    return this.commit(value, () => this.readSnapshot(), identity);
  }

  /**
   * Commit through the same transaction as manual saves and return one receipt.
   * @param value Untrusted command request JSON.
   * @returns Current revision and the committed or replayed audit entry, without a full snapshot.
   */
  executeReceipt(value: unknown, identity: ExecutionIdentity = UNKNOWN_IDENTITY): EnterpriseCommitReceipt {
    return this.commit(value, (revision, receipt) => ({ generation: this.generation(), revision, receipt }), identity);
  }

  private commit<T>(value: unknown, project: (revision: number, receipt: AuditEntry) => T, identity: ExecutionIdentity): T {
    this.assertOpen();
    const request = parseEnterpriseRequest(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertGeneration(request.generation);
      const existing = this.existingReceipt(request);
      const revision = this.revision();
      if (existing) {
        const result = project(revision, existing);
        this.db.exec('COMMIT');
        return result;
      }
      if (request.revision !== revision) throw new EnterpriseError('revision_conflict', 'Enterprise data changed. Reload before saving.', revision);
      if (!Number.isSafeInteger(revision + 1)) throw new EnterpriseError('numeric_overflow', 'Enterprise revision exceeds the supported integer range.');
      const at = new Date().toISOString();
      const change = this.apply(request.command, at);
      const receipt = auditSchema.parse({ revision: revision + 1, commandId: request.commandId, type: request.command.type, entityId: change.id, at, before: change.before, after: change.after });
      this.db.prepare('INSERT INTO enterprise_audit (revision, commandId, type, entityId, at, commandJson, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(revision + 1, request.commandId, request.command.type, change.id, at, JSON.stringify(request.command), JSON.stringify(change.before), JSON.stringify(change.after));
      this.db.prepare('UPDATE enterprise_meta SET revision = ? WHERE singleton = 1').run(revision + 1);
      appendResponsibility(this.db, { identity, operation: request.command.type, outcome: 'succeeded', commandId: request.commandId, entityId: change.id,
        generationBefore: request.generation, generationAfter: request.generation, revisionBefore: revision, revisionAfter: revision + 1 });
      const result = project(revision + 1, receipt);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.recordOutcome(identity, request.command.type, 'failed', request.commandId, error instanceof EnterpriseError ? error.code : 'transaction_failed');
      if (error instanceof EnterpriseError) throw error;
      throw new EnterpriseError('storage_invalid', 'Enterprise command could not be committed.');
    }
  }

  private apply(command: EnterpriseCommand, at: string): { id: string; before: unknown; after: unknown } {
    switch (command.type) {
      case 'contact.upsert': {
        const contact = { ...command.contact, updatedAt: at };
        const before = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) ?? null;
        this.db.prepare(`INSERT INTO contacts (id, name, company, stage, nextAction, nextActionDate, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, company=excluded.company, stage=excluded.stage, nextAction=excluded.nextAction, nextActionDate=excluded.nextActionDate, updatedAt=excluded.updatedAt`)
          .run(contact.id, contact.name, contact.company, contact.stage, contact.nextAction, contact.nextActionDate, at);
        return { id: contact.id, before, after: contact };
      }
      case 'contact.remove': {
        const before = this.requireRow('contacts', command.id);
        this.db.prepare('DELETE FROM contacts WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'item.upsert': {
        const item = { ...command.item, updatedAt: at };
        const duplicate = this.db.prepare('SELECT id FROM inventory WHERE sku = ? AND id <> ?').get(item.sku, item.id);
        if (duplicate) throw new EnterpriseError('duplicate_sku', 'Another inventory item already uses this SKU.');
        const before = this.db.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id) ?? null;
        this.db.prepare(`INSERT INTO inventory (id, sku, name, stock, reorderAt, supplier, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, name=excluded.name, stock=excluded.stock, reorderAt=excluded.reorderAt, supplier=excluded.supplier, updatedAt=excluded.updatedAt`)
          .run(item.id, item.sku, item.name, item.stock, item.reorderAt, item.supplier, at);
        return { id: item.id, before, after: item };
      }
      case 'item.remove': {
        const before = this.requireRow('inventory', command.id);
        if (this.db.prepare('SELECT orderId FROM order_lines WHERE itemId = ? LIMIT 1').get(command.id)) {
          throw new EnterpriseError('referenced_item', 'Inventory item is referenced by an order.');
        }
        this.db.prepare('DELETE FROM inventory WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'order.save': {
        const before = this.order(command.order.id) ?? null;
        if (before?.status === 'submitted') throw new EnterpriseError('submitted_order', 'Submitted orders cannot be changed.');
        for (const line of command.order.lines) this.requireRow('inventory', line.itemId);
        const order: BusinessOrder = { ...command.order, status: 'draft', totalMinorUnits: enterpriseOrderTotal(command.order), updatedAt: at, submittedAt: null };
        this.db.prepare(`INSERT INTO orders (id, kind, counterparty, orderDate, currency, status, totalMinorUnits, note, updatedAt, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, counterparty=excluded.counterparty, orderDate=excluded.orderDate, currency=excluded.currency, totalMinorUnits=excluded.totalMinorUnits, note=excluded.note, updatedAt=excluded.updatedAt`)
          .run(order.id, order.kind, order.counterparty, order.orderDate, order.currency, order.status, order.totalMinorUnits, order.note, at, null);
        this.db.prepare('DELETE FROM order_lines WHERE orderId = ?').run(order.id);
        const insert = this.db.prepare('INSERT INTO order_lines (orderId, position, itemId, quantity, unitPriceMinorUnits) VALUES (?, ?, ?, ?, ?)');
        order.lines.forEach((line, index) => insert.run(order.id, index, line.itemId, line.quantity, line.unitPriceMinorUnits));
        return { id: order.id, before, after: order };
      }
      case 'order.remove': {
        const before = this.order(command.id);
        if (!before) throw new EnterpriseError('not_found', 'Order does not exist.');
        if (before.status === 'submitted') throw new EnterpriseError('submitted_order', 'Submitted orders cannot be removed.');
        this.db.prepare('DELETE FROM orders WHERE id = ?').run(command.id);
        return { id: command.id, before, after: null };
      }
      case 'order.submit': {
        const order = this.order(command.id);
        if (!order) throw new EnterpriseError('not_found', 'Order does not exist.');
        if (order.status === 'submitted') throw new EnterpriseError('submitted_order', 'Order has already been submitted.');
        const beforeItems: InventoryItem[] = [];
        const afterItems: InventoryItem[] = [];
        for (const line of order.lines) {
          const item = itemSchema.parse(this.requireRow('inventory', line.itemId));
          const stock = item.stock + (order.kind === 'purchase' ? line.quantity : -line.quantity);
          if (stock < 0) throw new EnterpriseError('insufficient_stock', 'An order item has insufficient stock.');
          if (!Number.isSafeInteger(stock)) throw new EnterpriseError('numeric_overflow', 'Stock exceeds the supported integer range.');
          this.db.prepare('UPDATE inventory SET stock = ?, updatedAt = ? WHERE id = ?').run(stock, at, item.id);
          beforeItems.push(item);
          afterItems.push({ ...item, stock, updatedAt: at });
        }
        const submitted: BusinessOrder = { ...order, status: 'submitted', submittedAt: at, updatedAt: at };
        this.db.prepare("UPDATE orders SET status = 'submitted', submittedAt = ?, updatedAt = ? WHERE id = ?").run(at, at, order.id);
        return { id: order.id, before: { order, inventory: beforeItems }, after: { order: submitted, inventory: afterItems } };
      }
      default:
        command satisfies never;
        throw new EnterpriseError('invalid_request', 'Unknown enterprise command.');
    }
  }

  private requireRow(table: 'contacts' | 'inventory', id: string) {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new EnterpriseError('not_found', 'Enterprise record does not exist.');
    return row;
  }

  /** Release the connection after its routes have been removed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Open an owned database, adding a restore counter to schema 1 without replacing records.
 * @param databasePath SQLite file path; the caller supplies the DSH home location.
 * @param busyTimeoutMs Maximum SQLite writer-lock wait in milliseconds.
 * @returns An open database owner; callers must close it after removing its routes.
 */
export async function openEnterpriseStore(databasePath: string, busyTimeoutMs = 5000): Promise<EnterpriseStore> {
  z.number().int().min(0).max(60000).parse(busyTimeoutMs);
  if (databasePath !== ':memory:') {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    try {
      const file = await open(databasePath, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
    const app = sqliteRow.parse(db.prepare('PRAGMA application_id').get()).application_id;
    const version = sqliteRow.parse(db.prepare('PRAGMA user_version').get()).user_version;
    const empty = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0;
    const fresh = app === 0 && version === 0 && empty;
    if (!(app === APPLICATION_ID && (version === 1 || version === 2 || version === SCHEMA_VERSION)) && !fresh) {
      throw new EnterpriseError('storage_invalid', 'Enterprise database version or ownership is unsupported.');
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (fresh) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS enterprise_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)) STRICT;
      INSERT OR IGNORE INTO enterprise_meta VALUES (1,0,0);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, stage TEXT NOT NULL, nextAction TEXT NOT NULL, nextActionDate TEXT, updatedAt TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, stock INTEGER NOT NULL CHECK(stock>=0), reorderAt INTEGER NOT NULL CHECK(reorderAt>=0), supplier TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('purchase','sale')), counterparty TEXT NOT NULL, orderDate TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','submitted')), totalMinorUnits INTEGER NOT NULL CHECK(totalMinorUnits>=0), note TEXT NOT NULL, updatedAt TEXT NOT NULL, submittedAt TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS order_lines (orderId TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, position INTEGER NOT NULL, itemId TEXT NOT NULL REFERENCES inventory(id), quantity INTEGER NOT NULL CHECK(quantity>0), unitPriceMinorUnits INTEGER NOT NULL CHECK(unitPriceMinorUnits>=0), PRIMARY KEY(orderId,itemId), UNIQUE(orderId,position)) STRICT;
      CREATE TABLE IF NOT EXISTS enterprise_audit (revision INTEGER PRIMARY KEY, commandId TEXT NOT NULL UNIQUE, type TEXT NOT NULL, entityId TEXT NOT NULL, at TEXT NOT NULL, commandJson TEXT NOT NULL CHECK(json_valid(commandJson)), beforeJson TEXT NOT NULL CHECK(json_valid(beforeJson)), afterJson TEXT NOT NULL CHECK(json_valid(afterJson))) STRICT;
      PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;
    `);
    if (app === APPLICATION_ID && version === 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (sqliteRow.parse(db.prepare('PRAGMA user_version').get()).user_version === 1) {
          db.exec('ALTER TABLE enterprise_meta ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0);');
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      initializeResponsibilityHistory(db);
      verifyResponsibility(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (sqliteRow.parse(db.prepare('PRAGMA quick_check').get()).quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new EnterpriseError('storage_invalid', 'Enterprise database integrity check failed.');
    }
    const store = new EnterpriseStore(db);
    store.snapshot();
    return store;
  } catch (error) {
    db.close();
    if (error instanceof EnterpriseError) throw error;
    throw new EnterpriseError('storage_invalid', 'Enterprise database could not be opened.');
  }
}

/** Minimal public DSH Connection Fetch registry, whose carrier owns authentication and origin checks. */
export interface EnterpriseHostContext {
  connection: { fetch: { register(route: {
    path: string; methods: readonly ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> } };
}

function errorResponse(error: unknown): Response {
  const failure = error instanceof EnterpriseError ? error
    : new EnterpriseError('storage_unavailable', 'Enterprise storage is unavailable.');
  const status = failure.code === 'invalid_request' ? 400 : failure.code === 'not_found' ? 404
    : failure.code === 'storage_invalid' || failure.code === 'storage_unavailable' ? 503 : 409;
  return Response.json({ error: {
    code: failure.code, message: failure.message,
    ...(failure.currentRevision === undefined ? {} : { currentRevision: failure.currentRevision }),
  } }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Register routes on DSH's authenticated Fetch carrier; owns no listener.
 * @param ctx DSH Host context with the Fetch registration service.
 * @param config Persistent database location and optional writer-lock wait.
 * @returns Idempotent cleanup that removes routes, drains work and closes SQLite.
 */
export async function applyEnterpriseHost(ctx: EnterpriseHostContext, config: {
  databasePath: string;
  /** SQLite writer-lock wait, in milliseconds; 0 refuses contention immediately. */
  busyTimeoutMs?: number;
}): Promise<() => Promise<void>> {
  const store = await openEnterpriseStore(config.databasePath, config.busyTimeoutMs);
  try {
    const remove = await mountEnterpriseRoutes(ctx, store);
    return async () => { try { await remove(); } finally { store.close(); } };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Mount the browser routes over a shared enterprise store.
 * @param ctx DSH's authenticated Fetch registry.
 * @param store Database shared with other enterprise consumers.
 * @returns Idempotent route withdrawal and request drain; the caller closes the store afterward.
 */
export async function mountEnterpriseRoutes(ctx: EnterpriseHostContext, store: EnterpriseStore): Promise<() => Promise<void>> {
  const disposers: (() => Promise<void>)[] = [];
  const pending = new Set<Promise<Response>>();
  let closing = false;
  let disposing: Promise<void> | undefined;
  const handle = (operation: (request: Request) => Promise<unknown>) => (request: Request): Promise<Response> => {
    if (closing) return Promise.resolve(errorResponse(new EnterpriseError('storage_unavailable', 'Enterprise routes are closed.')));
    const response = operation(request).then(snapshot => Response.json(snapshot, {
      headers: { 'cache-control': 'no-store' },
    })).catch(errorResponse);
    pending.add(response);
    void response.finally(() => pending.delete(response));
    return response;
  };
  const dispose = () => {
    if (disposing) return disposing;
    closing = true;
    disposing = (async () => {
      const removed = await Promise.allSettled(disposers.map(async remove => remove()));
      await Promise.allSettled(pending);
      const failed = removed.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Enterprise routes could not be removed.');
    })();
    return disposing;
  };
  try {
    disposers.push(ctx.connection.fetch.register({
      path: '/api/clawmaster/enterprise/responsibility', methods: ['GET'], requestBody: 'buffered',
      fetch: handle(async request => {
        const search = new URL(request.url).searchParams;
        return store.responsibility({ after: Number(search.get('after') ?? 0), limit: Number(search.get('limit') ?? 100),
          ...Object.fromEntries(['actorId', 'commandId', 'entityId', 'operation'].filter(key => search.has(key)).map(key => [key, search.get(key)])) });
      }),
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_SNAPSHOT_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: handle(async () => store.snapshot()),
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_BACKUP_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: handle(async request => {
        if (closing || request.signal.aborted) throw new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.');
        return store.backup(LOCAL_HTTP_IDENTITY);
      }),
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_RESTORE_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async request => {
        if (closing || request.signal.aborted) throw new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.');
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new EnterpriseError('invalid_request', 'Enterprise restore requires application/json.');
        let value: unknown;
        try { value = await request.json(); } catch { throw new EnterpriseError('invalid_request', 'Enterprise restore JSON is malformed.'); }
        if (closing || request.signal.aborted) throw new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.');
        const restore = parseEnterpriseRestoreRequest(value);
        return store.restore(restore.backup, restore.expectedRevision, restore.expectedGeneration, LOCAL_HTTP_IDENTITY, restore.commandId);
      }),
    }));
    disposers.push(ctx.connection.fetch.register({
      path: ENTERPRISE_COMMAND_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async request => {
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new EnterpriseError('invalid_request', 'Enterprise commands require application/json.');
        }
        let value: unknown;
        try { value = await request.json(); }
        catch { throw new EnterpriseError('invalid_request', 'Enterprise command JSON is malformed.'); }
        if (closing || request.signal.aborted) throw new EnterpriseError('storage_unavailable', 'Enterprise request was cancelled.');
        return store.execute(value, LOCAL_HTTP_IDENTITY);
      }),
    }));
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
