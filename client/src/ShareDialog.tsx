import { useEffect, useState } from 'react';
import { api, type Doc, type Share, type User } from './api';
import { Avatar, Icon } from './ui';

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
          <div style={{ minWidth: 0 }}>
            <h2 id="share-title">Share “{doc.title}”</h2>
            <p className="muted small">{isOwner ? 'Invite people and choose what they can do.' : 'Only the owner can change who has access.'}</p>
          </div>
          <button className="btn ghost small icon-only" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        {isOwner && (
          <>
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
            {suggestions.length > 0 && (
              <div className="suggestions">
                <span className="muted xsmall">Suggested:</span>
                {suggestions.map((u) => (
                  <button key={u.id} type="button" className="suggestion" onClick={() => setEmail(u.email)}>
                    <Avatar user={u} size={20} />{u.email}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {error && <p className="alert" role="alert"><Icon name="alert" size={16} />{error}</p>}

        <div>
          <h3 className="people-title">People with access</h3>
          <ul className="people">
            <li>
              <Avatar user={doc.owner} size={36} />
              <span className="person"><strong>{doc.owner.name}</strong><span>{doc.owner.email}</span></span>
              <span className="badge">Owner</span>
            </li>
            {shares?.map((s) => (
              <li key={s.id}>
                <Avatar user={s} size={36} />
                <span className="person"><strong>{s.name}</strong><span>{s.email}</span></span>
                {isOwner ? (
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    <select
                      value={s.role} disabled={busy} aria-label={`Access for ${s.name}`}
                      onChange={(e) => run(() => api.share(doc.id, s.email, e.target.value as 'editor' | 'viewer'))}
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                    <button className="btn ghost small icon-only danger-ghost" disabled={busy} title={`Remove ${s.name}`} aria-label="Remove" onClick={() => run(() => api.unshare(doc.id, s.id))}>
                      <Icon name="x" size={16} />
                    </button>
                  </span>
                ) : <span className={`badge ${s.role === 'editor' ? 'green' : 'gray'}`}>{s.role === 'editor' ? 'Can edit' : 'Can view'}</span>}
              </li>
            ))}
          </ul>
          {shares?.length === 0 && <p className="muted small" style={{ paddingTop: 4 }}>Not shared with anyone yet.</p>}
        </div>

        <div className="modal-foot">
          <Icon name="lock" size={14} />
          Editors can change content. Viewers can read and comment. Only the owner can share or delete.
        </div>
      </div>
    </div>
  );
}
