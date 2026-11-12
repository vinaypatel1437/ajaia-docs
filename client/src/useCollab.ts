import { useEffect, useRef, useState } from 'react';
import type { CollabEvent, PresenceUser } from './api';

const EDITING_WINDOW_MS = 4000;

/**
 * Subscribes to a document's Server-Sent Events stream: who's here, who's typing,
 * and notifications for saves, comments and access changes.
 */
export function useCollab(docId: string, selfId: string, handlers: {
  onSaved: (version: number, by: PresenceUser) => void;
  onComments: () => void;
  onAccess: () => void;
}) {
  const [present, setPresent] = useState<PresenceUser[]>([]);
  const [activeAt, setActiveAt] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [, setTick] = useState(0);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    const es = new EventSource(`/api/documents/${docId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource reconnects on its own
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as CollabEvent;
      switch (event.type) {
        case 'presence': setPresent(event.users); break;
        case 'activity':
          if (event.user.id !== selfId) setActiveAt((a) => ({ ...a, [event.user.id]: Date.now() }));
          break;
        case 'saved':
          if (event.by.id !== selfId) setActiveAt((a) => ({ ...a, [event.by.id]: Date.now() }));
          h.current.onSaved(event.version, event.by);
          break;
        case 'comments': h.current.onComments(); break;
        case 'access': h.current.onAccess(); break;
      }
    };
    // Re-render periodically so "editing" indicators fade out.
    const t = window.setInterval(() => setTick((n) => n + 1), 1500);
    return () => { es.close(); window.clearInterval(t); };
  }, [docId, selfId]);

  const others = present
    .filter((u) => u.id !== selfId)
    .map((u) => ({ ...u, editing: Date.now() - (activeAt[u.id] ?? 0) < EDITING_WINDOW_MS }));
  return { others, connected };
}
