/** CRM/ERP queries and approval-gated mutations over the shared SQLite owner. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ExecutionIdentity } from './governance-audit.ts';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type ApprovalService from '@deepseek-ai/dsh-user-approval';
import type { EnterpriseStore, EnterprisePreparation } from './enterprise-host.ts';
import { EnterpriseError, enterpriseId } from './enterprise-types.ts';
import type { AuditEntry } from './enterprise-types.ts';
import {
  enterpriseCommandOutput, enterpriseCommandParameters,
  enterpriseQueryOutput, enterpriseQueryParameters,
} from './enterprise-tool-schemas.ts';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const querySchema = z.object({
  collection: z.enum(['contacts', 'inventory', 'orders', 'audit']),
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).transform(enterpriseId).optional(),
  search: z.string().trim().max(2000).optional(),
  offset: safeInteger, limit: safeInteger.min(1), revision: safeInteger.optional(), generation: safeInteger.optional(),
}).strict();
const commandEnvelope = z.object({ request: z.unknown() }).strict();
const configSchema = z.object({
  maxQueryRows: safeInteger.min(1).default(100),
  maxQueryBytes: safeInteger.min(1024).default(262144),
}).strict();

/** Deployment bounds for one model-visible query page. */
export interface EnterpriseToolConfig {
  /** Maximum records per page; defaults to 100. */
  maxQueryRows?: number;
  /** UTF-8 byte budget for a page; defaults to 262144. An oversized record fails explicitly. */
  maxQueryBytes?: number;
}

/** Only the public DSH tool-registration and approval methods are consumed. */
export interface EnterpriseToolContext {
  tools: Pick<ToolRuntime, 'register'>;
  approval: Pick<ApprovalService, 'request'>;
}

function fail(error: unknown): never {
  if (error instanceof z.ZodError) throw new Error('invalid_request: Enterprise tool fields are invalid.');
  if (error instanceof EnterpriseError) {
    throw new Error(`${error.code}: ${error.message}${error.currentRevision === undefined ? '' : ` Current revision: ${error.currentRevision}.`}`);
  }
  throw error;
}

function receipt(generation: number, revision: number, entry: AuditEntry) {
  return {
    generation, revision, commandId: entry.commandId, commandRevision: entry.revision,
    entityId: entry.entityId, type: entry.type, at: entry.at,
  };
}

function approvalReason(prepared: EnterprisePreparation): string {
  const { request, before, inventory } = prepared;
  return `Approve ${request.command.type} at enterprise revision ${request.revision}. This changes business records${inventory ? ' and stock' : ''}. Review the exact command and current records: ${JSON.stringify({ command: request.command, before, ...(inventory ? { inventory } : {}) })}`;
}

function readPage(store: EnterpriseStore, value: unknown, config: z.output<typeof configSchema>) {
  const query = querySchema.parse(value);
  if (query.limit > config.maxQueryRows) throw new Error(`invalid_request: limit must not exceed ${config.maxQueryRows}.`);
  return store.queryPage(query, config.maxQueryBytes);
}

/**
 * Register query and mutation tools over the same store used by browser routes.
 * @param ctx Public DSH tools and approval services; tool registration is fiber-owned.
 * @param store Shared, open database owner.
 * @param options Query limits configured by the deployment.
 * @returns Idempotent withdrawal, cancellation and drain. Close the store only after this and route cleanup settle.
 */
export async function applyEnterpriseTools(ctx: EnterpriseToolContext, store: EnterpriseStore, options: EnterpriseToolConfig = {}): Promise<() => Promise<void>> {
  const config = configSchema.parse(options);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const removals: (() => void)[] = [];
  let disposing: Promise<void> | undefined;
  const run = (exec: ToolRunContext, action: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
    const signal = AbortSignal.any([lifetime.signal, exec.signal]);
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }).catch(fail);
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    lifetime.abort(new Error('Enterprise tools were unloaded.'));
    disposing = (async () => {
      const removed = await Promise.allSettled(removals.map(async remove => remove()));
      await Promise.allSettled(pending);
      const errors = removed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Enterprise tools could not be removed.');
    })();
    return disposing;
  };
  const definitions: ToolDefinition[] = [{
    name: 'enterprise_query',
    description: `Query CRM contacts, inventory, purchase/sale orders or the durable audit log. Select one collection and filter by id or search; use offset/limit (maximum ${config.maxQueryRows}) and nextOffset to page. Carry generation and revision across pages and into writes. Results are limited to ${config.maxQueryBytes} UTF-8 bytes; a page may contain fewer rows than requested. Money is in CNY minor units.`,
    parameters: enterpriseQueryParameters,
    output: { schema: enterpriseQueryOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => run(exec, async () => readPage(store, args, config)),
    presentCall: args => querySchema.safeParse(args).success ? { card: 'generic', title: 'Query enterprise records', kind: 'search', rawInput: JSON.stringify(args) } : undefined,
    presentResult: (_args, result) => ({ card: 'generic', title: 'Enterprise query', content: result.content }),
  }, {
    name: 'enterprise_command',
    description: 'Create or update a CRM contact, create/edit an order draft, maintain inventory, submit an order, or delete a record. Pass the complete fields, current enterprise_query generation and revision, and a unique commandId; retry an identical request with the same commandId. Every new business mutation, including contact.upsert and order.save, requires an explicit one-shot DSH approval; never assume approval from a prior action. Sessions with never approval, including read-only delegated sessions, cannot commit changes. Submitting a purchase adds stock; submitting a sale deducts it. Submitted orders are immutable. All changes and before/after audit facts commit atomically; the receipt identifies the audit revision.',
    parameters: enterpriseCommandParameters,
    output: {
      schema: enterpriseCommandOutput,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => run(exec, async signal => {
      if (!exec.agent) throw new Error('enterprise_command requires an owning DSH agent session.');
      const identity: ExecutionIdentity = { actor: { kind: 'agent', id: exec.agent.id }, organizationId: 'local', source: 'tool',
        policyVersion: 1, sessionId: exec.agent.id, callId: exec.callId };
      const prepared = store.prepare(commandEnvelope.parse(args).request);
      if (prepared.receipt) return receipt(prepared.generation, prepared.revision, prepared.receipt);
      const { request } = prepared;
      const outcome = await ctx.approval.request({
        agent: exec.agent, callId: exec.callId, toolName: exec.name,
        reason: approvalReason(prepared), signal,
      });
      if (outcome !== 'allowed-once') {
        store.recordOutcome(identity, request.command.type, outcome === 'cancelled' ? 'cancelled' : 'denied', request.commandId, `approval_${outcome}`);
        throw new Error(`approval_${outcome}: Enterprise command was not committed.`);
      }
      identity.approval = { id: randomUUID(), approverId: 'local-operator', generation: request.generation, revision: request.revision };
      signal.throwIfAborted();
      const committed = store.executeReceipt(request, identity);
      return receipt(committed.generation, committed.revision, committed.receipt);
    }),
    presentCall: args => commandEnvelope.safeParse(args).success ? { card: 'generic', title: 'Change enterprise records', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Enterprise change failed' : 'Enterprise change committed', content: result.content }),
  }];
  try {
    for (const definition of definitions) removals.push(ctx.tools.register(definition));
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
