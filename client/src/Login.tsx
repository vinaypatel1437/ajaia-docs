import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { Avatar, Logo } from './ui';

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.users().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  }, []);

  const signIn = async (email: string) => {
    setBusy(email);
    setError('');
    try {
      onLogin((await api.login(email)).user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <Logo />
        <h1>Sign in</h1>
        <p className="muted">
          This demo uses seeded accounts instead of passwords. Pick a user; open a second browser
          (or a private window) as another user to try sharing.
        </p>
        <div className="user-pick">
          {users.map((u) => (
            <button key={u.id} className="user-option" disabled={!!busy} onClick={() => signIn(u.email)}>
              <Avatar user={u} size={36} />
              <span>
                <strong>{u.name}</strong>
                <span className="muted small">{u.email}</span>
              </span>
              {busy === u.email && <span className="muted small">Signing in…</span>}
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
