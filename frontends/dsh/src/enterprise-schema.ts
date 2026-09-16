/** Browser-safe validation shared by HTTP clients and SQLite record readers. */
import { z } from 'zod';
import { enterpriseId, EnterpriseError } from './enterprise-types.ts';
import type { EnterpriseBackup, EnterpriseCommandRequest, EnterpriseSnapshot, OrderInput } from './enterprise-types.ts';

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).transform(enterpriseId);
const shortText = z.string().trim().max(200);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const timestamp = z.string().datetime();
const contactInput = z.object({
  id: identifier, name: shortText.min(1), company: shortText,
  stage: z.enum(['lead', 'contacted', 'proposal', 'won', 'lost']),
  nextAction: z.string().trim().max(2000), nextActionDate: calendarDate.nullable(),
}).strict();
const itemInput = z.object({
  id: identifier, sku: shortText.min(1), name: shortText.min(1), stock: integer,
  reorderAt: integer, supplier: shortText,
}).strict();
const lineSchema = z.object({
  itemId: identifier, quantity: integer.min(1), unitPriceMinorUnits: integer,
}).strict();
const orderFields = {
  id: identifier, kind: z.enum(['purchase', 'sale']), counterparty: shortText.min(1),
  orderDate: calendarDate, currency: z.literal('CNY'),
  lines: z.array(lineSchema).min(1), note: z.string().trim().max(2000),
};
const distinctLines = (order: OrderInput) => new Set(order.lines.map(line => line.itemId)).size === order.lines.length;
const orderInput = z.object(orderFields).strict().refine(distinctLines);
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('contact.upsert'), contact: contactInput }).strict(),
  z.object({ type: z.literal('contact.remove'), id: identifier }).strict(),
  z.object({ type: z.literal('item.upsert'), item: itemInput }).strict(),
  z.object({ type: z.literal('item.remove'), id: identifier }).strict(),
  z.object({ type: z.literal('order.save'), order: orderInput }).strict(),
  z.object({ type: z.literal('order.remove'), id: identifier }).strict(),
  z.object({ type: z.literal('order.submit'), id: identifier }).strict(),
]);
// Legacy requests belong only to the initial, never-restored database generation.
const requestSchema = z.object({ generation: integer.default(0), revision: integer, commandId: identifier, command: commandSchema }).strict();

/** Stored contact JSON, including its modification time. */
export const contactSchema = contactInput.extend({ updatedAt: timestamp });
/** Stored inventory JSON, including safe integral stock counts. */
export const itemSchema = itemInput.extend({ updatedAt: timestamp });
/** Stored order JSON; totals and submission times must agree with the order. */
export const orderSchema = z.object({
  ...orderFields, status: z.enum(['draft', 'submitted']), totalMinorUnits: integer,
  updatedAt: timestamp, submittedAt: timestamp.nullable(),
}).strict().refine(order => {
  const total = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinorUnits, 0);
  return distinctLines(order) && Number.isSafeInteger(total) && total === order.totalMinorUnits
    && (order.status === 'submitted') === (order.submittedAt !== null);
});
const auditFields = { revision: integer.min(1), commandId: identifier, entityId: identifier, at: timestamp };
const stockChange = z.object({ order: orderSchema, inventory: z.array(itemSchema) }).strict();
/** Audit JSON retains typed before/after facts for each accepted business action. */
export const auditSchema = z.discriminatedUnion('type', [
  z.object({ ...auditFields, type: z.literal('contact.upsert'), before: contactSchema.nullable(), after: contactSchema }).strict(),
  z.object({ ...auditFields, type: z.literal('contact.remove'), before: contactSchema, after: z.null() }).strict(),
  z.object({ ...auditFields, type: z.literal('item.upsert'), before: itemSchema.nullable(), after: itemSchema }).strict(),
  z.object({ ...auditFields, type: z.literal('item.remove'), before: itemSchema, after: z.null() }).strict(),
  z.object({ ...auditFields, type: z.literal('order.save'), before: orderSchema.nullable(), after: orderSchema }).strict(),
  z.object({ ...auditFields, type: z.literal('order.remove'), before: orderSchema, after: z.null() }).strict(),
  z.object({ ...auditFields, type: z.literal('order.submit'), before: stockChange, after: stockChange }).strict(),
]).refine(entry => {
  if (entry.type === 'order.submit') return entry.before.order.id === entry.entityId && entry.after.order.id === entry.entityId
    && entry.before.order.status === 'draft' && entry.after.order.status === 'submitted';
  return (entry.before === null || entry.before.id === entry.entityId) && (entry.after === null || entry.after.id === entry.entityId);
});
const snapshotSchema = z.object({
  generation: integer.default(0), revision: integer, contacts: z.array(contactSchema), inventory: z.array(itemSchema),
  orders: z.array(orderSchema), audit: z.array(auditSchema),
}).strict().refine(snapshot => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  const itemIds = new Set(snapshot.inventory.map(item => item.id));
  return unique(snapshot.contacts.map(contact => contact.id))
    && unique(snapshot.inventory.map(item => item.id)) && unique(snapshot.inventory.map(item => item.sku))
    && unique(snapshot.orders.map(order => order.id)) && unique(snapshot.audit.map(entry => entry.commandId))
    && snapshot.orders.every(order => order.lines.every(line => itemIds.has(line.itemId)))
    && snapshot.audit.length === snapshot.revision
    && snapshot.audit.every((entry, index) => entry.revision === snapshot.revision - index);
});
const backupSchema = z.object({
  schemaVersion: z.literal(1), exportedAt: timestamp, snapshot: snapshotSchema,
  auditCommands: z.array(z.object({ revision: integer.min(1), commandId: identifier, commandJson: z.string().min(2) }).strict()),
}).strict().superRefine((backup, context) => {
  if (backup.auditCommands.length !== backup.snapshot.audit.length) {
    context.addIssue({ code: 'custom', message: 'Backup command receipts do not cover the complete audit history.' });
    return;
  }
  const byRevision = new Map(backup.auditCommands.map(entry => [entry.revision, entry]));
  for (const entry of backup.snapshot.audit) {
    const receipt = byRevision.get(entry.revision);
    if (!receipt || receipt.commandId !== entry.commandId) {
      context.addIssue({ code: 'custom', message: 'Backup command receipt does not match its audit entry.' });
      return;
    }
    try {
      const command = commandSchema.parse(JSON.parse(receipt.commandJson));
      let expected: unknown;
      switch (entry.type) {
        case 'contact.upsert': {
          const { updatedAt: _updatedAt, ...contact } = entry.after;
          expected = { type: entry.type, contact }; break;
        }
        case 'item.upsert': {
          const { updatedAt: _updatedAt, ...item } = entry.after;
          expected = { type: entry.type, item }; break;
        }
        case 'order.save': {
          const { updatedAt: _updatedAt, submittedAt: _submittedAt, status: _status, totalMinorUnits: _total, ...order } = entry.after;
          expected = { type: entry.type, order }; break;
        }
        default: expected = { type: entry.type, id: entry.entityId };
      }
      if (JSON.stringify(command) !== JSON.stringify(commandSchema.parse(expected))) {
        context.addIssue({ code: 'custom', message: 'Backup command content differs from its audit record.' }); return;
      }
    } catch { context.addIssue({ code: 'custom', message: 'Backup command JSON is invalid.' }); return; }
  }
});

/**
 * Validate JSON before it enters an enterprise transaction.
 * @param value Parsed request JSON from the HTTP carrier.
 * @returns The validated command and concurrency identifiers.
 */
export function parseEnterpriseRequest(value: unknown): EnterpriseCommandRequest {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new EnterpriseError('invalid_request', 'Enterprise command fields are invalid.');
  return result.data;
}

/**
 * Validate a complete snapshot from SQLite or an HTTP response.
 * @param value Untrusted records or parsed response JSON.
 * @returns Validated records with contiguous audit revisions, or throws storage_invalid.
 */
export function parseEnterpriseSnapshot(value: unknown): EnterpriseSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new EnterpriseError('storage_invalid', 'Enterprise snapshot fields are invalid.');
  return result.data;
}

/** Validate a complete restore-capable backup envelope. */
export function parseEnterpriseBackup(value: unknown): EnterpriseBackup {
  const result = backupSchema.safeParse(value);
  if (!result.success) throw new EnterpriseError('storage_invalid', 'Enterprise backup fields are invalid.');
  return result.data;
}

/** Validate the explicit restore request envelope before opening SQLite. */
export function parseEnterpriseRestoreRequest(value: unknown): { expectedGeneration: number; expectedRevision: number; confirm: true; backup: EnterpriseBackup; commandId?: string } {
  const result = z.object({ expectedGeneration: integer.default(0), expectedRevision: integer, confirm: z.literal(true), backup: backupSchema, commandId: identifier.optional() }).strict().safeParse(value);
  if (!result.success) throw new EnterpriseError('invalid_request', 'Enterprise restore confirmation is invalid.');
  return result.data;
}

/**
 * Compute integer monetary totals without rounding or unsafe arithmetic.
 * @param order Validated order input.
 * @returns The total in CNY minor units, or throws numeric_overflow.
 */
export function enterpriseOrderTotal(order: OrderInput): number {
  let total = 0;
  for (const line of order.lines) {
    const amount = line.quantity * line.unitPriceMinorUnits;
    total += amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) {
      throw new EnterpriseError('numeric_overflow', 'Order total exceeds the supported integer range.');
    }
  }
  return total;
}
