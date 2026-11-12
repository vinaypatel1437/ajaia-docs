import { useState } from 'react';
import { api, timeAgo, type Comment, type Doc, type User } from './api';
import { Avatar, Icon } from './ui';

export function CommentsPanel({ doc, user, comments, setComments, selectedText, onClearSelection, onJump }: {
  doc: Doc; user: User; comments: Comment[] | null;
  setComments: (c: Comment[]) => void;
  selectedText: string;
  onClearSelection: () => void;
  onJump: (quote: string) => boolean;
}) {
  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const quote = selectedText.trim().slice(0, 500);

  const run = async (fn: () => Promise<{ comments: Comment[] }>) => {
    setBusy(true); setError('');
    try { setComments((await fn()).comments); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    if (await run(() => api.addComment(doc.id, body.trim(), quote || undefined))) { setBody(''); onClearSelection(); }
  };

  const open = (comments ?? []).filter((c) => !c.resolved);
  const resolved = (comments ?? []).filter((c) => c.resolved);
  const visible = showResolved ? [...open, ...resolved] : open;

  return (
    <>
      <form className="comment-form" onSubmit={submit}>
        {quote ? (
          <span className="quote" title={quote}>
            <span>“{quote}”</span>
            <button type="button" className="x" aria-label="Don’t attach selection" onClick={onClearSelection}><Icon name="x" size={14} /></button>
          </span>
        ) : <span className="side-note">Select text in the document to attach your comment to it.</span>}
        <textarea
          value={body} rows={3} maxLength={2000} placeholder="Add a comment…" aria-label="Comment"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}
        />
        <div className="comment-form-foot">
          <span className="kbd">⌘ + Enter to post</span>
          <button className="btn primary small" disabled={busy || !body.trim()}>Comment</button>
        </div>
      </form>
      {error && <p className="alert" role="alert"><Icon name="alert" size={16} />{error}</p>}

      {comments === null ? <div className="center" style={{ minHeight: 80 }}><Icon name="loader" /></div> : visible.length === 0 ? (
        <div className="empty">
          <Icon name="message" size={22} />
          {resolved.length ? 'All comments are resolved.' : 'No comments yet. Start the conversation.'}
        </div>
      ) : (
        <ul className="comment-list">
          {visible.map((c) => {
            const canResolve = doc.role !== 'viewer' || c.authorId === user.id;
            const canDelete = doc.role === 'owner' || c.authorId === user.id;
            return (
              <li key={c.id} className={`comment ${c.resolved ? 'resolved' : ''}`}>
                <div className="comment-head">
                  <Avatar user={{ name: c.authorName, color: c.authorColor }} size={24} />
                  <strong>{c.authorId === user.id ? 'You' : c.authorName}</strong>
                  <time dateTime={c.createdAt}>{timeAgo(c.createdAt)}</time>
                  {c.resolved && <span className="badge green"><Icon name="check" size={12} />Resolved</span>}
                </div>
                {c.quote && (
                  <button
                    type="button" className="quote" title="Show in document"
                    onClick={(e) => { if (!onJump(c.quote!)) (e.currentTarget as HTMLElement).style.textDecoration = 'line-through'; }}
                  ><span>“{c.quote}”</span></button>
                )}
                <p className="comment-body">{c.body}</p>
                {(canResolve || canDelete) && (
                  <div className="comment-actions">
                    {canResolve && (
                      <button className="text-btn accent" disabled={busy} onClick={() => run(() => api.resolveComment(doc.id, c.id, !c.resolved))}>
                        {c.resolved ? 'Reopen' : 'Resolve'}
                      </button>
                    )}
                    {canDelete && (
                      <button className="text-btn danger" disabled={busy} onClick={() => run(() => api.deleteComment(doc.id, c.id))}>Delete</button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {resolved.length > 0 && (
        <button className="text-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}
        </button>
      )}
    </>
  );
}
