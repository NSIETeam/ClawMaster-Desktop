import { notesRichCopy } from './rich-copy.ts';

/** Notes copy in both product locales. */
export type NotesLocale = 'zh-CN' | 'en-US';

/** Every string the notes panel renders. */
export interface NotesCopy {
  tab: string;
  tabDescription: string;
  vault: string;
  noteList: string;
  noteDetails: string;
  editorMode: string;
  documentMode: string;
  markdownMode: string;
  markdownSource: string;
  richUnavailable: string;
  mdxTranslations: Readonly<Record<string, string>>;
  newNote: string;
  noteName: string;
  create: string;
  cancel: string;
  search: string;
  searchPlaceholder: string;
  results: string;
  noResults: string;
  line: string;
  rename: string;
  renameLabel: string;
  todayNote: string;
  canvasReadOnly: string;
  external: string;
  proposals: string;
  noProposals: string;
  applyProposal: string;
  discardProposal: string;
  wikiAmbiguous: string;
  wikiMissing: string;
  wikiCreate: string;
  edit: string;
  preview: string;
  save: string;
  saving: string;
  saved: string;
  dirty: string;
  conflict: string;
  conflictReload: string;
  reloadConfirm: string;
  invalidRevision: string;
  backlinks: string;
  noBacklinks: string;
  tags: string;
  noTags: string;
  empty: string;
  open: string;
  delete: string;
  deleteConfirm: string;
  missingTarget: string;
  loading: string;
  error: string;
  retry: string;
  dismiss: string;
  unsaved: string;
}

const copy: Record<NotesLocale, NotesCopy> = {
  'zh-CN': {
    tab: '笔记', tabDescription: '内置 Markdown 笔记库：双向链接、反链、标签与全文搜索',
    editorMode: '编辑模式', documentMode: '文档', markdownMode: 'Markdown', markdownSource: 'Markdown 源码',
    richUnavailable: '这篇笔记包含暂不支持的格式，原文已保留，请使用 Markdown 源码编辑。',
    mdxTranslations: notesRichCopy('zh-CN'),
    noteList: '笔记目录', noteDetails: '笔记信息',
    vault: '笔记库', newNote: '新建笔记', noteName: '笔记名称', create: '创建', cancel: '取消',
    search: '搜索笔记', searchPlaceholder: '输入关键词…', results: '搜索结果', noResults: '没有匹配的笔记',
    line: '第', rename: '重命名', renameLabel: '新名称', todayNote: '今日笔记',
    canvasReadOnly: '画布文件以只读方式显示（本版本尚无画布编辑器）。',
    external: '笔记已被外部修改', proposals: '待审建议', noProposals: '暂无待审建议',
    applyProposal: '应用', discardProposal: '丢弃',
    wikiAmbiguous: '有多篇笔记匹配这个链接，请选择：', wikiMissing: '这个链接指向的笔记还不存在。', wikiCreate: '创建这篇笔记',
    edit: '编辑', preview: '预览', save: '保存', saving: '保存中…', saved: '已保存', dirty: '未保存',
    conflict: '笔记已在其他位置修改。本地草稿已保留，磁盘内容未覆盖。', conflictReload: '重新载入',
    reloadConfirm: '重新载入磁盘版本会放弃这篇笔记的本地草稿。继续吗？',
    invalidRevision: '保存结果缺少笔记版本，请保留草稿并重试。',
    backlinks: '反向链接', noBacklinks: '暂无反向链接', tags: '标签', noTags: '暂无标签',
    empty: '这个笔记库还是空的，先创建一篇笔记。', open: '打开', delete: '删除',
    deleteConfirm: '确定删除这篇笔记？此操作不可恢复。', missingTarget: '链接的目标笔记不存在',
    loading: '载入中…', error: '操作失败', retry: '重试载入', dismiss: '知道了', unsaved: '有未保存的修改',
  },
  'en-US': {
    tab: 'Notes', tabDescription: 'Built-in Markdown vault: wiki links, backlinks, tags and search',
    editorMode: 'Editor mode', documentMode: 'Document', markdownMode: 'Markdown', markdownSource: 'Markdown source',
    richUnavailable: 'This note contains unsupported formatting. The original text is preserved; use Markdown source to edit it.',
    mdxTranslations: notesRichCopy('en-US'),
    noteList: 'Note list', noteDetails: 'Note details',
    vault: 'Vault', newNote: 'New note', noteName: 'Note name', create: 'Create', cancel: 'Cancel',
    search: 'Search notes', searchPlaceholder: 'Type a keyword…', results: 'Results', noResults: 'No matching notes',
    line: 'line', rename: 'Rename', renameLabel: 'New name', todayNote: "Today's note",
    canvasReadOnly: 'Canvas files are shown read-only; this version has no canvas editor.',
    external: 'The note changed outside ClawMaster', proposals: 'Proposals', noProposals: 'No proposals pending',
    applyProposal: 'Apply', discardProposal: 'Discard',
    wikiAmbiguous: 'Several notes match this link. Pick one:', wikiMissing: 'The linked note does not exist yet.', wikiCreate: 'Create this note',
    edit: 'Edit', preview: 'Preview', save: 'Save', saving: 'Saving…', saved: 'Saved', dirty: 'Unsaved',
    conflict: 'This note changed elsewhere. Your draft is retained and the file was not overwritten.', conflictReload: 'Reload',
    reloadConfirm: 'Reloading the file discards this note’s local draft. Continue?',
    invalidRevision: 'The save response has no note revision. Keep your draft and try again.',
    backlinks: 'Backlinks', noBacklinks: 'No backlinks yet', tags: 'Tags', noTags: 'No tags yet',
    empty: 'This vault is empty. Create the first note.', open: 'Open', delete: 'Delete',
    deleteConfirm: 'Delete this note? This cannot be undone.', missingTarget: 'The linked note does not exist',
    loading: 'Loading…', error: 'The operation failed', retry: 'Retry loading', dismiss: 'Dismiss', unsaved: 'Unsaved changes',
  },
};

/** Copy for one locale. */
export function notesCopy(locale: NotesLocale): NotesCopy {
  return copy[locale];
}
