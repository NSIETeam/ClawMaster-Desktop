# Agent Note: Enterprise responsibility history survives restore

Status: implemented

English | [中文](2026-09-16-enterprise-responsibility-history.zh.md)

## Problem

A business backup replaces records and their revisioned before/after audit. Treating that history as the sole responsibility log erases the evidence for intervening writes when a backup is restored.

## Decision

SQLite schema 3 owns an append-only responsibility table outside the restore payload. Successful writes and responsibility entries share the business transaction. Restore records retain the backup digest and both revision/generation pairs; independent receipts make explicit restore retries idempotent after a lost response. Failed, denied and cancelled operations record distinct outcomes. Request JSON cannot choose actor or approval fields. HTTP identifies the authenticated local device operator; tools identify the owning Session and call, with a server-minted approval reference. Existing business history imports with unknown actor metadata.

The [business backup decision](../feature/2026-09-14-enterprise-snapshot-backup.md) remains authoritative for portable business snapshots and exact stock restoration. Responsibility history is separate and is neither replaced nor exported by that operation.

## Alternatives considered

**Keeping responsibility in the restored business audit.** Replacing that table necessarily loses evidence about changes made after the backup.

**A separate append-only file.** A file append cannot commit atomically with SQLite mutations. The shared database transaction prevents a successful business change without its success record.

## Consequences

Hash verification detects local inconsistency, not a malicious machine administrator who can replace the entire database. Enterprise retention still requires an independently controlled archive. History grows until an explicit retention design is implemented. The migration does not invent old identities. Governance tests cover restore continuity, response-loss replay, transaction failure, forged actor fields, audit-write rollback, old-schema import and hash-chain damage. A real organization identity provider and desktop business acceptance remain separate integration work.
