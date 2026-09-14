/** Actual compiled Notes UI preserves drafts and never deletes on a revision conflict. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import * as JSX from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
// The shipped bundle is pulled in as text so this spec stays free of `node:` imports and
// can run under the jsdom environment the UI needs.
import clientSource from '../dist/client.js?raw';

const disposers = [];
const barriers = [];
const inFlight = new Set();
afterEach(async () => {
  for (const release of barriers.splice(0)) release();
  await act(async () => {
    cleanup();
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  });
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/**
 * Deterministic stand-in for a content revision.
 * The client validates the `sha256-<64 hex>` shape rather than the algorithm, and real
 * content hashing is covered against the actual implementation by the vault and service
 * suites. Keeping it here avoids a `node:crypto` import in a browser-environment spec.
 */
const revision = text => {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (const byte of new TextEncoder().encode(text)) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right + byte, 0x85ebca6b) >>> 0;
  }
  const hex = value => value.toString(16).padStart(8, '0');
  return `sha256-${`${hex(left)}${hex(right)}`.repeat(4)}`;
};
const bare = id => id.replace(/\.(md|canvas)$/, '');
const note = (id, text, links = []) => ({ id, text, title: bare(id), revision: revision(text), links, embeds: [], tags: [] });

async function fixture(locale = 'zh', extra = {}, pendingProposals = [], failures = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  // Testing Library's async wrapper recognizes Jest's timer interface when draining its zero-delay task.
  vi.stubGlobal('jest', { advanceTimersByTime: milliseconds => vi.advanceTimersByTime(milliseconds) });
  const old = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
  disposers.push(() => { if (old) Object.defineProperty(window, '__ModuleLoader__', old); else Reflect.deleteProperty(window, '__ModuleLoader__'); });
  let factory;
  window.__ModuleLoader__ = { load: entry => { factory = entry.factory; } };
  new Function('window', clientSource)(window);
  const modules = { react: React, 'react/jsx-runtime': JSX, 'react-dom': ReactDOM };
  const plugin = factory(id => { if (!(id in modules)) throw new Error(`Unexpected client dependency: ${id}`); return modules[id]; });
  // Seed before mount: the panel lists the vault once, on mount.
  const disk = new Map([['Alpha.md', '# Alpha\n'], ['Beta.md', '# Beta\n'], ...Object.entries(extra)]);
  const requests = [];
  const linkedNotes = new Map();
  let delayRead;
  let beforeCommand;
  const respond = async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    const url = new URL(path, 'http://localhost');
    requests.push({ path: url.pathname, command: init.body ? JSON.parse(init.body).request : undefined });
    const failure = failures[url.pathname.split('/').at(-1)];
    if (failure instanceof Error) throw failure;
    if (failure) return Response.json({ error: typeof failure === 'string' ? { code: 'invalid_request', message: failure } : failure }, { status: 400 });
    if (url.pathname.endsWith('/tree')) return Response.json({ vault: '/synthetic/notes', notes: [...disk].map(([id, text]) => ({ id, title: bare(id), dir: '', size: text.length, mtimeMs: 1 })) });
    if (url.pathname.endsWith('/tags')) return Response.json({ tags: [] });
    if (url.pathname.endsWith('/backlinks')) return Response.json({ id: url.searchParams.get('id'), notes: [] });
    if (url.pathname.endsWith('/note')) {
      const id = url.searchParams.get('id');
      if (delayRead) await delayRead(id);
      if (!disk.has(id)) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
      return Response.json(note(id, disk.get(id), linkedNotes.get(id)));
    }
    if (url.pathname.endsWith('/search')) {
      const needle = (url.searchParams.get('q') ?? '').toLowerCase();
      const matches = [];
      for (const [id, text] of disk) {
        const lines = text.split('\n');
        const at = lines.findIndex(line => line.toLowerCase().includes(needle));
        if (at >= 0) matches.push({ id, title: bare(id), lineNumber: at + 1, line: lines[at] });
      }
      return Response.json({ query: needle, matches });
    }
    if (url.pathname.endsWith('/revision')) return Response.json({ version: revision([...disk].map(([id, text]) => `${id}:${text}`).join('|') + JSON.stringify(pendingProposals)) });
    if (url.pathname.endsWith('/proposals')) return Response.json({ proposals: pendingProposals });
    if (url.pathname.endsWith('/command')) {
      const command = JSON.parse(init.body).request;
      if (beforeCommand) await beforeCommand(command);
      const id = command.action === 'rename' ? command.id : command.action === 'daily' ? '日记/2026-09-13.md' : command.id;
      const previous = disk.has(id) ? revision(disk.get(id)) : null;
      if ((command.action === 'save' && command.expectedRevision !== previous) || (command.action === 'create' && previous !== null)) {
        return Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: previous } }, { status: 409 });
      }
      if (command.action === 'apply-proposal' || command.action === 'discard-proposal') {
        const index = pendingProposals.findIndex(entry => entry.proposal.proposalId === command.proposalId);
        if (index < 0) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
        const entry = pendingProposals[index];
        // The real service refuses to apply a proposal whose note moved on.
        const current = disk.has(entry.proposal.id) ? revision(disk.get(entry.proposal.id)) : null;
        if (current !== entry.proposal.baseRevision) {
          return Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: current } }, { status: 409 });
        }
        pendingProposals.splice(index, 1);
        if (command.action === 'discard-proposal') {
          return Response.json({ action: 'discard-proposal', id: entry.proposal.id, revision: null, previousRevision: null });
        }
        disk.set(entry.proposal.id, entry.proposal.text);
        return Response.json({
          action: 'apply-proposal', id: entry.proposal.id,
          revision: revision(entry.proposal.text), previousRevision: entry.proposal.baseRevision,
        });
      }
      if (command.action === 'rename') {
        if (disk.has(command.to)) return Response.json({ error: { code: 'conflict', message: 'Exists', currentRevision: revision(disk.get(command.to)) } }, { status: 409 });
        disk.set(command.to, disk.get(command.id));
        disk.delete(command.id);
        return Response.json({ action: 'rename', id: command.to, revision: revision(disk.get(command.to)), previousRevision: previous });
      }
      if (command.action === 'daily') {
        if (!disk.has(id)) disk.set(id, `---\ntags: [日记]\n---\n\n# 2026-09-13\n`);
        return Response.json({ action: 'daily', id, revision: revision(disk.get(id)), previousRevision: previous });
      }
      if (command.action === 'delete') disk.delete(command.id);
      else disk.set(command.id, command.text);
      return Response.json({ action: command.action, id: command.id, revision: command.action === 'delete' ? null : revision(command.text), previousRevision: previous });
    }
    throw new Error(`Unexpected Notes request: ${path}`);
  };
  const request = vi.fn((path, init) => {
    const response = respond(path, init);
    inFlight.add(response);
    void response.then(() => inFlight.delete(response), () => inFlight.delete(response));
    return response;
  });
  vi.stubGlobal('fetch', request);
  let tab;
  plugin.apply({
    locale: { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} },
    betterSidebar: { registerTab: value => { tab = value; return () => { tab = undefined; }; } },
    effect: install => disposers.push(install()),
  });
  expect(tab.id).toBe('clawmaster:notes');
  expect(tab.single).toBe(true);
  const mount = () => render(React.createElement(tab.component, { scope: { sessionId: 'synthetic-session' }, visible: true }));
  const view = mount();
  await screen.findByRole('button', { name: 'Alpha' });
  const copy = locale === 'zh'
    ? { body: '笔记正文', source: 'Markdown 源码', document: '返回文档', more: '更多笔记操作', fileName: '文件名', sourceAction: 'Markdown 源码', formatting: '显示格式工具', hideFormatting: '收起格式工具', retrySave: '重试保存', unavailable: '这篇笔记包含暂不支持的格式，原文已保留，请使用 Markdown 源码编辑。', reload: '重新载入', cancel: '取消', delete: '删除', dirty: '未保存', library: '笔记目录', details: '笔记信息', proposals: '待审建议', search: '搜索笔记', apply: '应用' }
    : { body: 'Note body', source: 'Markdown source', document: 'Back to document', more: 'More note actions', fileName: 'File name', sourceAction: 'Markdown source', formatting: 'Show formatting tools', hideFormatting: 'Hide formatting tools', retrySave: 'Retry saving', unavailable: 'This note contains unsupported formatting. The original text is preserved; use Markdown source to edit it.', reload: 'Reload', cancel: 'Cancel', delete: 'Delete', dirty: 'Unsaved', library: 'Note list', details: 'Note details', proposals: 'Proposals', search: 'Search notes', apply: 'Apply' };
  const show = label => {
    const button = screen.getByRole('button', { name: label });
    if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
    return screen.getByRole('region', { name: label });
  };
  const library = () => show(copy.library);
  const details = () => show(copy.details);
  const menu = () => {
    const summary = screen.getByLabelText(copy.more, { selector: 'summary' });
    if (!summary.parentElement.open) fireEvent.click(summary);
    return within(summary.parentElement);
  };
  const source = async () => {
    if (!screen.queryByRole('textbox', { name: copy.source })) fireEvent.click(menu().getByRole('button', { name: copy.sourceAction, exact: true }));
    return screen.findByRole('textbox', { name: copy.source });
  };
  const documentMode = async () => {
    if (!screen.queryByRole('textbox', { name: copy.body })) fireEvent.click(menu().getByRole('button', { name: copy.document, exact: true }));
    return screen.findByRole('textbox', { name: copy.body });
  };
  const fileName = () => screen.getByRole('textbox', { name: copy.fileName });
  const open = async (id, mode = 'source') => {
    library();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${id}( |$)`) }));
    await waitFor(() => expect(fileName().value).toBe((disk.has(id + '.canvas') ? id + '.canvas' : id).split('/').at(-1)));
    if (mode === 'source' && !id.endsWith('.canvas') && !document.querySelector('.cm-notes-canvas')) await source();
  };
  const editor = () => screen.getByRole('textbox', { name: copy.source });
  const richEditor = () => screen.getByRole('textbox', { name: copy.body });
  const flush = (modifier = 'metaKey') => fireEvent.keyDown(document.querySelector('.cm-notes'), { key: 's', code: 'KeyS', [modifier]: true });
  const advance = async milliseconds => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
  const saved = async (id, value) => { await waitFor(() => expect(disk.get(id)).toBe(value)); };
  const gate = predicate => {
    const arrived = Promise.withResolvers();
    const released = Promise.withResolvers();
    barriers.push(released.resolve);
    beforeCommand = async command => { if (predicate(command)) { arrived.resolve(command); await released.promise; } };
    return { arrived: arrived.promise, release: released.resolve };
  };
  return { disk, requests, linkedNotes, interceptCommands: handler => { beforeCommand = handler; }, view, mount, copy, open, source, documentMode, editor, richEditor, fileName, menu, library, details, flush, advance, saved, gate, tab: () => tab, delay: handler => { delayRead = handler; } };
}

for (const locale of ['zh', 'en']) {
  it(`shows the library until a note opens and then gives the editor both collapsed regions (${locale})`, async () => {
    const f = await fixture(locale);
    const listButton = screen.getByRole('button', { name: f.copy.library });
    const list = screen.getByRole('region', { name: f.copy.library });
    expect(listButton.getAttribute('aria-expanded')).toBe('true');
    expect(listButton.getAttribute('aria-controls')).toBe(list.id);
    expect(list.hidden).toBe(false);
    await f.open('Alpha');
    expect(listButton.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull();
    const detailsButton = screen.getByRole('button', { name: f.copy.details });
    const details = document.getElementById(detailsButton.getAttribute('aria-controls'));
    expect(details).not.toBeNull();
    expect(details.getAttribute('aria-label')).toBe(f.copy.details);
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
    expect(screen.queryByRole('region', { name: f.copy.details })).toBeNull();
    expect(f.editor().value).toBe('# Alpha\n');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });

  it(`retains the source editor node, selection and scroll across panels and document mode (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    const editor = f.editor();
    const draft = 'A local draft\n'.repeat(40);
    fireEvent.change(editor, { target: { value: draft } });
    editor.setSelectionRange(4, 10, 'backward');
    editor.scrollTop = 180;
    for (const label of [f.copy.library, f.copy.details]) {
      const button = screen.getByRole('button', { name: label });
      const region = document.getElementById(button.getAttribute('aria-controls'));
      for (const expanded of [true, false]) {
        fireEvent.click(button);
        expect(button.getAttribute('aria-expanded')).toBe(String(expanded));
        expect(region.hidden).toBe(!expanded);
        expect(f.editor()).toBe(editor);
        expect(editor.value).toBe(draft);
        expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([4, 10, 'backward']);
        expect(editor.scrollTop).toBe(180);
        expect(screen.getByRole('status').textContent).toContain(f.copy.dirty);
      }
    }
    await f.documentMode();
    expect(screen.queryByRole('textbox', { name: f.copy.source })).toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(editor.value).toBe(draft);
    await f.source();
    expect(f.editor()).toBe(editor);
    expect(editor.hidden).toBe(false);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([4, 10, 'backward']);
    expect(editor.scrollTop).toBe(180);
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    f.flush();
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe(draft));
  });

  it(`reveals search results from the collapsed library without changing the open draft (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    const editor = f.editor();
    fireEvent.change(editor, { target: { value: 'unfinished Alpha draft' } });
    const search = screen.getByRole('textbox', { name: f.copy.search });
    fireEvent.change(search, { target: { value: 'Beta' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const list = await screen.findByRole('region', { name: f.copy.library });
    await within(list).findByText('# Beta');
    expect(screen.getByRole('button', { name: f.copy.library }).getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect(f.editor()).toBe(editor);
    expect(editor.value).toBe('unfinished Alpha draft');
    fireEvent.click(within(list).getByRole('button', { name: /^Beta / }));
    await waitFor(() => expect(f.fileName().value).toBe('Beta'));
    expect(list.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: f.copy.cancel }));
    await f.open('Alpha');
    expect(f.editor().value).toBe('unfinished Alpha draft');
    expect(f.disk.get('Alpha.md')).toBe('unfinished Alpha draft');
  });

  it(`shows proposal errors with retry while notes remain editable and drafts survive (${locale})`, async () => {
    const failures = { proposals: 'Pending proposal byte limit exceeded' };
    const f = await fixture(locale, {}, [], failures);
    expect(screen.getByRole('alert').textContent).toContain(failures.proposals);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'local draft during proposal failure' } });
    expect(screen.getByRole('alert').textContent).toContain(failures.proposals);
    const retry = locale === 'zh' ? '重试载入' : 'Retry loading';
    fireEvent.click(screen.getByRole('button', { name: retry }));
    await waitFor(() => expect(f.requests.filter(request => request.path.endsWith('/proposals')).length).toBe(2));
    expect(f.editor().value).toBe('local draft during proposal failure');
    f.flush();
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('local draft during proposal failure'));
    expect(screen.getByRole('alert').textContent).toContain(failures.proposals);
    delete failures.proposals;
    fireEvent.click(screen.getByRole('button', { name: retry }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBe(null));
    expect(f.editor().value).toBe('local draft during proposal failure');
  });

  it(`preserves the editable draft when the server refuses an oversized save (${locale})`, async () => {
    const failures = {};
    const f = await fixture(locale, {}, [], failures);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'oversized local draft' } });
    failures.command = 'The complete note exceeds the 1024 byte limit. Shorten the content before saving; the existing file was not changed.';
    f.flush();
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
    expect(f.editor().value).toBe('oversized local draft');
    expect(f.editor().readOnly).toBe(false);
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(screen.getByRole('status').textContent).toContain('1024 byte limit');
    delete failures.command;
    fireEvent.change(f.editor(), { target: { value: 'shortened draft' } });
    f.flush();
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('shortened draft'));
  });

  it(`keeps draft and newer file on save conflict without read or delete (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'local unsaved draft' } });
    f.disk.set('Alpha.md', 'newer external text');
    const before = f.requests.length;
    f.flush();
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
    expect(f.editor().value).toBe('local unsaved draft');
    expect(f.disk.get('Alpha.md')).toBe('newer external text');
    expect(f.requests.slice(before).filter(item => item.command).map(item => item.command.action)).toEqual(['save']);
    expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: f.copy.reload }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: f.copy.cancel }));
    expect(f.editor().value).toBe('local unsaved draft');
    fireEvent.click(screen.getByRole('button', { name: f.copy.reload }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.reload }));
    await waitFor(() => expect(f.editor().value).toBe('newer external text'));
    expect(f.disk.get('Alpha.md')).toBe('newer external text');
  });

  it(`flushes edits across note navigation and restores their text after tab close/reopen (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'retained draft' } });
    await f.open('Beta');
    await f.open('Alpha');
    expect(f.editor().value).toBe('retained draft');
    f.view.unmount();
    const reopened = f.mount();
    await screen.findByRole('button', { name: 'Alpha' });
    await f.open('Alpha');
    await waitFor(() => expect(f.editor().value).toBe('retained draft'));
    expect(f.editor().readOnly).toBe(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(f.disk.get('Alpha.md')).toBe('retained draft');
    reopened.unmount();
  });

  it(`requires an in-panel confirmation before deleting a note (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.click(f.menu().getByRole('button', { name: f.copy.delete }));
    expect(f.disk.has('Alpha.md')).toBe(true);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.cancel }));
    expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
    fireEvent.click(f.menu().getByRole('button', { name: f.copy.delete }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.delete }));
    await waitFor(() => expect(f.disk.has('Alpha.md')).toBe(false));
    expect(f.requests.filter(item => item.command?.action === 'delete')).toHaveLength(1);
  });
}

it('ignores an earlier note read that completes after a newer selection', async () => {
  const f = await fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  barriers.push(release);
  f.delay(id => id === 'Alpha.md' ? pending : undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
  await f.open('Beta');
  await act(async () => { release(); await pending; });
  expect(f.fileName().value).toBe('Beta');
  expect(f.editor().value).toBe('# Beta\n');
});

it('saves the edited text with its read revision and releases the draft warning', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: '# Updated title\nSaved text' } });
  f.flush();
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('saved'));
  expect(f.disk.get('Alpha.md')).toBe('# Updated title\nSaved text');
  expect(f.editor().value).toBe('# Updated title\nSaved text');
  expect(f.requests.find(item => item.command?.action === 'save').command.expectedRevision).toBe(revision('# Alpha\n'));
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it('uses actual backlinks rather than listing all other notes', async () => {
  const f = await fixture();
  await f.open('Alpha');
  await waitFor(() => expect(f.requests.some(item => item.path.endsWith('/backlinks'))).toBe(true));
  f.library();
  f.details();
  expect(screen.getAllByRole('button', { name: 'Beta' })).toHaveLength(1);
  expect(screen.getByText('暂无反向链接')).toBeDefined();
});

it('keeps the open draft when creating a duplicate note is rejected', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'unrelated draft' } });
  fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
  fireEvent.change(screen.getByRole('textbox', { name: '笔记名称' }), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.editor().value).toBe('unrelated draft');
  expect(f.disk.get('Alpha.md')).toBe('unrelated draft');
  expect(f.disk.get('Beta.md')).toBe('# Beta\n');
  expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
});

it('renames the open note and opens the new path', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.fileName(), { target: { value: 'Gamma' } });
  fireEvent.keyDown(f.fileName(), { key: 'Enter' });
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  expect(f.disk.has('Alpha.md')).toBe(false);
  expect(f.fileName().value).toBe('Gamma');
});

it('offers to create the note a missing wiki link points at', async () => {
  const f = await fixture();
  f.disk.set('Alpha.md', 'see [[Gamma]]\n');
  f.linkedNotes.set('Alpha.md', ['Gamma']);
  await f.open('Alpha');
  f.details();
  fireEvent.click(await screen.findByRole('button', { name: 'Gamma' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('这个链接指向的笔记还不存在。')).toBeDefined();
  fireEvent.click(within(dialog).getByRole('button', { name: '创建这篇笔记' }));
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  expect(f.disk.get('Gamma.md')).toBe('# Gamma\n');
});

it('asks which note an ambiguous wiki link means instead of guessing', async () => {
  const f = await fixture('zh', { 'one/Note.md': '# One\n', 'two/Note.md': '# Two\n' });
  f.disk.set('Alpha.md', 'see [[Note]]\n');
  f.linkedNotes.set('Alpha.md', ['Note']);
  await f.open('Alpha');
  f.details();
  fireEvent.click(await screen.findByRole('button', { name: 'Note' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('有多篇笔记匹配这个链接，请选择：')).toBeDefined();
  expect(within(dialog).getAllByRole('button', { name: /Note/ })).toHaveLength(2);
});

it('shows a canvas file read-only with saving disabled', async () => {
  const f = await fixture('zh', { 'Board.canvas': '{"nodes":[]}' });
  await f.open('Board', 'document');
  expect(screen.getByText('画布文件以只读方式显示（本版本尚无画布编辑器）。')).toBeDefined();
  expect(screen.queryByRole('textbox', { name: '笔记正文' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Markdown 源码' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Markdown', exact: true })).toBeNull();
  expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
});

it('renders the matching line for search hits', async () => {
  const f = await fixture();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), { target: { value: 'Beta' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索笔记' }), { key: 'Enter' });
  await waitFor(() => expect(screen.getByText('# Beta')).toBeDefined());
  expect(f.requests.some(item => item.path.endsWith('/search'))).toBe(true);
});

it("opens today's daily note, creating it once", async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '今日笔记' }));
  await waitFor(() => expect(f.disk.has('日记/2026-09-13.md')).toBe(true));
  expect(f.fileName().value).toBe('2026-09-13');
  expect(f.requests.filter(item => item.command?.action === 'daily')).toHaveLength(1);
});

/** One proposal fixture with a diff that adds a single line. */
const proposalFixture = () => ({
  proposal: {
    proposalId: '11111111-1111-4111-8111-111111111111', id: 'Alpha.md',
    text: '# Alpha\nreviewed\n', baseRevision: revision('# Alpha\n'), createdAt: '2026-09-13T00:00:00.000Z',
  },
  diff: {
    lines: [{ kind: 'context', text: '# Alpha' }, { kind: 'add', text: 'reviewed' }],
    added: 1, removed: 0, truncated: false,
  },
});

for (const locale of ['zh', 'en']) {
  it(`keeps pending proposals discoverable while details are collapsed and applies only on request (${locale})`, async () => {
    const f = await fixture(locale, {}, [proposalFixture()]);
    await f.open('Alpha');
    const detailsButton = screen.getByRole('button', { name: f.copy.details });
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false');
    expect(detailsButton.textContent).toContain(`${f.copy.proposals} 1`);
    const count = document.getElementById(detailsButton.getAttribute('aria-describedby'));
    expect(count).not.toBeNull();
    expect(count.textContent).toBe(`${f.copy.proposals} 1`);
    expect(count.closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('button', { name: f.copy.apply })).toBeNull();
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    const details = f.details();
    expect(within(details).getByText(/\+ reviewed/)).toBeDefined();
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    fireEvent.click(within(details).getByRole('button', { name: f.copy.apply }));
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('# Alpha\nreviewed\n'));
    await waitFor(() => expect(screen.queryByRole('button', { name: f.copy.apply })).toBeNull());
    expect(f.requests.filter(item => item.command?.action === 'apply-proposal')).toHaveLength(1);
  });
}

it('discards a proposal without touching the note', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  await f.open('Alpha');
  f.details();
  fireEvent.click(screen.getByRole('button', { name: '丢弃' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '丢弃' })).toBeNull());
  expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
  expect(f.requests.some(item => item.command?.action === 'apply-proposal')).toBe(false);
});

it('shows a proposal conflict instead of overwriting the note', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  f.disk.set('Alpha.md', 'changed underneath\n');
  await f.open('Alpha');
  f.details();
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.disk.get('Alpha.md')).toBe('changed underneath\n');
  // The proposal survives a refused apply, so it can be retried after a reload.
  expect(screen.getByRole('button', { name: '应用' })).toBeDefined();
});

it('gives the sidebar tab an inline SVG icon rather than a raster asset', async () => {
  const f = await fixture();
  const descriptor = f.tab();
  expect(typeof descriptor.icon).toBe('function');
  const { container } = render(React.createElement(React.Fragment, null, descriptor.icon(18)));
  const svg = container.querySelector('svg');
  expect(svg).toBeTruthy();
  expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  expect(svg.getAttribute('stroke')).toBe('currentColor');
  // One rounded body rect, a spine and two text lines — all vector, no raster fallback.
  expect(svg.querySelectorAll('rect').length).toBe(1);
  expect(svg.querySelectorAll('path').length).toBe(2);
  expect(container.querySelector('img')).toBeNull();
});


for (const locale of ['zh', 'en']) {
  it(`preserves edits typed while a live-refresh read is pending (${locale})`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(locale);
    await f.open('Alpha');
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    barriers.push(release.resolve);
    f.delay(async id => { if (id === 'Alpha.md') { reading.resolve(); await release.promise; } });
    f.disk.set('Alpha.md', 'external replacement');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await reading.promise;
    fireEvent.change(f.editor(), { target: { value: 'draft typed during refresh' } });
    await act(async () => { release.resolve(); });
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
    expect(f.editor().value).toBe('draft typed during refresh');
    expect(f.disk.get('Alpha.md')).toBe('external replacement');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });

  it(`does not navigate back when an earlier live-refresh read finishes (${locale})`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(locale);
    await f.open('Alpha');
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    barriers.push(release.resolve);
    f.delay(async id => { if (id === 'Alpha.md') { reading.resolve(); await release.promise; } });
    f.disk.set('Alpha.md', 'external replacement');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await reading.promise;
    await f.open('Beta');
    fireEvent.change(f.editor(), { target: { value: 'Beta local draft' } });
    await act(async () => { release.resolve(); });
    expect(f.fileName().value).toBe('Beta');
    expect(f.editor().value).toBe('Beta local draft');
  });
}

it('flushes local edits before applying a stale proposal without overwriting them', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'local draft must survive' } });
  f.details();
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.disk.get('Alpha.md')).toBe('local draft must survive');
  expect(f.editor().value).toBe('local draft must survive');
  expect(f.requests.filter(item => item.command).map(item => item.command.action)).toEqual(['save', 'apply-proposal']);
  expect(screen.getByRole('button', { name: '应用' })).toBeDefined();
});

it('saves the draft before renaming its file', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'draft before rename' } });
  fireEvent.change(f.fileName(), { target: { value: 'Gamma' } });
  fireEvent.keyDown(f.fileName(), { key: 'Enter' });
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(f.editor().value).toBe('draft before rename');
  expect(f.disk.get('Gamma.md')).toBe('draft before rename');
  f.flush();
  await waitFor(() => expect(f.disk.get('Gamma.md')).toBe('draft before rename'));
  expect(f.disk.has('Alpha.md')).toBe(false);
});


it('renders nested folders with SVG icons and lets the reader collapse their children', async () => {
  const f = await fixture('en', { 'projects/sub/Task.md': '# Task\n' });
  const folders = () => [...f.view.container.querySelectorAll('.cm-notes-folder')];
  expect(folders().map(button => button.textContent)).toEqual(['projects', 'sub']);
  expect(folders()[0].querySelector('svg')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'projects/sub/Task' })).toBeDefined();
  fireEvent.click(folders()[0]);
  expect(folders()[0].getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'projects/sub/Task' })).toBeNull();
  fireEvent.click(folders()[0]);
  expect(folders()[0].getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'projects/sub/Task' })).toBeDefined();
});


for (const locale of ['zh', 'en']) {
  it(`refreshes proposed and discarded drafts on the existing timer without note edits (${locale})`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const pending = [];
    const f = await fixture(locale, {}, pending);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'keep local draft' } });
    const applyLabel = locale === 'zh' ? '应用' : 'Apply';
    expect(screen.queryByRole('button', { name: applyLabel })).toBeNull();
    pending.push(proposalFixture());
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await waitFor(() => expect(screen.getByRole('button', { name: f.copy.details }).textContent).toContain(`${f.copy.proposals} 1`));
    expect(screen.queryByRole('button', { name: applyLabel })).toBeNull();
    f.details();
    await waitFor(() => expect(screen.getByRole('button', { name: applyLabel })).toBeDefined());
    expect(f.editor().value).toBe('keep local draft');
    pending.splice(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await waitFor(() => expect(screen.queryByRole('button', { name: applyLabel })).toBeNull());
    expect(f.editor().value).toBe('keep local draft');
    expect(f.disk.get('Alpha.md')).toBe('keep local draft');
    expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
  });
}

for (const locale of ['zh', 'en']) {
  it(`refreshes external note edits and additions on the visible panel timer (${locale})`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(locale);
    await f.open('Alpha');
    f.disk.set('Alpha.md', 'externally updated note');
    f.disk.set('Gamma.md', '# External addition\n');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await waitFor(() => expect(f.editor().value).toBe('externally updated note'));
    f.library();
    expect(screen.getByRole('button', { name: 'Gamma' })).toBeDefined();
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    const revisionRequests = f.requests.filter(item => item.path.endsWith('/revision')).length;
    f.view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(f.requests.filter(item => item.path.endsWith('/revision'))).toHaveLength(revisionRequests);
  });
}

for (const locale of ['zh', 'en']) {
  it(`opens ordinary Markdown as an editable formatted document by default (${locale})`, async () => {
    const original = '# 本周计划\n\n**重要事项**\n\n- 核对数据\n- 完成复盘\n';
    const f = await fixture(locale, { 'Plan.md': original });
    await f.open('Plan', 'document');
    const body = await screen.findByRole('textbox', { name: f.copy.body });
    expect(body.getAttribute('contenteditable')).toBe('true');
    expect(within(body).getByRole('heading', { level: 1, name: '本周计划' })).toBeDefined();
    expect(body.querySelector('strong')?.textContent).toBe('重要事项');
    expect(within(body).getAllByRole('listitem')).toHaveLength(2);
    expect(body.textContent).not.toContain('# 本周计划');
    expect(body.textContent).not.toContain('**重要事项**');
    expect(screen.queryByRole('textbox', { name: f.copy.source })).toBeNull();
    expect(document.querySelector('.cm-notes-modes')).toBeNull();
    expect(document.querySelector('.cm-notes-rich').dataset.toolbarVisible).toBe('false');
    expect(screen.queryByRole('button', { name: locale === 'zh' ? '保存' : 'Save', exact: true })).toBeNull();
    expect(f.disk.get('Plan.md')).toBe(original);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });

  it(`preserves original frontmatter and line endings when only switching document modes (${locale})`, async () => {
    const original = '---\r\ntags: [工作]\r\ncustom: "保留字节"\r\n---\r\n\r\n# 本周计划\r\n\r\n**重要事项**\r\n\r\n';
    const f = await fixture(locale, { 'Roundtrip.md': original });
    await f.open('Roundtrip', 'document');
    await screen.findByRole('textbox', { name: f.copy.body });
    await f.source();
    expect(f.editor().value).toBe(original.replace(/\r\n/g, '\n'));
    await f.documentMode();
    await f.source();
    expect(f.editor().value).toBe(original.replace(/\r\n/g, '\n'));
    await f.advance(1200);
    expect(f.disk.get('Roundtrip.md')).toBe(original);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it(`synchronizes a Markdown edit into the document and saves against the read revision (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    const draft = '# 修改后的计划\n\n**已核对**\n\n- 完成归档\n';
    fireEvent.change(f.editor(), { target: { value: draft } });
    await f.documentMode();
    const body = await screen.findByRole('textbox', { name: f.copy.body });
    await within(body).findByRole('heading', { level: 1, name: '修改后的计划' });
    expect(body.querySelector('strong')?.textContent).toBe('已核对');
    await f.source();
    expect(f.editor().value).toBe(draft);
    f.flush();
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe(draft));
    const saves = f.requests.filter(item => item.command?.action === 'save');
    expect(saves).toHaveLength(1);
    expect(saves[0].command.expectedRevision).toBe(revision('# Alpha\n'));
  });

  it(`opens unsupported wiki syntax in source with the original text retained (${locale})`, async () => {
    const original = '# 资料引用\n\n查看 [[Alpha]]，保留 ![[演示.png]]。\n';
    const f = await fixture(locale, { 'Unsupported.md': original });
    await f.open('Unsupported', 'document');
    await screen.findByText(f.copy.unavailable);
    const source = await screen.findByRole('textbox', { name: f.copy.source });
    expect(source.value).toBe(original);
    expect(f.menu().getByRole('button', { name: f.copy.document, exact: true }).disabled).toBe(true);
    expect(screen.queryByRole('textbox', { name: f.copy.body })).toBeNull();
    expect(screen.queryByRole('button', { name: locale === 'zh' ? '保存' : 'Save', exact: true })).toBeNull();
    expect(f.disk.get('Unsupported.md')).toBe(original);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });
}

for (const locale of ['zh', 'en']) {
  it(`keeps document actions in More and toggles formatting without replacing the editor (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha', 'document');
    const body = f.richEditor();
    expect(document.querySelector('.cm-notes-modes')).toBeNull();
    expect(document.querySelector('.cm-notes-head').querySelectorAll(':scope > button')).toHaveLength(0);
    const more = screen.getByLabelText(f.copy.more, { selector: 'summary' }).parentElement;
    expect(more.open).toBe(false);
    expect(within(more).getByRole('button', { name: f.copy.delete, exact: true }).closest('details')).toBe(more);
    fireEvent.click(f.menu().getByRole('button', { name: f.copy.formatting }));
    expect(document.querySelector('.cm-notes-rich').dataset.toolbarVisible).toBe('true');
    expect(f.richEditor()).toBe(body);
    fireEvent.click(f.menu().getByRole('button', { name: f.copy.hideFormatting }));
    expect(document.querySelector('.cm-notes-rich').dataset.toolbarVisible).toBe('false');
    expect(f.richEditor()).toBe(body);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });

  it(`renames in place on blur while Escape and a composing Enter keep the file name (${locale})`, async () => {
    const f = await fixture(locale, { 'projects/Task.md': '# Task\n' });
    await f.open('projects/Task');
    fireEvent.change(f.fileName(), { target: { value: 'Cancelled' } });
    fireEvent.keyDown(f.fileName(), { key: 'Escape' });
    fireEvent.blur(f.fileName());
    expect(f.fileName().value).toBe('Task');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    fireEvent.change(f.fileName(), { target: { value: '新名称' } });
    fireEvent.keyDown(f.fileName(), { key: 'Enter', isComposing: true });
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    fireEvent.blur(f.fileName());
    await waitFor(() => expect(f.disk.has('projects/新名称.md')).toBe(true));
    expect(f.disk.has('projects/Task.md')).toBe(false);
    expect(f.requests.filter(item => item.command?.action === 'rename')).toHaveLength(1);
  });
}

it('automatically saves the latest draft after typing pauses and restarts the pause on another edit', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'first phrase' } });
  await f.advance(400);
  expect(f.requests.filter(item => item.command)).toHaveLength(0);
  fireEvent.change(f.editor(), { target: { value: 'latest phrase' } });
  await f.advance(400);
  expect(f.requests.filter(item => item.command)).toHaveLength(0);
  await f.advance(400);
  expect(f.disk.get('Alpha.md')).toBe('latest phrase');
  expect(f.requests.filter(item => item.command?.action === 'save').map(item => item.command.text)).toEqual(['latest phrase']);
});

for (const modifier of ['metaKey', 'ctrlKey']) {
  it(`flushes the current draft immediately with ${modifier}+S`, async () => {
    const f = await fixture();
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'shortcut text' } });
    f.flush(modifier);
    await f.saved('Alpha.md', 'shortcut text');
    await f.advance(1200);
    expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
  });
}

for (const next of ['typed during save', '# Alpha\n']) {
  it(`serializes a later draft ${next === '# Alpha\n' ? 'undone to the original text' : 'typed during saving'} with the receipt revision`, async () => {
    const f = await fixture();
    await f.open('Alpha');
    const gate = f.gate(command => command.action === 'save' && command.text === 'first saved snapshot');
    fireEvent.change(f.editor(), { target: { value: 'first saved snapshot' } });
    f.flush();
    const first = await gate.arrived;
    expect(first.expectedRevision).toBe(revision('# Alpha\n'));
    expect(f.editor().readOnly).toBe(false);
    fireEvent.change(f.editor(), { target: { value: next } });
    await f.advance(1200);
    expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
    expect(f.editor().value).toBe(next);
    await act(async () => { gate.release(); });
    await f.advance(1200);
    await f.saved('Alpha.md', next);
    const writes = f.requests.filter(item => item.command?.action === 'save').map(item => item.command);
    expect(writes.map(command => command.text)).toEqual(['first saved snapshot', next]);
    expect(writes[1].expectedRevision).toBe(revision('first saved snapshot'));
    expect(f.editor().value).toBe(next);
  });
}

it('waits for an in-flight save and later typing before navigating to another note', async () => {
  const f = await fixture();
  await f.open('Alpha');
  const gate = f.gate(command => command.action === 'save' && command.text === 'first snapshot');
  fireEvent.change(f.editor(), { target: { value: 'first snapshot' } });
  f.flush();
  await gate.arrived;
  fireEvent.change(f.editor(), { target: { value: 'last text before navigation' } });
  f.library();
  fireEvent.click(screen.getByRole('button', { name: 'Beta', exact: true }));
  expect(f.fileName().value).toBe('Alpha');
  await act(async () => { gate.release(); });
  await waitFor(() => expect(f.fileName().value).toBe('Beta'));
  expect(f.disk.get('Alpha.md')).toBe('last text before navigation');
  expect(f.requests.filter(item => item.command?.action === 'save').map(item => item.command.expectedRevision)).toEqual([revision('# Alpha\n'), revision('first snapshot')]);
});

it('keeps the same pending save and latest draft across tab close and reopen', async () => {
  const f = await fixture();
  await f.open('Alpha');
  const gate = f.gate(command => command.action === 'save' && command.text === 'in flight');
  fireEvent.change(f.editor(), { target: { value: 'in flight' } });
  f.flush();
  await gate.arrived;
  fireEvent.change(f.editor(), { target: { value: 'newer draft after close' } });
  f.view.unmount();
  f.mount();
  await screen.findByRole('textbox', { name: f.copy.fileName });
  await f.source();
  expect(f.editor().value).toBe('newer draft after close');
  expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
  const warning = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  await act(async () => { gate.release(); });
  await f.advance(1200);
  await f.saved('Alpha.md', 'newer draft after close');
  expect(f.editor().value).toBe('newer draft after close');
  expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(2);
});

for (const failure of [
  { label: 'denied write', value: { code: 'storage_unavailable', message: 'EACCES: permission denied' } },
  { label: 'oversized note', value: { code: 'invalid_request', message: 'Note exceeds byte limit' } },
  { label: 'network error', value: new TypeError('Failed to fetch') },
]) {
  it(`pauses automatic retries after a ${failure.label} and retains the draft for explicit retry`, async () => {
    const failures = { command: failure.value };
    const f = await fixture('zh', {}, [], failures);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'retained failure draft' } });
    await f.advance(800);
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
    expect(f.editor().value).toBe('retained failure draft');
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    await f.advance(4000);
    expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
    delete failures.command;
    fireEvent.click(f.menu().getByRole('button', { name: f.copy.retrySave }));
    await f.saved('Alpha.md', 'retained failure draft');
    expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(2);
  });
}

it('keeps a conflict draft across navigation and never automatically overwrites the external revision', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'conflicting local draft' } });
  f.disk.set('Alpha.md', 'external revision');
  await f.advance(800);
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  await f.advance(4000);
  await f.open('Beta');
  await f.open('Alpha');
  expect(f.editor().value).toBe('conflicting local draft');
  expect(f.disk.get('Alpha.md')).toBe('external revision');
  expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
});

it('does not rename or delete a note when its pending draft cannot be saved', async () => {
  const f = await fixture('zh', {}, [], { command: 'Read-only vault' });
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'must be retained' } });
  fireEvent.change(f.fileName(), { target: { value: 'Gamma' } });
  fireEvent.keyDown(f.fileName(), { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
  expect(f.disk.has('Alpha.md')).toBe(true);
  expect(f.disk.has('Gamma.md')).toBe(false);
  expect(f.requests.some(item => item.command?.action === 'rename')).toBe(false);
  fireEvent.click(f.menu().getByRole('button', { name: f.copy.delete }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.delete }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
  expect(f.disk.has('Alpha.md')).toBe(true);
  expect(f.editor().value).toBe('must be retained');
  expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
});

it('retains an undo to the old text when a committed save loses its response', async () => {
  const f = await fixture();
  await f.open('Alpha');
  let responseLost = false;
  f.interceptCommands(command => {
    if (command.action === 'save' && !responseLost) {
      f.disk.set(command.id, command.text);
      responseLost = true;
      throw new TypeError('The response was lost after the file was written');
    }
  });
  fireEvent.change(f.editor(), { target: { value: 'written but unacknowledged' } });
  f.flush();
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
  expect(f.disk.get('Alpha.md')).toBe('written but unacknowledged');
  fireEvent.change(f.editor(), { target: { value: '# Alpha\n' } });
  const warning = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  expect(f.menu().getByRole('button', { name: f.copy.retrySave })).toBeDefined();
  await f.advance(4000);
  expect(f.editor().value).toBe('# Alpha\n');
  expect(f.disk.get('Alpha.md')).toBe('written but unacknowledged');
  expect(f.requests.filter(item => item.command?.action === 'save')).toHaveLength(1);
  fireEvent.click(f.menu().getByRole('button', { name: f.copy.retrySave }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.editor().value).toBe('# Alpha\n');
  expect(f.disk.get('Alpha.md')).toBe('written but unacknowledged');
});

it('reads externally changed text after rename before accepting its new revision', async () => {
  const f = await fixture();
  await f.open('Alpha');
  const external = '# External edit\nContent changed before the rename.\n';
  f.disk.set('Alpha.md', external);
  fireEvent.change(f.fileName(), { target: { value: 'Gamma' } });
  fireEvent.keyDown(f.fileName(), { key: 'Enter' });
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  await waitFor(() => expect(f.fileName().readOnly).toBe(false));
  expect(f.fileName().value).toBe('Gamma');
  expect(f.editor().value).toBe(external);
  const edited = `${external}\nA local addition after rename.\n`;
  fireEvent.change(f.editor(), { target: { value: edited } });
  f.flush();
  await f.saved('Gamma.md', edited);
  const write = f.requests.find(item => item.command?.action === 'save').command;
  expect(write.expectedRevision).toBe(revision(external));
  expect(f.disk.has('Alpha.md')).toBe(false);
});

it('retains a safe old revision at the renamed path if the changed target cannot be read', async () => {
  const failures = {};
  const f = await fixture('zh', {}, [], failures);
  await f.open('Alpha');
  const external = '# External edit\nMust not be overwritten by old UI text.\n';
  f.disk.set('Alpha.md', external);
  f.interceptCommands(command => { if (command.action === 'rename') failures.note = 'Temporary read failure after rename'; });
  fireEvent.change(f.fileName(), { target: { value: 'Gamma' } });
  fireEvent.keyDown(f.fileName(), { key: 'Enter' });
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  await waitFor(() => expect(f.fileName().readOnly).toBe(false));
  expect(f.fileName().value).toBe('Gamma');
  expect(f.editor().value).toBe('# Alpha\n');
  expect(f.disk.has('Alpha.md')).toBe(false);
  const local = '# Alpha\nUnsaved local follow-up.\n';
  fireEvent.change(f.editor(), { target: { value: local } });
  f.flush();
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.editor().value).toBe(local);
  expect(f.disk.get('Gamma.md')).toBe(external);
  const write = f.requests.find(item => item.command?.action === 'save').command;
  expect(write.id).toBe('Gamma.md');
  expect(write.expectedRevision).toBe(revision('# Alpha\n'));
});
