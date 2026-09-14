/** Adapter synchronization tests; client.spec exercises the shipped real MDXEditor. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';

const harness = vi.hoisted(() => ({ props: undefined, instances: [], crash: false }));

vi.mock('@mdxeditor/editor', async () => {
  const React = await import('react');
  const controls = ['BoldItalicUnderlineToggles', 'BlockTypeSelect', 'CodeMirrorEditor', 'CodeToggle',
    'CreateLink', 'InsertCodeBlock', 'InsertTable', 'InsertThematicBreak', 'ListsToggle', 'UndoRedo'];
  const plugins = ['codeBlockPlugin', 'codeMirrorPlugin', 'headingsPlugin', 'linkDialogPlugin',
    'linkPlugin', 'listsPlugin', 'markdownShortcutPlugin', 'quotePlugin', 'tablePlugin', 'thematicBreakPlugin', 'toolbarPlugin'];
  return {
    ...Object.fromEntries(controls.map(name => [name, () => null])),
    ...Object.fromEntries(plugins.map(name => [name, params => ({ name, params })])),
    addImportVisitor$: 'import-visitors',
    realmPlugin: config => () => ({ name: 'source-preservation', config }),
    UnrecognizedMarkdownConstructError: class extends Error {},
    MDXEditor: React.forwardRef((props, ref) => {
      const instance = React.useRef(null);
      if (!instance.current) {
        const state = { markdown: props.markdown, setMarkdown: undefined };
        state.setMarkdown = vi.fn(value => { state.markdown = value.trim().replaceAll('__', '**'); });
        instance.current = state;
        harness.instances.push(state);
      }
      harness.props = props;
      React.useImperativeHandle(ref, () => ({
        setMarkdown: instance.current.setMarkdown,
        getMarkdown: () => instance.current.markdown,
      }), []);
      if (harness.crash) throw new Error('Synthetic editor rendering failure');
      return React.createElement('div', { className: props.contentEditableClassName, 'data-editor': 'mounted' });
    }),
  };
});

import { RichNoteEditor } from '../src/rich-editor.tsx';
import { notesCopy } from '../src/locales.ts';

beforeEach(() => { harness.props = undefined; harness.instances = []; harness.crash = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fixture(markdown, overrides = {}) {
  let props = { documentKey: 'Alpha.md', markdown, hidden: false, readOnly: false,
    copy: notesCopy('zh-CN'), onChange: vi.fn(), onUnavailable: vi.fn(), ...overrides };
  const result = render(React.createElement(RichNoteEditor, props));
  return { ...result, props: () => props,
    update(changes) { props = { ...props, ...changes }; result.rerender(React.createElement(RichNoteEditor, props)); },
  };
}

function emit(body, initial = false) {
  harness.instances.at(-1).markdown = body;
  harness.props.onChange(body, initial);
}

it('keeps unedited frontmatter, line endings and whitespace when switching modes', async () => {
  const source = '---\r\ntitle: "Raw: title"\r\nnested:\r\n  untouched: yes\r\n---  \r\n\r\n# Heading\r\n\r\n__Bold__\r\n\r\n  ';
  const view = fixture(source);
  const editorNode = view.container.querySelector('[data-editor]');
  act(() => emit('# Heading\n\n**Bold**', true));
  view.update({ hidden: true });
  expect(view.container.firstElementChild.hidden).toBe(true);
  view.update({ hidden: false });
  act(() => emit('# Heading\n\n**Bold**'));
  expect(view.container.querySelector('[data-editor]')).toBe(editorNode);
  expect(harness.instances).toHaveLength(1);
  expect(harness.instances[0].setMarkdown).not.toHaveBeenCalled();
  expect(view.props().onChange).not.toHaveBeenCalled();
  expect(view.props().markdown).toBe(source);
});

it('changes only the edited body while preserving frontmatter bytes and CRLF framing', () => {
  const raw = '---\r\ntitle: "A: B"\r\nunknown: [keep, me]\r\n--- \r\n';
  const view = fixture(`${raw}\r\n# Before\r\n\r\n  `);
  act(() => emit('# Before', true));
  act(() => emit('# After\n\n**Changed**'));
  const expected = `${raw}\r\n# After\r\n\r\n**Changed**\r\n\r\n  `;
  expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith(expected);
  view.update({ markdown: expected });
  expect(harness.instances[0].setMarkdown).not.toHaveBeenCalled();
});

it('separates a new document body from a frontmatter-only file without rewriting its header', () => {
  const source = '---\r\ntitle: Empty\r\n---';
  const view = fixture(source);
  act(() => emit('', true));
  act(() => emit('# Created body'));
  expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith(`${source}\r\n# Created body`);
});

it('imports external source edits silently and retains their exact bytes until a document edit', async () => {
  const view = fixture('# First\n');
  const editorNode = view.container.querySelector('[data-editor]');
  const external = '---\r\ntitle: New\r\n---\r\n\r\n__External__\r\n';
  await act(async () => view.update({ markdown: external }));
  expect(harness.instances[0].setMarkdown).toHaveBeenCalledExactlyOnceWith('__External__');
  view.update({ hidden: false });
  act(() => emit('**External**'));
  expect(view.props().onChange).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-editor]')).toBe(editorNode);
  act(() => emit('**External edit**'));
  expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith('---\r\ntitle: New\r\n---\r\n\r\n**External edit**\r\n');
});

it('defers hidden source imports until the document is reopened and ignores stale editor updates', async () => {
  const view = fixture('# First\n');
  const editorNode = view.container.querySelector('[data-editor]');
  view.update({ hidden: true });
  view.update({ markdown: '# Source edit one\n' });
  view.update({ markdown: '# Source edit two\n' });
  view.update({ markdown: '# Latest source edit\n' });
  act(() => emit('# Stale document update'));
  expect(harness.instances[0].setMarkdown).not.toHaveBeenCalled();
  expect(view.props().onChange).not.toHaveBeenCalled();
  await act(async () => view.update({ hidden: false }));
  expect(harness.instances[0].setMarkdown).toHaveBeenCalledExactlyOnceWith('# Latest source edit');
  expect(view.container.querySelector('[data-editor]')).toBe(editorNode);
  act(() => emit('# Latest source edit'));
  expect(view.props().onChange).not.toHaveBeenCalled();
  act(() => emit('# Latest document edit'));
  expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith('# Latest document edit\n');
});

it('resets the editor on a different note but retains it while read-only or hidden', () => {
  const view = fixture('# First\n');
  const first = view.container.querySelector('[data-editor]');
  view.update({ readOnly: true, hidden: true });
  expect(harness.props.readOnly).toBe(true);
  expect(view.container.querySelector('[data-editor]')).toBe(first);
  view.update({ documentKey: 'Beta.md', markdown: '# Second\n', hidden: false, readOnly: false });
  expect(view.container.querySelector('[data-editor]')).not.toBe(first);
  expect(harness.instances).toHaveLength(2);
  expect(harness.props.markdown).toBe('# Second');
  expect(view.props().onChange).not.toHaveBeenCalled();
});

it('keeps popovers outside the clipped pane, hides them with the editor and removes them on unmount', () => {
  const view = fixture('# Note\n');
  const editorNode = view.container.querySelector('[data-editor]');
  const overlay = harness.props.overlayContainer;
  expect(overlay.parentElement).toBe(document.body);
  expect(view.container.contains(overlay)).toBe(false);
  expect(overlay.hidden).toBe(false);
  const popup = document.createElement('button');
  popup.textContent = 'Synthetic upstream popup';
  overlay.append(popup);
  for (const changes of [{ hidden: true }, { hidden: false, readOnly: true }, { readOnly: false }]) {
    view.update(changes);
    expect(harness.props.overlayContainer).toBe(overlay);
    expect(overlay.hidden).toBe(view.props().hidden || view.props().readOnly);
    expect(view.container.querySelector('[data-editor]')).toBe(editorNode);
    expect(overlay.contains(popup)).toBe(true);
  }
  expect(harness.instances).toHaveLength(1);
  view.unmount();
  expect(overlay.isConnected).toBe(false);
  expect(popup.isConnected).toBe(false);
});

it('reports unsupported imports once and never exports partially parsed content', async () => {
  const original = '# Before\n\n[[Linked note]]\n';
  const view = fixture(original);
  await act(async () => {
    harness.props.onError({ error: 'Unsupported wiki link', source: original });
    emit('# Before');
    harness.props.onError({ error: 'Unsupported wiki link', source: original });
  });
  expect(view.props().onUnavailable).toHaveBeenCalledTimes(1);
  expect(view.props().onChange).not.toHaveBeenCalled();
  await act(async () => view.update({ markdown: '# Supported\n' }));
  act(() => emit('# Supported edit'));
  expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith('# Supported edit\n');
});

it('does not deliver an import failure after its editor was unmounted', async () => {
  const view = fixture('# Old\n');
  await act(async () => {
    harness.props.onError({ error: 'Old failure', source: '# Old' });
    view.unmount();
  });
  expect(view.props().onUnavailable).not.toHaveBeenCalled();
});

it('does not convert a leading indented code block into prose', async () => {
  const source = '---\ntitle: Code\n---\n\n    preserved();\n';
  const view = fixture(source);
  await act(async () => {});
  expect(view.props().onUnavailable).toHaveBeenCalledTimes(1);
  act(() => emit('preserved();'));
  expect(view.props().onChange).not.toHaveBeenCalled();
  expect(view.props().markdown).toBe(source);
});

it('recovers from an editor render failure after the user replaces the source', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const ignoreExpectedError = event => {
    if (event.error?.message === 'Synthetic editor rendering failure') event.preventDefault();
  };
  window.addEventListener('error', ignoreExpectedError);
  try {
    harness.crash = true;
    const view = fixture('# Failing\n');
    await act(async () => {});
    expect(view.props().onUnavailable).toHaveBeenCalledTimes(1);
    harness.crash = false;
    await act(async () => view.update({ markdown: '# Recovered\n' }));
    expect(view.container.querySelector('[data-editor]')).not.toBeNull();
    expect(harness.props.markdown).toBe('# Recovered');
    act(() => emit('# Recovered edit'));
    expect(view.props().onChange).toHaveBeenCalledExactlyOnceWith('# Recovered edit\n');
  } finally {
    window.removeEventListener('error', ignoreExpectedError);
  }
});

it('updates localized controls without replacing the document editor', () => {
  const view = fixture('# Heading\n');
  const editorNode = view.container.querySelector('[data-editor]');
  const translation = harness.props.translation;
  expect(translation('contentArea.editableMarkdown', 'fallback')).toBe('笔记正文');
  expect(translation('toolbar.blockTypes.heading', 'fallback', { level: 3 })).toBe('3 级标题');
  view.update({ copy: notesCopy('en-US') });
  expect(harness.props.translation).toBe(translation);
  expect(translation('contentArea.editableMarkdown', 'fallback')).toBe('Note body');
  expect(translation('toolbar.blockTypes.heading', 'fallback', { level: 3 })).toBe('Heading 3');
  expect(view.container.querySelector('[data-editor]')).toBe(editorNode);
});
