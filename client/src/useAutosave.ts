import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Doc } from './api';

export type SaveStatus =
  | { kind: 'saved'; at: string }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; server: Doc };

type Patch = { title?: string; content?: string };
const DEBOUNCE_MS = 700;

/**
 * Serialised, debounced saving. Edits are merged into one pending patch; at most one
 * request is in flight; the document version travels with every save so the server
 * can reject writes based on stale content (409 → conflict state, nothing is lost).
 */
export function useAutosave(doc: Doc | null, onSaved: (d: Doc) => void) {
  const [status, setStatusState] = useState<SaveStatus>({ kind: 'saved', at: doc?.updatedAt ?? '' });
  const statusRef = useRef(status);
  const setStatus = (s: SaveStatus) => { statusRef.current = s; setStatusState(s); };
  const version = useRef(doc?.version ?? 0);
  const pending = useRef<Patch>({});
  const inFlight = useRef(false);
  const timer = useRef<number>();
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (doc) { version.current = doc.version; setStatus({ kind: 'saved', at: doc.updatedAt }); }
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusKind = () => statusRef.current.kind;

  const docId = doc?.id;
  const hasPending = () => Object.keys(pending.current).length > 0;

  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (!docId || inFlight.current || !hasPending()) return;
    const patch = pending.current;
    pending.current = {};
    inFlight.current = true;
    setStatus({ kind: 'saving' });
    try {
      const { document } = await api.updateDoc(docId, { ...patch, version: version.current });
      version.current = document.version;
      onSavedRef.current(document);
      inFlight.current = false;
      if (hasPending()) return flush();
      setStatus({ kind: 'saved', at: document.updatedAt });
    } catch (e) {
      inFlight.current = false;
      pending.current = { ...patch, ...pending.current }; // keep the user's edits
      if (e instanceof ApiError && e.status === 409 && e.body?.document) {
        setStatus({ kind: 'conflict', server: e.body.document });
      } else {
        setStatus({ kind: 'error', message: (e as Error).message });
      }
    }
  }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const queue = useCallback((patch: Patch) => {
    pending.current = { ...pending.current, ...patch };
    // While in conflict, keep collecting edits but don't save; the user has to choose.
    if (statusRef.current.kind === 'conflict') return;
    if (!inFlight.current) setStatus({ kind: 'pending' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
  }, [flush]);

  /** Resolve a conflict by writing our version on top of the server's latest. */
  const overwrite = useCallback((server: Doc, latest: Patch) => {
    version.current = server.version;
    pending.current = { ...latest };
    return flush();
  }, [flush]);

  /** Resolve a conflict (or adopt a remote change) by discarding local edits. */
  const adopt = useCallback((server: Doc) => {
    pending.current = {};
    version.current = server.version;
    setStatus({ kind: 'saved', at: server.updatedAt });
  }, []);

  const isDirty = () => hasPending() || inFlight.current;

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (isDirty()) { void flush(); e.preventDefault(); } };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); void flush(); };
  }, [flush]); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, statusKind, queue, flush, overwrite, adopt, isDirty, version };
}
