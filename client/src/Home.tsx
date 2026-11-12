import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPTED_UPLOADS, api, timeAgo, type OwnedSummary, type SharedSummary, type User } from './api';
import { Avatar, ConfirmDialog, Icon } from './ui';

const open = (id: string) => { window.location.hash = `#/doc/${id}`; };
const MAX_BYTES = 5 * 1024 * 1024;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({ user }: { user: User }) {
  const [docs, setDocs] = useState<{ owned: OwnedSummary[]; shared: SharedSummary[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'create' | 'import'>('');
  const [dragging, setDragging] = useState(false);
  const [toDelete, setToDelete] = useState<OwnedSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

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
      setError(`“${file.name}” isn’t a supported file. Upload a .txt, .md or .docx file.`);
      return;
    }
    if (file.size > MAX_BYTES) { setError('That file is larger than 5 MB.'); return; }
    setBusy('import');
    try { open((await api.importDoc(file)).document.id); } catch (e) { setError((e as Error).message); setBusy(''); }
  };

  const confirmDelete = async () => {
    const doc = toDelete!;
    setToDelete(null);
    try { await api.deleteDoc(doc.id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <main
      className="home"
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); importFile(e.dataTransfer.files[0]); }}
    >
      <section className="home-hero">
        <div>
          <h1>{greeting()}, {user.name.split(' ')[0]}</h1>
          <p>Create a document, or import one and keep working on it here.</p>
        </div>
        <button className="btn primary" onClick={create} disabled={!!busy}>
          <Icon name={busy === 'create' ? 'loader' : 'plus'} size={16} /> New document
        </button>
      </section>

      <button
        type="button" className={`dropzone ${dragging ? 'active' : ''}`} disabled={!!busy}
        onClick={() => fileInput.current?.click()}
      >
        <span className="dropzone-icon"><Icon name={busy === 'import' ? 'loader' : 'upload'} size={20} /></span>
        <span>
          <strong>{busy === 'import' ? 'Importing…' : dragging ? 'Drop to import' : 'Import a file'}</strong>
          <p>Drag a file here or click to browse. It becomes a new editable document, with headings, lists, bold and italic kept. Max 5 MB. Images and tables are skipped.</p>
        </span>
        <span className="types">
          <span className="badge gray">.txt</span><span className="badge gray">.md</span><span className="badge gray">.docx</span>
        </span>
      </button>
      <input
        ref={fileInput} type="file" accept={ACCEPTED_UPLOADS} hidden
        onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      {error && <p className="alert" role="alert"><Icon name="alert" size={16} />{error}</p>}

      <DocSection title="My documents" count={docs?.owned.length} loading={!docs}
        empty={<><Icon name="file" size={22} />You don’t own any documents yet.<button className="text-btn accent" onClick={create}>Create your first document</button></>}>
        {docs?.owned.map((d) => (
          <li key={d.id} className="doc-row" tabIndex={0} onClick={() => open(d.id)} onKeyDown={(e) => e.key === 'Enter' && open(d.id)}>
            <span className="doc-thumb"><Icon name="file" size={18} /></span>
            <span className="doc-meta"><strong>{d.title}</strong><span>Edited {timeAgo(d.updatedAt)}</span></span>
            <span className="doc-col col-sharing">
              {d.shareCount > 0
                ? <><Icon name="users" size={15} /><span>Shared with {d.shareCount} {d.shareCount === 1 ? 'person' : 'people'}</span></>
                : <><Icon name="lock" size={15} /><span>Private</span></>}
            </span>
            <span><span className="badge">Owner</span></span>
            <button
              className="btn ghost small icon-only danger-ghost row-action" title="Delete document" aria-label={`Delete ${d.title}`}
              onClick={(e) => { e.stopPropagation(); setToDelete(d); }}
            ><Icon name="trash" size={16} /></button>
          </li>
        ))}
      </DocSection>

      <DocSection title="Shared with me" count={docs?.shared.length} loading={!docs}
        empty={<><Icon name="users" size={22} />Nothing has been shared with you yet.</>}>
        {docs?.shared.map((d) => (
          <li key={d.id} className="doc-row" tabIndex={0} onClick={() => open(d.id)} onKeyDown={(e) => e.key === 'Enter' && open(d.id)}>
            <span className="doc-thumb shared"><Icon name="file" size={18} /></span>
            <span className="doc-meta"><strong>{d.title}</strong><span>Edited {timeAgo(d.updatedAt)}</span></span>
            <span className="doc-col col-sharing">
              <Avatar user={{ name: d.ownerName, color: d.ownerColor }} size={20} /><span>{d.ownerName}</span>
            </span>
            <span><span className={`badge ${d.role === 'editor' ? 'green' : 'gray'}`}>{d.role === 'editor' ? 'Can edit' : 'Can view'}</span></span>
            <span />
          </li>
        ))}
      </DocSection>

      {toDelete && (
        <ConfirmDialog
          title="Delete document?"
          body={<>“{toDelete.title}” will be permanently deleted{toDelete.shareCount ? `, and the ${toDelete.shareCount} ${toDelete.shareCount === 1 ? 'person' : 'people'} it’s shared with will lose access` : ''}.</>}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </main>
  );
}

function DocSection({ title, count, loading, empty, children }: {
  title: string; count?: number; loading: boolean; empty: React.ReactNode; children?: React.ReactNode[];
}) {
  return (
    <section className="doc-section">
      <div className="section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="badge gray">{count}</span>}
      </div>
      {loading
        ? <ul className="doc-list" aria-busy><li className="skeleton" style={{ borderTop: 0 }} /><li className="skeleton" /></ul>
        : children?.length ? <ul className="doc-list">{children}</ul> : <div className="empty">{empty}</div>}
    </section>
  );
}
