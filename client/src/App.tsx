import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { Login } from './Login';
import { Home } from './Home';
import { EditorPage } from './EditorPage';
import { Avatar, Icon, Logo } from './ui';

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = hash.match(/^#\/doc\/([\w-]+)/);
  return match ? { page: 'doc' as const, id: match[1] } : { page: 'home' as const };
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useHashRoute();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted"><Icon name="loader" size={22} /></div>;
  if (!user) return <Login onLogin={setUser} />;

  const signOut = async () => {
    await api.logout().catch(() => {});
    window.location.hash = '#/';
    setUser(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <div className="user-chip">
          <span className="who hide-sm"><strong>{user.name}</strong><span>{user.email}</span></span>
          <Avatar user={user} size={32} />
          <button className="btn ghost small" onClick={signOut} title="Sign out and pick another demo user">
            <Icon name="logout" size={16} /><span className="hide-sm">Switch user</span>
          </button>
        </div>
      </header>
      {route.page === 'doc'
        ? <EditorPage key={`${route.id}:${user.id}`} id={route.id} user={user} />
        : <Home key={user.id} user={user} />}
    </div>
  );
}
