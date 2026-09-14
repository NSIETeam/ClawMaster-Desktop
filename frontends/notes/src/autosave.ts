/** Session-owned, revision-checked note saves outlive the panel that edits them. */
import { NotesApiError, type NotesApi } from './notes-api.ts';
import { extractLinks, noteTitle, parseFrontmatter } from './note-format.ts';
import type { NoteRead } from './protocol.ts';

/** The last acknowledged file and the latest local text, including failed saves. */
export interface NoteDraft {
  note: NoteRead;
  text: string;
  failure?: { error: unknown };
}

const SAVE_DELAY_MS = 600;

/**
 * One session's serial write queue; failures retain drafts until explicit retry or reload.
 * The constructor receives the authenticated Notes command transport.
 */
export class NotesAutosave {
  readonly drafts = new Map<string, NoteDraft>();
  readonly #heads = new Map<string, NoteRead>();
  readonly #saved = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #queue = new Set<string>();
  readonly #flushing = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #running: Promise<void> | undefined;
  #saving: string | undefined;
  #version = 0;

  constructor(private readonly api: Pick<NotesApi, 'command'>) {}

  /**
   * Subscribe to draft, acknowledged revision and save-state changes.
   * @param listener Called when this store's snapshot changes.
   * @returns A function that removes the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /**
   * Read the version consumed by React's external-store subscription.
   * @returns The current monotonically increasing snapshot version.
   */
  readonly getSnapshot = (): number => this.#version;

  /**
   * Remember a fresh read without replacing an outstanding draft.
   * @param note The file returned by the Notes read route.
   */
  remember(note: NoteRead): void {
    if (!this.drafts.has(note.id)) this.#heads.set(note.id, note);
  }

  /**
   * Read the newest acknowledged file.
   * @param id The vault-relative file identifier.
   * @returns The acknowledged file, or undefined before a read or save.
   */
  head(id: string): NoteRead | undefined { return this.#heads.get(id); }

  /**
   * Check whether a file is awaiting a write receipt.
   * @param id The vault-relative file identifier.
   * @returns Whether a request for that file is in flight.
   */
  saving(id: string): boolean { return this.#saving === id; }

  /**
   * Check whether this session has saved a file.
   * @param id The vault-relative file identifier.
   * @returns Whether at least one save was acknowledged.
   */
  saved(id: string): boolean { return this.#saved.has(id); }

  /**
   * Retain an edit, then save after a quiet interval unless a save failed.
   * @param note The acknowledged file the edit started from.
   * @param text The complete latest draft, including frontmatter.
   */
  edit(note: NoteRead, text: string): void {
    const head = this.#heads.get(note.id) ?? note;
    this.#heads.set(note.id, head);
    const previous = this.drafts.get(note.id);
    this.#cancelTimer(note.id);
    if (text === head.text && this.#saving !== note.id && !previous?.failure) {
      this.drafts.delete(note.id);
      this.#queue.delete(note.id);
    } else {
      const entry: NoteDraft = { note: head, text };
      if (previous?.failure) entry.failure = previous.failure;
      this.drafts.set(note.id, entry);
      if (!entry.failure) this.#timers.set(note.id, setTimeout(() => {
        this.#timers.delete(note.id);
        this.#queue.add(note.id);
        void this.#run();
      }, SAVE_DELAY_MS));
    }
    this.#notify();
  }

  /**
   * Save through the latest draft; a retry clears a previous failure for one attempt.
   * @param id The file whose pending edits must settle.
   * @param retry Whether the user explicitly requested another attempt after failure.
   * @returns Whether no unsaved draft remains for this file.
   */
  async flush(id: string, retry = false): Promise<boolean> {
    this.#cancelTimer(id);
    const entry = this.drafts.get(id);
    if (retry && entry?.failure) delete entry.failure;
    this.#flushing.add(id);
    this.#queue.add(id);
    await this.#run();
    while (this.#queue.has(id) || this.#saving === id) await this.#run();
    return !this.drafts.has(id);
  }

  /**
   * Flush retained drafts without automatically retrying a failed write.
   * @returns Completion after the queued attempts settle; failed drafts remain retained.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.drafts.keys()].map(id => this.flush(id)));
  }

  /**
   * Drop a draft only after its already-started request has settled.
   * @param id The file being explicitly reloaded or successfully deleted.
   * @returns Completion after the draft and its pending timer have been removed.
   */
  async discard(id: string): Promise<void> {
    await this.settle(id);
    this.drafts.delete(id);
    this.#heads.delete(id);
    this.#saved.delete(id);
    this.#notify();
  }

  /**
   * Stop pending saves and wait for an already-sent request without dropping its draft.
   * @param id The file being prepared for an explicit reload.
   * @returns Completion after the current write queue settles.
   */
  async settle(id: string): Promise<void> {
    this.#cancelTimer(id);
    this.#queue.delete(id);
    this.#flushing.delete(id);
    await this.#running;
  }

  #cancelTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(id);
  }

  #notify(): void {
    this.#version += 1;
    for (const listener of this.#listeners) {
      try { listener(); }
      catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  #run(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#queue.size > 0) void this.#run();
    });
    return this.#running;
  }

  async #drain(): Promise<void> {
    while (this.#queue.size > 0) {
      const id = this.#queue.values().next().value;
      if (id === undefined) break;
      this.#queue.delete(id);
      const submitted = this.drafts.get(id);
      if (!submitted || submitted.failure) { this.#flushing.delete(id); continue; }
      this.#saving = id;
      this.#notify();
      try {
        const receipt = await this.api.command({ action: 'save', id, text: submitted.text, expectedRevision: submitted.note.revision });
        if (receipt.revision === null) throw new NotesApiError('invalid_save_revision', 'The save response has no note revision.');
        const head = parseFrontmatter(submitted.text);
        const saved: NoteRead = { ...submitted.note, text: submitted.text, revision: receipt.revision,
          title: noteTitle(id, head.data, head.body), ...extractLinks(submitted.text) };
        this.#heads.set(id, saved);
        this.#saved.add(id);
        const latest = this.drafts.get(id);
        if (!latest || latest.text === submitted.text) {
          this.drafts.delete(id);
          this.#cancelTimer(id);
          this.#flushing.delete(id);
        } else {
          this.drafts.set(id, { note: saved, text: latest.text });
          if (this.#flushing.has(id)) this.#queue.add(id);
        }
      } catch (error) {
        const latest = this.drafts.get(id) ?? submitted;
        this.drafts.set(id, { ...latest, failure: { error } });
        this.#cancelTimer(id);
        this.#queue.delete(id);
        this.#flushing.delete(id);
      } finally {
        this.#saving = undefined;
        this.#notify();
      }
    }
  }
}
