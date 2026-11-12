import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPTED_UPLOADS, api, timeAgo, type OwnedSummary, type SharedSummary, type User } from './api';
import { Avatar } from './ui';

const open = (id: string) => { window.location.hash = `#/doc/${id}`; };

export function Home({ user }: { user: User }) {
  const [docs, setDocs] = useState<{ owned: OwnedSummary[]; shared: SharedSummary[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'create' | 'import'>('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.listDocs().then(setDocs).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setBusy('create');
    try { open((await api.createDoc()).document.id); } catch (e) { setError((e as Error).message); setBusy(''); }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!/\.(txt|md|markdown|docx)$/i.test(file.name)) {
      setError(`"${file.name}" isn't supported. Upload a .txt, .md or .docx file.`);
      return;
    }
    if (file.size > 5 * 1024 * 1024) { setError('File is too large (max 5 MB).'); return; }
    setBusy('import');
    try { open((await api.importDoc(file)).document.id); } catch (e) { setError((e as Error).message); setBusy(''); }
  };

  const remove = async (doc: OwnedSummary) => {
    if (!confirm(`Delete "${doc.title}"? This also removes access for anyone it's shared with.`)) return;
    try { await api.deleteDoc(doc.id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <main
      className={`home ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); importFile(e.dataTransfer.files[0]); }}
    >
      <section className="home-actions">
        <div>
          <h1>Hi, {user.name.split(' ')[0]}</h1>
          <p className="muted">Start a blank document or import a file to keep working on it here.</p>
        </div>
        <div className="row">
          <button className="btn primary" onClick={create} disabled={!!busy}>
            {busy === 'create' ? 'Creating…' : '+ New document'}
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            {busy === 'import' ? 'Importing…' : 'Import file'}
          </button>
          <input
            ref={fileInput} type="file" accept={ACCEPTED_UPLOADS} hidden
            onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }}
          />
        </div>
      </section>
      <p className="muted small hint">
        Import supports <strong>.txt</strong>, <strong>.md</strong> and <strong>.docx</strong> (max 5 MB) and creates a new
        editable document. You can also drop a file anywhere on this page. Images and tables in .docx files are not imported.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {!docs ? <p className="muted">Loading documents…</p> : (
        <>
          <DocSection title="My documents" empty="You don't own any documents yet. Create one above.">
            {docs.owned.map((d) => (
              <li key={d.id} className="doc-row" onClick={() => open(d.id)}>
                <DocIcon />
                <div className="doc-meta">
                  <strong>{d.title}</strong>
                  <span className="muted small">Edited {timeAgo(d.updatedAt)}</span>
                </div>
                {d.shareCount > 0
                  ? <span className="badge">Shared · {d.shareCount}</span>
                  : <span className="badge subtle">Private</span>}
                <button
                  className="btn ghost small danger" aria-label={`Delete ${d.title}`}
                  onClick={(e) => { e.stopPropagation(); remove(d); }}
                >Delete</button>
              </li>
            ))}
          </DocSection>
          <DocSection title="Shared with me" empty="Nothing has been shared with you yet.">
            {docs.shared.map((d) => (
              <li key={d.id} className="doc-row" onClick={() => open(d.id)}>
                <DocIcon shared />
                <div className="doc-meta">
                  <strong>{d.title}</strong>
                  <span className="muted small">Edited {timeAgo(d.updatedAt)}</span>
                </div>
                <span className="owner-chip">
                  <Avatar user={{ name: d.ownerName, color: d.ownerColor }} size={20} />
                  <span className="small">{d.ownerName}</span>
                </span>
                <span className={`badge ${d.role === 'viewer' ? 'subtle' : ''}`}>{d.role === 'editor' ? 'Can edit' : 'View only'}</span>
              </li>
            ))}
          </DocSection>
        </>
      )}
    </main>
  );
}

function DocSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="doc-section">
      <h2>{title}</h2>
      {children.length ? <ul className="doc-list">{children}</ul> : <p className="muted empty">{empty}</p>}
    </section>
  );
}

function DocIcon({ shared }: { shared?: boolean }) {
  return (
    <svg className="doc-icon" width="20" height="24" viewBox="0 0 20 24" aria-hidden>
      <path d="M2 0h11l7 7v15a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z" fill={shared ? '#0ea5e9' : 'var(--accent)'} />
      <path d="M5 12h10M5 16h10M5 20h6" stroke="white" strokeWidth="1.6" />
    </svg>
  );
}
