import { useEffect, useState } from 'react';
import { api, type Doc, type Share, type User } from './api';
import { Avatar } from './ui';

export function ShareDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const isOwner = doc.role === 'owner';
  const [shares, setShares] = useState<Share[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.shares(doc.id).then((r) => setShares(r.shares)).catch((e) => setError(e.message));
    if (isOwner) api.users().then((r) => setUsers(r.users)).catch(() => {});
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc.id, isOwner, onClose]);

  const run = async (fn: () => Promise<{ shares: Share[] }>) => {
    setBusy(true);
    setError('');
    try { setShares((await fn()).shares); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (await run(() => api.share(doc.id, email.trim(), role))) setEmail('');
  };

  const suggestions = users.filter((u) => u.id !== doc.owner.id && !shares?.some((s) => s.id === u.id));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="modal-head">
          <h2 id="share-title">Share “{doc.title}”</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {isOwner ? (
          <form className="share-form" onSubmit={submit}>
            <input
              type="email" placeholder="Add people by email" value={email} list="share-users" autoFocus
              onChange={(e) => setEmail(e.target.value)} aria-label="Email to share with"
            />
            <datalist id="share-users">
              {suggestions.map((u) => <option key={u.id} value={u.email}>{u.name}</option>)}
            </datalist>
            <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} aria-label="Access level">
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
            <button className="btn primary" disabled={busy || !email.trim()}>Share</button>
          </form>
        ) : (
          <p className="muted small">Only the owner can change who has access.</p>
        )}
        {isOwner && suggestions.length > 0 && (
          <p className="muted small">Demo users: {suggestions.map((u) => (
            <button key={u.id} type="button" className="link" onClick={() => setEmail(u.email)}>{u.email}</button>
          )).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}</p>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        <h3 className="small muted">People with access</h3>
        <ul className="people">
          <li>
            <Avatar user={doc.owner} />
            <span className="person"><strong>{doc.owner.name}</strong><span className="muted small">{doc.owner.email}</span></span>
            <span className="muted small">Owner</span>
          </li>
          {shares?.map((s) => (
            <li key={s.id}>
              <Avatar user={s} />
              <span className="person"><strong>{s.name}</strong><span className="muted small">{s.email}</span></span>
              {isOwner ? (
                <span className="row">
                  <select
                    value={s.role} disabled={busy} aria-label={`Access for ${s.name}`}
                    onChange={(e) => run(() => api.share(doc.id, s.email, e.target.value as 'editor' | 'viewer'))}
                  >
                    <option value="editor">Can edit</option>
                    <option value="viewer">Can view</option>
                  </select>
                  <button className="btn ghost small danger" disabled={busy} onClick={() => run(() => api.unshare(doc.id, s.id))}>
                    Remove
                  </button>
                </span>
              ) : <span className="muted small">{s.role === 'editor' ? 'Can edit' : 'Can view'}</span>}
            </li>
          ))}
          {shares?.length === 0 && <li className="muted small">Not shared with anyone yet.</li>}
        </ul>
      </div>
    </div>
  );
}
