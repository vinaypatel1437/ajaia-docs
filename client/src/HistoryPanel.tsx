import type { Doc, VersionSummary } from './api';
import { Avatar, Icon } from './ui';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function HistoryPanel({ doc, versions, previewId, onPreview, error }: {
  doc: Doc; versions: VersionSummary[] | null; previewId: string | null;
  onPreview: (v: VersionSummary | null) => void; error: string;
}) {
  return (
    <>
      <p className="side-note">
        A version is saved when someone else starts editing, and every 5 minutes during editing. Restoring never deletes anything: the version it replaces stays in the list.
      </p>
      {error && <p className="alert" role="alert"><Icon name="alert" size={16} />{error}</p>}
      <ul className="version-list">
        <li>
          <button className={`version current ${previewId === null ? 'active' : ''}`} onClick={() => onPreview(null)}>
            <span className="bullet" />
            <strong>Current version</strong>
            <span className="by"><span>Last saved {fmt(doc.updatedAt)}</span></span>
          </button>
        </li>
        {versions === null && <li className="center" style={{ minHeight: 60 }}><Icon name="loader" /></li>}
        {versions?.map((v) => (
          <li key={v.id}>
            <button className={`version ${previewId === v.id ? 'active' : ''}`} onClick={() => onPreview(v)}>
              <span className="bullet" />
              <strong>{fmt(v.createdAt)}</strong>
              <span className="by">
                {v.authorName && <Avatar user={{ name: v.authorName, color: v.authorColor ?? '#98a2b3' }} size={16} />}
                <span>{v.authorName ?? 'Unknown'}{v.title !== doc.title ? ` · “${v.title}”` : ''}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {versions?.length === 0 && <div className="empty"><Icon name="history" size={22} />No earlier versions yet. They appear as the document is edited.</div>}
    </>
  );
}
