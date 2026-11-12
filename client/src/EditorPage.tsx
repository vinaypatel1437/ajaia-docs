import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { api, timeAgo, type Comment, type Doc, type PresenceUser, type User, type VersionSummary } from './api';
import { useAutosave, type SaveStatus } from './useAutosave';
import { ShareDialog } from './ShareDialog';
import { CommentsPanel } from './CommentsPanel';
import { HistoryPanel } from './HistoryPanel';
import { useCollab } from './useCollab';
import { Avatar, Icon, Toast, roleLabel, type IconName } from './ui';


export function EditorPage({ id, user }: { id: string; user: User }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.getDoc(id).then((r) => setDoc(r.document)).catch((e) => setLoadError(e.message));
  }, [id]);

  if (loadError) {
    return (
      <main className="center">
        <div className="empty" style={{ maxWidth: 440, padding: 32 }}>
          <Icon name="lock" size={28} />
          <h2 style={{ color: 'var(--text)', fontSize: 18 }}>Can’t open this document</h2>
          <p>{loadError}. It may have been deleted, or it hasn’t been shared with {user.name}.</p>
          <a className="btn" href="#/" style={{ marginTop: 8 }}><Icon name="arrowLeft" size={16} />Back to documents</a>
        </div>
      </main>
    );
  }
  if (!doc) return <main className="center muted"><Icon name="loader" size={22} /></main>;
  return <LoadedEditor initial={doc} user={user} />;
}

const FALLBACK_POLL_MS = 30000;
type Panel = null | 'comments' | 'history';

function LoadedEditor({ initial, user }: { initial: Doc; user: User }) {
  const [doc, setDoc] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [preview, setPreview] = useState<{ meta: VersionSummary; title: string; content: string } | null>(null);
  const [access, setAccess] = useState<'ok' | 'lost' | 'changed'>('ok');
  const canEdit = initial.role !== 'viewer';
  const save = useAutosave(initial, (d) => setDoc(d));
  const lastActivityPing = useRef(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Placeholder.configure({ placeholder: canEdit ? 'Start writing…' : 'This document is empty.' }),
    ],
    content: initial.content,
    editable: canEdit,
    onUpdate: ({ editor }) => {
      save.queue({ content: editor.getHTML() });
      if (Date.now() - lastActivityPing.current > 2000) {
        lastActivityPing.current = Date.now();
        api.activity(initial.id).catch(() => {});
      }
    },
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? '' : n)), 4000);
  };

  function applyRemote(latest: Doc, message: string) {
    save.adopt(latest);
    setDoc(latest);
    setTitle(latest.title);
    const ed = editorRef.current;
    if (ed) {
      const { from, to } = ed.state.selection;
      ed.commands.setContent(latest.content, false);
      const max = ed.state.doc.content.size;
      ed.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    }
    flash(message);
  }

  /** Pull the latest saved state if we have nothing unsaved; otherwise the next save resolves via 409. */
  const pullLatest = async (message: string) => {
    if (save.isDirty() || save.statusKind() === 'conflict') return;
    try {
      const { document: latest } = await api.getDoc(initial.id);
      if (latest.version > save.version.current && !save.isDirty()) applyRemote(latest, message);
    } catch { /* access changes are handled by the 'access' event */ }
  };

  const refreshComments = () => api.comments(initial.id).then((r) => setComments(r.comments)).catch(() => {});
  const refreshVersions = () => api.versions(initial.id)
    .then((r) => { setVersions(r.versions); setHistoryError(''); })
    .catch((e) => setHistoryError(e.message));

  useEffect(() => { refreshComments(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (panel === 'history') refreshVersions(); }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const { others, connected } = useCollab(initial.id, user.id, {
    onSaved: (version, by) => {
      if (version > save.version.current) void pullLatest(`Updated with changes from ${by.name}.`);
      if (panel === 'history') refreshVersions();
    },
    onComments: refreshComments,
    onAccess: async () => {
      try {
        const { document: d } = await api.getDoc(initial.id);
        if (d.role !== initial.role) setAccess('changed');
      } catch {
        setAccess('lost');
        editorRef.current?.setEditable(false);
      }
    },
  });

  // Safety net if the event stream is unavailable (e.g. a proxy that buffers SSE).
  useEffect(() => {
    if (connected) return;
    const t = window.setInterval(() => { if (!document.hidden) void pullLatest('Updated with changes from a collaborator.'); }, FALLBACK_POLL_MS);
    return () => window.clearInterval(t);
  }); // re-bound each render so it sees fresh state

  const onTitleChange = (value: string) => {
    setTitle(value);
    if (value.trim()) save.queue({ title: value.trim() });
  };

  const exportMarkdown = async () => {
    await save.flush();
    window.location.href = `/api/documents/${doc.id}/export.md`;
  };

  const exportPdf = async () => {
    await save.flush();
    const previous = document.title;
    document.title = (preview?.title ?? title) || 'document'; // becomes the default PDF filename
    window.print();
    document.title = previous;
  };

  const openPreview = async (v: VersionSummary | null) => {
    if (!v) { setPreview(null); return; }
    try {
      const { version } = await api.version(initial.id, v.id);
      setPreview({ meta: v, title: version.title, content: version.content });
    } catch (e) { setHistoryError((e as Error).message); }
  };

  const restore = async () => {
    if (!preview) return;
    await save.flush();
    try {
      const { document: restored } = await api.restore(initial.id, preview.meta.id);
      setPreview(null);
      applyRemote(restored, 'Version restored. The replaced version is kept in history.');
      refreshVersions();
    } catch (e) { setHistoryError((e as Error).message); }
  };

  const jumpTo = (quote: string) => {
    const ed = editorRef.current;
    const range = ed && findText(ed, quote);
    if (!ed || !range) { flash('That text is no longer in the document.'); return false; }
    setPreview(null);
    ed.chain().focus().setTextSelection(range).scrollIntoView().run();
    return true;
  };

  if (!editor) return null;

  const sel = editor.state.selection;
  const selectedText = sel.empty ? '' : editor.state.doc.textBetween(sel.from, sel.to, ' ');
  const openComments = (comments ?? []).filter((c) => !c.resolved).length;
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <main className={`editor-page ${canEdit && !preview && access !== 'lost' ? 'has-toolbar' : ''}`}>
      <header className="doc-bar no-print">
        <div className="doc-bar-row">
          <a href="#/" className="btn ghost icon-only" aria-label="Back to documents" title="Back to documents"><Icon name="arrowLeft" /></a>
          <span className="doc-file-icon hide-sm"><Icon name="file" size={18} /></span>
          <div className="doc-title-block">
            <input
              className="title-input"
              value={title}
              readOnly={!canEdit || access === 'lost'}
              maxLength={200}
              aria-label="Document title"
              placeholder="Untitled document"
              onChange={(e) => onTitleChange(e.target.value)}
              onBlur={() => { if (!title.trim()) setTitle(doc.title); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editor.commands.focus(); } }}
            />
            <div className="doc-sub">
              <SaveIndicator status={save.status} canEdit={canEdit} onRetry={() => void save.flush()} />
              <span className="dot" />
              <span>{initial.role === 'owner' ? 'Owned by you' : initial.role === 'editor' ? `${roleLabel('editor')} · Owned by ${doc.owner.name}` : `Owned by ${doc.owner.name}`}</span>
            </div>
          </div>
          <div className="doc-actions">
            <Presence others={others} />
            <button
              className={`btn ghost small ${panel === 'comments' ? 'pressed' : ''}`} onClick={() => togglePanel('comments')}
              title="Comments" aria-label={openComments ? `Comments (${openComments})` : 'Comments'}
            >
              <Icon name="message" size={16} /><span className="hide-md">Comments</span>
              {openComments > 0 && <span className="count">{openComments}</span>}
            </button>
            <button className={`btn ghost small ${panel === 'history' ? 'pressed' : ''}`} onClick={() => togglePanel('history')} title="Version history" aria-label="History">
              <Icon name="history" size={16} /><span className="hide-md">History</span>
            </button>
            <ExportMenu onMarkdown={exportMarkdown} onPdf={exportPdf} />
            <button className="btn primary small" onClick={() => setShareOpen(true)}>
              <Icon name={initial.role === 'owner' ? 'userPlus' : 'users'} size={16} />
              {initial.role === 'owner' ? 'Share' : 'People'}
            </button>
          </div>
        </div>
        {canEdit && !preview && access !== 'lost' && (
          <div className="toolbar-row"><Toolbar editor={editor} onComment={() => setPanel('comments')} /></div>
        )}
      </header>

      <div className="canvas">
        <div className="canvas-inner">
          <div className="page-col">
            <div className="no-print" style={{ display: 'contents' }}>
              {access === 'lost' && (
                <Banner tone="danger" icon="lock" text="Your access to this document was removed by the owner.">
                  <a className="btn small" href="#/">Back to documents</a>
                </Banner>
              )}
              {access === 'changed' && (
                <Banner tone="info" icon="info" text="Your access level for this document changed.">
                  <button className="btn small" onClick={() => window.location.reload()}>Reload</button>
                </Banner>
              )}
              {!canEdit && access === 'ok' && (
                <Banner tone="info" icon="eye" text={<>You have <strong>view-only</strong> access. You can still leave comments. Ask {doc.owner.name} if you need to edit.</>} />
              )}
              {save.status.kind === 'conflict' && (
                <Banner tone="warn" icon="alert" text={<><strong>Someone else saved this document while you were editing.</strong> Your latest changes aren’t saved yet.</>}>
                  <button className="btn small" onClick={() => applyRemote((save.status as Extract<SaveStatus, { kind: 'conflict' }>).server, 'Loaded the latest version.')}>
                    Load their version
                  </button>
                  <button className="btn small primary" onClick={() => save.overwrite(
                    (save.status as Extract<SaveStatus, { kind: 'conflict' }>).server,
                    { content: editor.getHTML(), ...(title.trim() ? { title: title.trim() } : {}) },
                  )}>Keep mine</button>
                </Banner>
              )}
              {preview && (
                <Banner tone="warn" icon="history" text={<>Viewing the version from <strong>{fmtDate(preview.meta.createdAt)}</strong>{preview.meta.authorName ? ` by ${preview.meta.authorName}` : ''}. This is read-only.</>}>
                  <button className="btn small" onClick={() => setPreview(null)}>Back to current</button>
                  {canEdit && <button className="btn small primary" onClick={restore}><Icon name="restore" size={15} />Restore this version</button>}
                </Banner>
              )}
            </div>
            <h1 className="print-title">{preview?.title ?? title}</h1>
            {preview && (
              <div className="paper preview">
                {/* Server-sanitized HTML (allowlist in server/src/content.ts). */}
                <div className="prose"><div className="ProseMirror" dangerouslySetInnerHTML={{ __html: preview.content }} /></div>
              </div>
            )}
            <div className="paper" hidden={!!preview} onClick={() => !editor.isFocused && canEdit && editor.commands.focus()}>
              <EditorContent editor={editor} className="prose" />
            </div>
          </div>
          {panel && (
            <aside className="side-panel no-print" aria-label={panel === 'comments' ? 'Comments' : 'Version history'}>
              <div className="side-head">
                <h2><Icon name={panel === 'comments' ? 'message' : 'history'} size={16} />{panel === 'comments' ? 'Comments' : 'Version history'}</h2>
                <button className="btn ghost small icon-only" aria-label="Close panel" onClick={() => setPanel(null)}><Icon name="x" size={16} /></button>
              </div>
              <div className="side-body">
                {panel === 'comments'
                  ? <CommentsPanel
                      doc={doc} user={user} comments={comments} setComments={setComments}
                      selectedText={selectedText}
                      onClearSelection={() => editor.commands.setTextSelection(editor.state.selection.to)}
                      onJump={jumpTo}
                    />
                  : <HistoryPanel doc={doc} versions={versions} previewId={preview?.meta.id ?? null} onPreview={openPreview} error={historyError} />}
              </div>
            </aside>
          )}
        </div>
      </div>

      <Toast message={notice} />
      {shareOpen && <ShareDialog doc={doc} onClose={() => setShareOpen(false)} />}
    </main>
  );
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Banner({ tone, icon, text, children }: {
  tone: 'info' | 'warn' | 'danger'; icon: IconName; text: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className={`banner ${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      <Icon name={icon} size={18} />
      <span className="banner-text">{text}</span>
      {children && <span className="row">{children}</span>}
    </div>
  );
}

/** Map a quoted string back to a document range (quotes may span formatting/blocks). */
function findText(editor: Editor, needle: string): { from: number; to: number } | null {
  let text = '';
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) { text += node.text![i]; positions.push(pos + i); }
    } else if (node.isBlock && text.length && !text.endsWith(' ')) {
      text += ' '; positions.push(-1);
    }
  });
  const idx = text.indexOf(needle);
  if (idx < 0 || !needle) return null;
  return { from: positions[idx], to: positions[idx + needle.length - 1] + 1 };
}

function Presence({ others }: { others: Array<PresenceUser & { editing: boolean }> }) {
  if (!others.length) return null;
  const editing = others.filter((o) => o.editing);
  const first = (u: PresenceUser) => u.name.split(' ')[0];
  const label = editing.length
    ? `${editing.map(first).join(', ')} ${editing.length > 1 ? 'are' : 'is'} editing`
    : others.length === 1 ? `${first(others[0])} is here` : `${others.length} others here`;
  return (
    <span className="presence" aria-label="People in this document">
      <span className="presence-stack">
        {others.slice(0, 3).map((u) => (
          <span key={u.id} className={`presence-avatar ${u.editing ? 'editing' : ''}`} title={`${u.name} · ${u.editing ? 'editing' : 'viewing'}`}>
            <Avatar user={u} size={28} />
          </span>
        ))}
      </span>
      {others.length > 3 && <span className="presence-label">+{others.length - 3}</span>}
      <span className={`presence-label hide-md ${editing.length ? 'live' : ''}`}>{label}</span>
    </span>
  );
}

function ExportMenu({ onMarkdown, onPdf }: { onMarkdown: () => void; onPdf: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span className="menu">
      <button
        className="btn ghost small" aria-haspopup="menu" aria-expanded={open} title="Export"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <Icon name="download" size={16} /><span className="hide-md">Export</span><Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <span className="menu-list" role="menu">
          <button role="menuitem" onClick={onMarkdown}><Icon name="markdown" size={16} />Markdown<span className="hint">.md</span></button>
          <button role="menuitem" onClick={onPdf}><Icon name="printer" size={16} />PDF<span className="hint">via print</span></button>
        </span>
      )}
    </span>
  );
}

function SaveIndicator({ status, canEdit, onRetry }: { status: SaveStatus; canEdit: boolean; onRetry: () => void }) {
  if (!canEdit) return <span className="save-status ok"><Icon name="eye" size={13} />View only</span>;
  switch (status.kind) {
    case 'saved': return <span className="save-status ok"><Icon name="checkCircle" size={13} />Saved{status.at ? ` ${timeAgo(status.at)}` : ''}</span>;
    case 'pending': return <span className="save-status ok"><Icon name="cloud" size={13} />Unsaved changes</span>;
    case 'saving': return <span className="save-status ok"><Icon name="loader" size={13} />Saving…</span>;
    case 'conflict': return <span className="save-status warn"><Icon name="alert" size={13} />Not saved: conflict</span>;
    case 'error': return (
      <span className="save-status err" title={status.message}>
        <Icon name="alert" size={13} />Couldn’t save <button className="text-btn accent" onClick={onRetry}>Retry</button>
      </span>
    );
  }
}

function Toolbar({ editor, onComment }: { editor: Editor; onComment: () => void }) {
  const block = editor.isActive('heading', { level: 1 }) ? 'h1'
    : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';

  const setBlock = (v: string) => {
    const chain = editor.chain().focus();
    if (v === 'p') chain.setParagraph().run();
    else chain.setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
  };

  const Btn = ({ icon, title, active, onClick, disabled, label }: {
    icon: IconName; title: string; active?: boolean; onClick: () => void; disabled?: boolean; label?: string;
  }) => (
    <button
      type="button" title={title} aria-label={title} aria-pressed={active}
      className={`tb-btn ${active ? 'active' : ''} ${label ? 'wide' : ''}`}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
    ><Icon name={icon} size={17} />{label && <span className="hide-sm">{label}</span>}</button>
  );

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Btn icon="undo" title="Undo (⌘Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} />
      <Btn icon="redo" title="Redo (⌘⇧Z)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} />
      <span className="tb-sep" />
      <select className="tb-select" value={block} onChange={(e) => setBlock(e.target.value)} aria-label="Text style">
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="tb-sep" />
      <Btn icon="bold" title="Bold (⌘B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn icon="italic" title="Italic (⌘I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn icon="underline" title="Underline (⌘U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <Btn icon="strike" title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <span className="tb-sep" />
      <Btn icon="list" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Btn icon="listOrdered" title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <Btn icon="quote" title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
      <Btn icon="divider" title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
      <span className="tb-sep" />
      <Btn icon="messagePlus" title="Comment on selection" label="Comment" onClick={onComment} />
    </div>
  );
}
