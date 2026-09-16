/** Responsibility records survive business backup restores; local hashes detect accidental edits, not a hostile machine owner. */
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';

const sqliteRow = z.record(z.string(), z.unknown());
interface IterableStatement extends StatementSync { iterate(): IterableIterator<unknown>; }

/** Trusted caller facts resolved by the Host, never parsed from command JSON. */
export interface ExecutionIdentity {
  actor: { kind: 'local-human' | 'member' | 'agent' | 'unknown'; id: string };
  organizationId: string;
  source: 'http' | 'tool' | 'scheduler' | 'plugin' | 'migration';
  policyVersion: number;
  sessionId?: string;
  callId?: string;
  approval?: { id: string; approverId: string; generation: number; revision: number };
}

/** Local desktop identity names the authenticated device operator, not an organization member. */
export const LOCAL_HTTP_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'local-human', id: 'local-operator' }),
  organizationId: 'local', source: 'http', policyVersion: 1,
});

/** Direct maintenance calls without an authenticated carrier retain an unknown actor. */
export const UNKNOWN_IDENTITY: ExecutionIdentity = Object.freeze({
  actor: Object.freeze({ kind: 'unknown', id: 'unknown' }),
  organizationId: 'local', source: 'plugin', policyVersion: 0,
});

/** Only identifiers, operation metadata and digests enter responsibility history. */
export interface ResponsibilityInput {
  identity: ExecutionIdentity;
  operation: string;
  outcome: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'legacy';
  commandId?: string;
  entityId?: string;
  generationBefore: number;
  revisionBefore: number;
  generationAfter: number;
  revisionAfter: number;
  backupSha256?: string;
  reasonCode?: string;
}

/** A hash links the exact persisted JSON to its predecessor. */
export interface ResponsibilityRecord extends ResponsibilityInput {
  sequence: number;
  at: string;
  previousHash: string;
  hash: string;
}

/** Install independent history and import old receipts once, with explicitly unknown actors. */
export function initializeResponsibilityHistory(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS responsibility_history (
    sequence INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), hash TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS restore_receipts (
    commandId TEXT PRIMARY KEY, requestHash TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_update BEFORE UPDATE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS responsibility_no_delete BEFORE DELETE ON responsibility_history
    BEGIN SELECT RAISE(ABORT, 'Responsibility history is append-only'); END;`);
  if (db.prepare('SELECT sequence FROM responsibility_history LIMIT 1').get()) return;
  const meta = sqliteRow.parse(db.prepare('SELECT generation FROM enterprise_meta WHERE singleton=1').get());
  const generation = Number(meta.generation);
  for (const value of db.prepare('SELECT revision, commandId, type, entityId FROM enterprise_audit ORDER BY revision').all()) {
    const row = sqliteRow.parse(value);
    appendResponsibility(db, { identity: { ...UNKNOWN_IDENTITY, source: 'migration' }, operation: String(row.type), outcome: 'legacy',
      commandId: String(row.commandId), entityId: String(row.entityId), generationBefore: generation, generationAfter: generation,
      revisionBefore: Number(row.revision) - 1, revisionAfter: Number(row.revision), reasonCode: 'legacy_actor_unknown' });
  }
}

/** Append inside the owning transaction so a successful mutation and its receipt commit together. */
export function appendResponsibility(db: DatabaseSync, input: ResponsibilityInput): ResponsibilityRecord {
  const previous = sqliteRow.optional().parse(db.prepare('SELECT sequence, hash FROM responsibility_history ORDER BY sequence DESC LIMIT 1').get());
  const body = { sequence: Number(previous?.sequence ?? 0) + 1, at: new Date().toISOString(), previousHash: String(previous?.hash ?? ''), ...input };
  const encoded = JSON.stringify(body);
  const hash = createHash('sha256').update(encoded).digest('hex');
  db.prepare('INSERT INTO responsibility_history(sequence, body, hash) VALUES (?, ?, ?)').run(body.sequence, encoded, hash);
  return { ...body, hash };
}

const querySchema = z.object({
  after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100),
  actorId: z.string().max(128).optional(), commandId: z.string().max(128).optional(),
  entityId: z.string().max(128).optional(), operation: z.string().max(128).optional(),
}).strict();

/** Read a bounded page; filters use stored metadata rather than business record bodies. */
export function queryResponsibility(db: DatabaseSync, value: unknown): { records: ResponsibilityRecord[]; nextAfter: number | null } {
  const query = querySchema.parse(value);
  const predicates = ['sequence > ?'];
  const parameters: (string | number)[] = [query.after];
  for (const [key, path] of [['actorId', '$.identity.actor.id'], ['commandId', '$.commandId'], ['entityId', '$.entityId'], ['operation', '$.operation']] as const) {
    if (query[key] !== undefined) { predicates.push(`json_extract(body, '${path}') = ?`); parameters.push(query[key]); }
  }
  const rows = db.prepare(`SELECT body, hash FROM responsibility_history WHERE ${predicates.join(' AND ')} ORDER BY sequence LIMIT ?`).all(...parameters, query.limit + 1);
  const records = rows.slice(0, query.limit).map(value => {
    const row = sqliteRow.parse(value);
    return { ...JSON.parse(String(row.body)) as Omit<ResponsibilityRecord, 'hash'>, hash: String(row.hash) };
  });
  return { records, nextAfter: rows.length > query.limit ? records.at(-1)!.sequence : null };
}

/** Validate the complete hash chain without loading the business database into memory. */
export function verifyResponsibility(db: DatabaseSync): void {
  let sequence = 0;
  let previousHash = '';
  for (const value of (db.prepare('SELECT sequence, body, hash FROM responsibility_history ORDER BY sequence') as IterableStatement).iterate()) {
    const row = sqliteRow.parse(value);
    const body = JSON.parse(String(row.body)) as ResponsibilityRecord;
    if (Number(row.sequence) !== ++sequence || body.sequence !== sequence || body.previousHash !== previousHash
      || createHash('sha256').update(String(row.body)).digest('hex') !== row.hash) throw new Error('Responsibility history integrity check failed.');
    previousHash = String(row.hash);
  }
}
