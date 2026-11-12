export type Role = 'owner' | 'editor' | 'viewer';
export interface User { id: string; email: string; name: string; color: string }
export interface Doc {
  id: string; title: string; content: string; version: number;
  createdAt: string; updatedAt: string; owner: User; role: Role;
}
export interface OwnedSummary { id: string; title: string; updatedAt: string; shareCount: number }
export interface SharedSummary {
  id: string; title: string; updatedAt: string; role: 'viewer' | 'editor'; ownerName: string; ownerColor: string;
}
export interface Share extends User { role: 'viewer' | 'editor' }

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'Network error — check your connection', null);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export const api = {
  me: () => call<{ user: User | null }>('GET', '/api/me'),
  users: () => call<{ users: User[] }>('GET', '/api/users'),
  login: (email: string) => call<{ user: User }>('POST', '/api/auth/login', { email }),
  logout: () => call<void>('POST', '/api/auth/logout'),

  listDocs: () => call<{ owned: OwnedSummary[]; shared: SharedSummary[] }>('GET', '/api/documents'),
  createDoc: (title?: string) => call<{ document: Doc }>('POST', '/api/documents', title ? { title } : {}),
  getDoc: (id: string) => call<{ document: Doc }>('GET', `/api/documents/${id}`),
  updateDoc: (id: string, patch: { title?: string; content?: string; version: number }) =>
    call<{ document: Doc }>('PATCH', `/api/documents/${id}`, patch),
  deleteDoc: (id: string) => call<void>('DELETE', `/api/documents/${id}`),
  importDoc: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<{ document: Doc }>('POST', '/api/documents/import', form);
  },

  shares: (id: string) => call<{ shares: Share[] }>('GET', `/api/documents/${id}/shares`),
  share: (id: string, email: string, role: 'viewer' | 'editor') =>
    call<{ shares: Share[] }>('POST', `/api/documents/${id}/shares`, { email, role }),
  unshare: (id: string, userId: string) => call<{ shares: Share[] }>('DELETE', `/api/documents/${id}/shares/${userId}`),
};

export const ACCEPTED_UPLOADS = '.txt,.md,.markdown,.docx';

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
