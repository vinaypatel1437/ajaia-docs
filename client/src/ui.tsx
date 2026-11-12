import type { User } from './api';

export function Avatar({ user, size = 28 }: { user: Pick<User, 'name' | 'color'>; size?: number }) {
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <span className="avatar" title={user.name} style={{ background: user.color, width: size, height: size, fontSize: size * 0.4 }}>
      {initials}
    </span>
  );
}

export function Logo() {
  return (
    <a href="#/" className="logo">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="var(--accent)" />
        <path d="M10 8h8l5 5v11a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="white" />
      </svg>
      Ajaia Docs
    </a>
  );
}
