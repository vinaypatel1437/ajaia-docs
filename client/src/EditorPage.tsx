import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { api, timeAgo, type Doc, type User } from './api';
import { useAutosave, type SaveStatus } from './useAutosave';
import { ShareDialog } from './ShareDialog';
import { Avatar } from './ui';

const REMOTE_POLL_MS = 8000;

export function EditorPage({ id, user }: { id: string; user: User }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.getDoc(id).then((r) => setDoc(r.document)).catch((e) => setLoadError(e.message));
  }, [id]);

  if (loadError) {
    return (
      <main className="center column">
        <h2>Can't open this document</h2>
        <p className="muted">{loadError}. It may have been deleted, or it hasn't been shared with {user.name}.</p>
        <a className="btn" href="#/">Back to documents</a>
      </main>
    );
  }
  if (!doc) return <main className="center muted">Loading document…</main>;
  return <LoadedEditor initial={doc} />;
}

function LoadedEditor({ initial }: { initial: Doc }) {
  const [doc, setDoc] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const canEdit = initial.role !== 'viewer';
  const save = useAutosave(initial, (d) => setDoc(d));

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Placeholder.configure({ placeholder: canEdit ? 'Start writing…' : 'This document is empty.' }),
    ],
    content: initial.content,
    editable: canEdit,
    onUpdate: ({ editor }) => save.queue({ content: editor.getHTML() }),
  });

  // Pick up collaborators' saves while we have nothing unsaved (lightweight, no websockets).
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  useEffect(() => {
    const t = window.setInterval(async () => {
      if (document.hidden || save.isDirty() || save.statusKind() === 'conflict') return;
      try {
        const { document: latest } = await api.getDoc(initial.id);
        if (latest.version > save.version.current && !save.isDirty()) applyRemote(latest, 'Updated with changes from a collaborator.');
      } catch { /* transient; next tick retries */ }
    }, REMOTE_POLL_MS);
    return () => window.clearInterval(t);
  }); // re-bound each render so it sees fresh state

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
    setNotice(message);
    window.setTimeout(() => setNotice(''), 4000);
  }

  const onTitleChange = (value: string) => {
    setTitle(value);
    if (value.trim()) save.queue({ title: value.trim() });
  };

  const exportMarkdown = async () => {
    await save.flush();
    window.location.href = `/api/documents/${doc.id}/export.md`;
  };

  if (!editor) return null;

  return (
    <main className="editor-page">
      <div className="doc-header">
        <a href="#/" className="btn ghost small" aria-label="Back to documents">←</a>
        <input
          className="title-input"
          value={title}
          readOnly={!canEdit}
          maxLength={200}
          aria-label="Document title"
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={() => { if (!title.trim()) setTitle(doc.title); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editor.commands.focus(); } }}
        />
        <SaveIndicator status={save.status} canEdit={canEdit} onRetry={() => void save.flush()} />
        <div className="doc-header-right">
          <span className="owner-chip" title={`Owner: ${doc.owner.name}`}>
            <Avatar user={doc.owner} size={22} />
            <span className="small hide-sm">{initial.role === 'owner' ? 'You own this' : `Owned by ${doc.owner.name}`}</span>
          </span>
          <button className="btn small" onClick={exportMarkdown}>Export .md</button>
          <button className="btn primary small" onClick={() => setShareOpen(true)}>
            {initial.role === 'owner' ? 'Share' : 'People'}
          </button>
        </div>
      </div>

      {!canEdit && <div className="banner info">You have view-only access. Ask {doc.owner.name} for edit access.</div>}
      {notice && <div className="banner info">{notice}</div>}
      {save.status.kind === 'conflict' && (
        <ConflictBanner
          onLoadLatest={() => applyRemote((save.status as Extract<SaveStatus, { kind: 'conflict' }>).server, 'Loaded the latest version.')}
          onKeepMine={() => save.overwrite(
            (save.status as Extract<SaveStatus, { kind: 'conflict' }>).server,
            { content: editor.getHTML(), ...(title.trim() ? { title: title.trim() } : {}) },
          )}
        />
      )}

      {canEdit && <Toolbar editor={editor} />}
      <div className="paper" onClick={() => !editor.isFocused && canEdit && editor.commands.focus()}>
        <EditorContent editor={editor} className="prose" />
      </div>

      {shareOpen && <ShareDialog doc={doc} onClose={() => setShareOpen(false)} />}
    </main>
  );
}

function SaveIndicator({ status, canEdit, onRetry }: { status: SaveStatus; canEdit: boolean; onRetry: () => void }) {
  if (!canEdit) return <span className="save-status muted">View only</span>;
  switch (status.kind) {
    case 'saved': return <span className="save-status muted">Saved {status.at ? timeAgo(status.at) : ''}</span>;
    case 'pending': return <span className="save-status muted">Unsaved changes…</span>;
    case 'saving': return <span className="save-status muted">Saving…</span>;
    case 'conflict': return <span className="save-status warn">Not saved — conflict</span>;
    case 'error': return (
      <span className="save-status error-text">
        Save failed: {status.message} <button className="link" onClick={onRetry}>Retry</button>
      </span>
    );
  }
}

function ConflictBanner({ onLoadLatest, onKeepMine }: { onLoadLatest: () => void; onKeepMine: () => void }) {
  return (
    <div className="banner warn" role="alert">
      <span>Someone else saved this document while you were editing. Your latest changes are not saved yet.</span>
      <span className="row">
        <button className="btn small" onClick={onLoadLatest}>Load their version</button>
        <button className="btn small primary" onClick={onKeepMine}>Keep mine (overwrite)</button>
      </span>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const block = editor.isActive('heading', { level: 1 }) ? 'h1'
    : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';

  const setBlock = (v: string) => {
    const chain = editor.chain().focus();
    if (v === 'p') chain.setParagraph().run();
    else chain.setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
  };

  const Btn = ({ label, title, active, onClick, disabled, className }: {
    label: React.ReactNode; title: string; active?: boolean; onClick: () => void; disabled?: boolean; className?: string;
  }) => (
    <button
      type="button" title={title} aria-label={title} aria-pressed={active}
      className={`tb-btn ${active ? 'active' : ''} ${className ?? ''}`}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
    >{label}</button>
  );

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Btn label="↶" title="Undo (⌘Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} />
      <Btn label="↷" title="Redo (⌘⇧Z)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} />
      <span className="tb-sep" />
      <select className="tb-select" value={block} onChange={(e) => setBlock(e.target.value)} aria-label="Text style">
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="tb-sep" />
      <Btn label={<b>B</b>} title="Bold (⌘B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn label={<i>I</i>} title="Italic (⌘I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn label={<u>U</u>} title="Underline (⌘U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <Btn label={<s>S</s>} title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <span className="tb-sep" />
      <Btn label="• List" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Btn label="1. List" title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <Btn label="❝" title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
      <Btn label="―" title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
    </div>
  );
}
