import type { UserRow } from './db.js';

/** Anything that can receive an event; in production an SSE response, in tests a stub. */
export interface Sink { send(event: HubEvent): void; close?(): void }

export type PresenceUser = Pick<UserRow, 'id' | 'name' | 'color'>;
export type HubEvent =
  | { type: 'presence'; users: PresenceUser[] }
  | { type: 'saved'; version: number; by: PresenceUser }
  | { type: 'activity'; user: PresenceUser }
  | { type: 'comments' }
  | { type: 'access' };

interface Connection { user: PresenceUser; sink: Sink }

/**
 * Per-document fan-out of collaboration events, kept in process memory.
 * Fine for a single instance; multiple instances would need Redis pub/sub or similar.
 */
export class Hub {
  private rooms = new Map<string, Set<Connection>>();

  join(docId: string, user: PresenceUser, sink: Sink): () => void {
    const conn: Connection = { user: { id: user.id, name: user.name, color: user.color }, sink };
    let room = this.rooms.get(docId);
    if (!room) this.rooms.set(docId, (room = new Set()));
    room.add(conn);
    this.publishPresence(docId);
    return () => {
      room!.delete(conn);
      if (room!.size === 0) this.rooms.delete(docId);
      else this.publishPresence(docId);
    };
  }

  /** Unique users currently connected to a document (one user may have several tabs). */
  presence(docId: string): PresenceUser[] {
    const seen = new Map<string, PresenceUser>();
    for (const c of this.rooms.get(docId) ?? []) seen.set(c.user.id, c.user);
    return [...seen.values()];
  }

  publish(docId: string, event: HubEvent) {
    for (const c of this.rooms.get(docId) ?? []) {
      try { c.sink.send(event); } catch { /* a dead connection is cleaned up on close */ }
    }
  }

  /** Disconnect a user from a document's stream (e.g. after their access is revoked). */
  kick(docId: string, userId: string) {
    for (const c of [...(this.rooms.get(docId) ?? [])]) if (c.user.id === userId) c.sink.close?.();
  }

  private publishPresence(docId: string) {
    this.publish(docId, { type: 'presence', users: this.presence(docId) });
  }
}
