import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { Avatar, Icon, Logo } from './ui';

const BLURB: Record<string, string> = {
  'alice@ajaia.dev': 'Owns the welcome doc',
  'bob@ajaia.dev': 'Can edit Alice’s welcome doc',
  'carol@ajaia.dev': 'Nothing shared yet',
};

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [users, setUsers] = useState<User[] | null>(null);
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
      setBusy('');
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <header>
          <Logo />
          <h1>Welcome back</h1>
          <p className="muted">Choose a demo account to continue. To try sharing, sign in as a different user in a private window.</p>
        </header>
        <div className="user-pick">
          {users === null && !error && <div className="center" style={{ minHeight: 120 }}><Icon name="loader" /></div>}
          {users?.map((u) => (
            <button key={u.id} className="user-option" disabled={!!busy} onClick={() => signIn(u.email)}>
              <Avatar user={u} size={40} />
              <span className="who">
                <strong>{u.name}</strong>
                <span className="muted xsmall">{u.email}</span>
                <span className="blurb">{BLURB[u.email] ?? 'Demo user'}</span>
              </span>
              {busy === u.email ? <Icon name="loader" size={16} /> : <Icon name="arrowLeft" size={16} className="chev flip" />}
            </button>
          ))}
        </div>
        {error && <p className="alert" role="alert"><Icon name="alert" size={16} />{error}</p>}
        <p className="login-foot">Demo environment · no passwords required</p>
      </div>
    </div>
  );
}
