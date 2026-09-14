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
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
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
const note = (id, text) => ({ id, text, title: bare(id), revision: revision(text), links: [], embeds: [], tags: [] });

async function fixture(locale = 'zh', extra = {}, pendingProposals = [], failures = {}) {
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
  let delayRead;
  const request = vi.fn(async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    const url = new URL(path, 'http://localhost');
    requests.push({ path: url.pathname, command: init.body ? JSON.parse(init.body).request : undefined });
    const failure = failures[url.pathname.split('/').at(-1)];
    if (failure) return Response.json({ error: { code: 'invalid_request', message: failure } }, { status: 400 });
    if (url.pathname.endsWith('/tree')) return Response.json({ vault: '/synthetic/notes', notes: [...disk].map(([id, text]) => ({ id, title: bare(id), dir: '', size: text.length, mtimeMs: 1 })) });
    if (url.pathname.endsWith('/tags')) return Response.json({ tags: [] });
    if (url.pathname.endsWith('/backlinks')) return Response.json({ id: url.searchParams.get('id'), notes: [] });
    if (url.pathname.endsWith('/note')) {
      const id = url.searchParams.get('id');
      if (delayRead) await delayRead(id);
      if (!disk.has(id)) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
      return Response.json(note(id, disk.get(id)));
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
    ? { edit: '编辑', body: '笔记正文', source: 'Markdown 源码', document: '文档', unavailable: '这篇笔记包含暂不支持的格式，原文已保留，请使用 Markdown 源码编辑。', preview: '预览', save: '保存', reload: '重新载入', cancel: '取消', delete: '删除', dirty: '未保存', library: '笔记目录', details: '笔记信息', proposals: '待审建议', search: '搜索笔记', apply: '应用' }
    : { edit: 'Edit', body: 'Note body', source: 'Markdown source', document: 'Document', unavailable: 'This note contains unsupported formatting. The original text is preserved; use Markdown source to edit it.', preview: 'Preview', save: 'Save', reload: 'Reload', cancel: 'Cancel', delete: 'Delete', dirty: 'Unsaved', library: 'Note list', details: 'Note details', proposals: 'Proposals', search: 'Search notes', apply: 'Apply' };
  const show = label => {
    const button = screen.getByRole('button', { name: label });
    if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
    return screen.getByRole('region', { name: label });
  };
  const library = () => show(copy.library);
  const details = () => show(copy.details);
  const source = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Markdown', exact: true }));
    return screen.findByRole('textbox', { name: copy.source });
  };
  const open = async (id, mode = 'source') => {
    library();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${id}( |$)`) }));
    await waitFor(() => expect(document.querySelector('.cm-notes-head h2')?.textContent).toBe(id));
    if (mode === 'source' && screen.queryByRole('button', { name: 'Markdown', exact: true })) await source();
  };
  const editor = () => screen.getByRole('textbox', { name: copy.source });
  const richEditor = () => screen.getByRole('textbox', { name: copy.body });
  const title = () => within(document.querySelector('.cm-notes-head'));
  return { disk, requests, view, mount, copy, open, source, editor, richEditor, title, library, details, tab: () => tab, delay: handler => { delayRead = handler; } };
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

  it(`retains the unsaved editor node, selection and scroll across panels and preview (${locale})`, async () => {
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
    fireEvent.click(screen.getByRole('button', { name: f.copy.preview }));
    expect(screen.queryByRole('textbox', { name: f.copy.source })).toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(editor.value).toBe(draft);
    fireEvent.click(screen.getByRole('button', { name: 'Markdown', exact: true }));
    expect(f.editor()).toBe(editor);
    expect(editor.hidden).toBe(false);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([4, 10, 'backward']);
    expect(editor.scrollTop).toBe(180);
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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
    await screen.findByRole('heading', { name: 'Beta' });
    expect(list.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: f.copy.cancel }));
    await f.open('Alpha');
    expect(f.editor().value).toBe('unfinished Alpha draft');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
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
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('error'));
    expect(f.editor().value).toBe('oversized local draft');
    expect(f.editor().readOnly).toBe(false);
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(screen.getByRole('status').textContent).toContain('1024 byte limit');
    delete failures.command;
    fireEvent.change(f.editor(), { target: { value: 'shortened draft' } });
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
    await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('shortened draft'));
  });

  it(`keeps draft and newer file on save conflict without read or delete (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'local unsaved draft' } });
    f.disk.set('Alpha.md', 'newer external text');
    const before = f.requests.length;
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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

  it(`retains dirty notes across note navigation and tab close/reopen (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'retained draft' } });
    await f.open('Beta');
    await f.open('Alpha');
    expect(f.editor().value).toBe('retained draft');
    f.view.unmount();
    const reopened = f.mount();
    await screen.findByRole('button', { name: 'Markdown', exact: true });
    await f.source();
    await waitFor(() => expect(f.editor().value).toBe('retained draft'));
    expect(f.editor().readOnly).toBe(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(f.requests.some(item => item.command)).toBe(false);
    reopened.unmount();
  });

  it(`requires an in-panel confirmation before deleting a note (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.click(screen.getByRole('button', { name: f.copy.delete }));
    expect(f.disk.has('Alpha.md')).toBe(true);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.cancel }));
    expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: f.copy.delete }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.delete }));
    await waitFor(() => expect(f.disk.has('Alpha.md')).toBe(false));
    expect(f.requests.filter(item => item.command?.action === 'delete')).toHaveLength(1);
  });
}

it('ignores an earlier note read that completes after a newer selection', async () => {
  const f = await fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.delay(id => id === 'Alpha.md' ? pending : undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
  await f.open('Beta');
  await act(async () => { release(); await pending; });
  expect(f.title().getByRole('heading', { name: 'Beta' })).toBeDefined();
  expect(f.editor().value).toBe('# Beta\n');
});

it('saves the edited text with its read revision and releases the draft warning', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: '# Updated title\nSaved text' } });
  fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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
  expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
  expect(f.disk.get('Beta.md')).toBe('# Beta\n');
  expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
});

it('renames the open note and opens the new path', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: 'Gamma' } });
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重命名' }));
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  expect(f.disk.has('Alpha.md')).toBe(false);
  expect(f.title().getByRole('heading', { name: 'Gamma' })).toBeDefined();
});

it('offers to create the note a missing wiki link points at', async () => {
  const f = await fixture();
  f.disk.set('Alpha.md', 'see [[Gamma]]\n');
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
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
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Note' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('有多篇笔记匹配这个链接，请选择：')).toBeDefined();
  expect(within(dialog).getAllByRole('button', { name: /Note/ })).toHaveLength(2);
});

it('shows a canvas file read-only with saving disabled', async () => {
  const f = await fixture('zh', { 'Board.canvas': '{"nodes":[]}' });
  await f.open('Board');
  expect(screen.getByText('画布文件以只读方式显示（本版本尚无画布编辑器）。')).toBeDefined();
  expect(screen.queryByRole('textbox', { name: '笔记正文' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Markdown 源码' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Markdown', exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: '保存' }).disabled).toBe(true);
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
  expect(f.title().getByRole('heading', { name: '日记/2026-09-13' })).toBeDefined();
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
    f.delay(async id => { if (id === 'Alpha.md') { reading.resolve(); await release.promise; } });
    f.disk.set('Alpha.md', 'external replacement');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await reading.promise;
    await f.open('Beta');
    fireEvent.change(f.editor(), { target: { value: 'Beta local draft' } });
    await act(async () => { release.resolve(); });
    expect(f.title().getByRole('heading', { name: 'Beta' })).toBeDefined();
    expect(f.editor().value).toBe('Beta local draft');
  });
}

it('preserves a local draft while applying a proposal and still refuses a stale save', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'local draft must survive' } });
  f.details();
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('# Alpha\nreviewed\n'));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.editor().value).toBe('local draft must survive');
  fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
  await waitFor(() => expect(f.requests.some(item => item.command?.action === 'save')).toBe(true));
  expect(f.disk.get('Alpha.md')).toBe('# Alpha\nreviewed\n');
  expect(f.editor().value).toBe('local draft must survive');
  expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
});

it('moves an unsaved draft with a renamed note and saves it at the new path', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'draft before rename' } });
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: 'Gamma' } });
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重命名' }));
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(f.editor().value).toBe('draft before rename');
  expect(f.disk.get('Gamma.md')).toBe('# Alpha\n');
  fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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
    expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
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
    expect(screen.getByRole('button', { name: f.copy.document, exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: f.copy.save }).disabled).toBe(true);
    expect(f.disk.get('Plan.md')).toBe(original);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });

  it(`preserves original frontmatter and line endings when only switching document modes (${locale})`, async () => {
    const original = '---\r\ntags: [工作]\r\ncustom: "保留字节"\r\n---\r\n\r\n# 本周计划\r\n\r\n**重要事项**\r\n\r\n';
    const f = await fixture(locale, { 'Roundtrip.md': original });
    await f.open('Roundtrip', 'document');
    await screen.findByRole('textbox', { name: f.copy.body });
    for (const mode of ['Markdown', f.copy.preview, f.copy.document, 'Markdown']) {
      fireEvent.click(screen.getByRole('button', { name: mode, exact: true }));
      if (mode === 'Markdown') expect(f.editor().value).toBe(original.replace(/\r\n/g, '\n'));
      expect(screen.getByRole('button', { name: f.copy.save }).disabled).toBe(true);
    }
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
    fireEvent.click(screen.getByRole('button', { name: f.copy.document, exact: true }));
    const body = await screen.findByRole('textbox', { name: f.copy.body });
    await within(body).findByRole('heading', { level: 1, name: '修改后的计划' });
    expect(body.querySelector('strong')?.textContent).toBe('已核对');
    await f.source();
    expect(f.editor().value).toBe(draft);
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
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
    expect(screen.getByRole('button', { name: f.copy.document, exact: true }).disabled).toBe(true);
    expect(screen.queryByRole('textbox', { name: f.copy.body })).toBeNull();
    expect(screen.getByRole('button', { name: f.copy.save }).disabled).toBe(true);
    expect(f.disk.get('Unsupported.md')).toBe(original);
    expect(f.requests.filter(item => item.command)).toHaveLength(0);
  });
}
