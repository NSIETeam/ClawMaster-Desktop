/** Markdown document editing with MDXEditor's maintained parser, controls and history. */
import { Component, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  MDXEditor, BoldItalicUnderlineToggles, BlockTypeSelect, CodeMirrorEditor, CodeToggle,
  CreateLink, InsertCodeBlock, InsertTable, InsertThematicBreak, ListsToggle, UndoRedo,
  UnrecognizedMarkdownConstructError, addImportVisitor$, codeBlockPlugin, codeMirrorPlugin,
  headingsPlugin, linkDialogPlugin, linkPlugin, listsPlugin, markdownShortcutPlugin,
  quotePlugin, realmPlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin,
} from '@mdxeditor/editor';
import type { MDXEditorMethods, Translation } from '@mdxeditor/editor';
import type { NotesCopy } from './locales.ts';
import { parseFrontmatter } from './note-format.ts';

/** A full Markdown draft; hiding the editor retains its selection and undo history. */
export interface RichNoteEditorProps {
  documentKey: string;
  markdown: string;
  readOnly: boolean;
  hidden: boolean;
  copy: NotesCopy;
  onChange: (text: string) => void;
  onUnavailable: () => void;
}

const preserveWikiSourcePlugin = realmPlugin({
  init(realm) {
    realm.pub(addImportVisitor$, {
      priority: 100,
      testNode: node => node.type === 'text' && /\[\[/.test(node.value),
      visitNode() {
        // Escaping wiki brackets changes the vault's link graph. Code nodes are atomic
        // imports and therefore keep literal wiki-link examples available in documents.
        throw new UnrecognizedMarkdownConstructError('Wiki links require Markdown source editing.');
      },
    });
  },
});

function splitSource(source: string) {
  const { raw, body } = parseFrontmatter(source);
  const start = body.length - body.trimStart().length;
  const end = Math.max(start, body.trimEnd().length);
  return {
    frontmatter: raw ?? '',
    leading: body.slice(0, start),
    trailing: body.slice(end),
    body: body.slice(start, end),
    crlf: (body || raw || '').includes('\r\n') && !/(?<!\r)\n/.test(body || raw || ''),
    // MDXEditor trims its input internally, which would turn a leading indented
    // code block into prose. Such documents remain editable in source mode.
    indentedStart: /^(?:[ \t]*\r?\n)*(?: {4}|\t)/.test(body),
  };
}

function joinSource(parts: ReturnType<typeof splitSource>, markdown: string): string {
  const body = parts.crlf ? markdown.replace(/\r?\n/g, '\r\n') : markdown;
  const separator = parts.frontmatter && !parts.frontmatter.endsWith('\n') && body
    ? (parts.crlf ? '\r\n' : '\n') : '';
  return `${parts.frontmatter}${separator}${parts.leading}${body}${parts.trailing}`;
}

class EditorFailure extends Component<{ children: ReactNode; onUnavailable: () => void; source: string }, { failed: boolean; source: string }> {
  override state = { failed: false, source: this.props.source };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
    return props.source === state.source ? null : { failed: false, source: props.source };
  }
  override componentDidCatch(): void { this.props.onUnavailable(); }
  override render(): ReactNode { return this.state.failed ? null : this.props.children; }
}

function MountedRichEditor(props: RichNoteEditorProps): ReactNode {
  const latest = useRef(props);
  latest.current = props;
  const editor = useRef<MDXEditorMethods>(null);
  const input = useMemo(() => splitSource(props.markdown), [props.markdown]);
  const initial = useRef(input);
  const current = useRef({ source: props.markdown, parts: initial.current, body: initial.current.body, generation: 0 });
  const mounted = useRef(false);
  const unavailableSource = useRef<string | null>(null);
  const synchronizing = useRef(false);
  const [overlayContainer, setOverlayContainer] = useState<HTMLDivElement | null>(null);

  const reportUnavailable = useCallback(() => {
    const source = latest.current.markdown;
    if (unavailableSource.current === source) return;
    unavailableSource.current = source;
    // Import errors can arrive while MDXEditor creates its realm during render.
    // Defer the parent's mode update until that render has committed.
    queueMicrotask(() => {
      if (mounted.current && unavailableSource.current === source && latest.current.markdown === source) latest.current.onUnavailable();
    });
  }, []);

  const translation = useCallback<Translation>((key, fallback, values) => {
    let text = latest.current.copy.mdxTranslations[key] ?? fallback;
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{{${name}}}`, String(value));
    return text;
  }, []);

  const plugins = useMemo(() => [
    preserveWikiSourcePlugin(), headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(),
    linkPlugin({ disableAutoLink: true }), linkDialogPlugin(), tablePlugin(),
    codeBlockPlugin({
      defaultCodeBlockLanguage: '',
      codeBlockEditorDescriptors: [{ priority: -1, match: () => true, Editor: CodeMirrorEditor }],
    }),
    codeMirrorPlugin({
      autoLoadLanguageSupport: false,
      codeBlockLanguages: { '': translation('codeBlock.plainText', 'Plain text'), js: 'JavaScript', ts: 'TypeScript', json: 'JSON', python: 'Python', css: 'CSS', html: 'HTML', sql: 'SQL', sh: 'Shell' },
    }),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarClassName: 'cm-notes-rich-toolbar',
      toolbarContents: () => <>
        <UndoRedo /><BoldItalicUnderlineToggles options={['Bold', 'Italic']} /><CodeToggle />
        <BlockTypeSelect /><ListsToggle /><CreateLink /><InsertTable /><InsertThematicBreak /><InsertCodeBlock />
      </>,
    }),
  ], [translation, props.copy.mdxTranslations]);

  useLayoutEffect(() => {
    mounted.current = true;
    if (initial.current.indentedStart) reportUnavailable();
    return () => { mounted.current = false; };
  }, [reportUnavailable]);

  useLayoutEffect(() => {
    if (props.hidden || props.markdown === current.current.source) return;
    const parts = input;
    const generation = current.current.generation + 1;
    current.current = { source: props.markdown, parts, body: parts.body, generation };
    if (unavailableSource.current !== props.markdown) unavailableSource.current = null;
    if (parts.indentedStart) { synchronizing.current = false; reportUnavailable(); return; }
    synchronizing.current = true;
    editor.current?.setMarkdown(parts.body);
    // setMarkdown suppresses its own onChange. Capture its normalized export as the
    // comparison baseline, without replacing the user's unedited source bytes.
    queueMicrotask(() => {
      if (!mounted.current || current.current.generation !== generation) return;
      current.current.body = editor.current?.getMarkdown() ?? parts.body;
      synchronizing.current = false;
    });
  }, [props.markdown, props.hidden, input, reportUnavailable]);

  const onChange = useCallback((body: string, initialNormalize: boolean) => {
    if (unavailableSource.current !== null || synchronizing.current) return;
    if (latest.current.hidden && latest.current.markdown !== current.current.source) return;
    if (initialNormalize) { current.current.body = body; return; }
    if (body === current.current.body) return;
    const source = joinSource(current.current.parts, body);
    current.current.body = body;
    current.current.source = source;
    latest.current.onChange(source);
  }, []);

  return <><div className="cm-notes-rich" hidden={props.hidden}>
    <EditorFailure onUnavailable={reportUnavailable} source={props.markdown}>
      <MDXEditor ref={editor} markdown={input.body} trim={false}
        className="mdxeditor-full-height" contentEditableClassName="cm-notes-document-content"
        lexicalEditorNamespace="clawmaster-notes" readOnly={props.readOnly}
        suppressHtmlProcessing translation={translation} plugins={plugins}
        overlayContainer={overlayContainer} onChange={onChange} onError={reportUnavailable} />
    </EditorFailure>
  </div>{createPortal(
    <div className="cm-notes-rich-overlays" hidden={props.hidden || props.readOnly} ref={setOverlayContainer} />,
    document.body,
  )}</>;
}

/**
 * Edit a Markdown note while retaining frontmatter and untouched source bytes.
 * @param props The current draft, locale and edit callbacks; documentKey resets history.
 * @returns A mounted document editor, hidden when the source or preview is active.
 */
export function RichNoteEditor(props: RichNoteEditorProps): ReactNode {
  return <MountedRichEditor key={props.documentKey} {...props} />;
}
