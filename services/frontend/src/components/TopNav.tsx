"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTH_CHANGED_EVENT } from '../lib/authEvents';
import { loadTokens } from '../lib/tokenStore';
import { logout } from '../lib/authApi';
import Button from './ui/Button';
import Badge from './ui/Badge';
import Avatar from './ui/Avatar';
import Toast, { type ToastItem } from './ui/Toast';
import { apiGetCached, invalidateApiGetCache } from '../lib/apiClient';
import { subscribeNotifyWebSocket } from '../lib/notifyWebSocketHub';
import { appPathFromDeepLink, normalizeNotification } from '../lib/notificationUi';
import ThemeToggle from './ThemeToggle';
import { useAppSession } from '../context/AppSessionContext';

type NavItem = { href: string; label: string; icon: 'feed' | 'creators' | 'live' | 'notifications' | 'wallet' | 'account' };

function NavIcon({ icon }: { icon: NavItem['icon'] }) {
  const cls = 'h-4 w-4';
  switch (icon) {
    case 'feed':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 9h8M8 13h8M8 17h5" />
        </svg>
      );
    case 'live':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M5 8a8 8 0 0 0 0 8M19 8a8 8 0 0 1 0 8" />
        </svg>
      );
    case 'creators':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
          <circle cx="9.5" cy="7" r="3" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 4.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'notifications':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <path d="M15 17H5l2-2v-4a5 5 0 1 1 10 0v4l2 2h-4Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'wallet':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M16 12h4" />
        </svg>
      );
    case 'account':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls} aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" />
        </svg>
      );
  }
}

export default function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isCreator, loading: sessionLoading } = useAppSession();
  const [hasToken, setHasToken] = useState(false);
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [unread, setUnread] = useState<number>(0);
  const [toast, setToast] = useState<ToastItem | null>(null);
  const suppressNotifyToastRef = useRef(false);

  useEffect(() => {
    function sync() {
      setHasToken(!!loadTokens()?.accessToken);
    }
    sync();
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, sync);
  }, []);

  const loggedIn = Boolean(user) || hasToken;
  const accountName = user?.displayName || user?.username || (isCreator ? 'Creator' : 'User');
  const accountInitial = accountName.trim().charAt(0).toUpperCase() || 'U';

  const primaryNav = useMemo((): NavItem[] => {
    if (!loggedIn) {
      return [
        { href: '/feed', label: 'Feed', icon: 'feed' },
        { href: '/creators', label: 'Creators', icon: 'creators' },
        { href: '/live', label: 'Live', icon: 'live' }
      ];
    }
    return [
      { href: '/feed', label: 'Feed', icon: 'feed' },
      { href: '/creators', label: 'Creators', icon: 'creators' },
      { href: '/live', label: 'Live', icon: 'live' },
      { href: '/notifications', label: 'Notifications', icon: 'notifications' },
      { href: '/wallet', label: 'Wallet', icon: 'wallet' },
      { href: '/me', label: 'Account', icon: 'account' }
    ];
  }, [loggedIn]);

  useEffect(() => {
    suppressNotifyToastRef.current = pathname.startsWith('/notifications');
  }, [pathname]);

  useEffect(() => {
    if (!open && !profileOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setProfileOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, profileOpen]);

  async function onLogout() {
    await logout();
    setUnread(0);
    invalidateApiGetCache('/notifications');
    router.replace('/login');
  }

  const navLinkClass = (href: string) =>
    `rounded-lg px-2 py-1 text-sm font-bold transition ${
      pathname === href || (href !== '/' && pathname.startsWith(href + '/'))
        ? 'text-text bg-surface2'
        : 'text-muted hover:text-text hover:bg-surface2/80'
    }`;

  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;

    async function loadUnreadBadge() {
      try {
        const list = await apiGetCached<{ notifications: Array<{ id: string; status: string }> }>(
          '/notifications?limit=50',
          5000
        );
        if (!cancelled) {
          const count = (list.notifications || []).filter((n) => n.status === 'unread').length;
          setUnread(count);
        }
      } catch {
        // ignore badge bootstrap failures
      }
    }

    loadUnreadBadge();
    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    return subscribeNotifyWebSocket({
      onMessage: (ev) => {
        try {
          const evt = JSON.parse(ev.data);
          if (evt?.eventType !== 'notification.created') return;
          setUnread((u) => u + 1);
          const raw = evt?.payload?.notification;
          const notif = normalizeNotification(raw);
          if (notif?.title && !suppressNotifyToastRef.current) {
            const path = appPathFromDeepLink(notif.deepLink);
            setToast({
              id: notif.id || crypto.randomUUID(),
              title: notif.title,
              body: notif.body || '',
              href: path || undefined,
              linkLabel: path ? 'View' : undefined
            });
          }
        } catch {
          // ignore
        }
      }
    });
  }, [loggedIn]);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[min(100%,88rem)] min-w-0 items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="shrink-0 text-text font-black tracking-tight">
          StripNoir
        </Link>

        <span className="hidden md:inline text-[10px] font-bold uppercase tracking-wider text-muted border border-border rounded-md px-1.5 py-0.5">
          {sessionLoading ? '…' : loggedIn ? (isCreator ? 'Creator' : 'Fan') : 'Guest'}
        </span>

        <nav className="hidden min-w-0 flex-1 flex-wrap items-center gap-1 md:flex" aria-label="Primary">
          {primaryNav.map((item) => (
            <Link key={item.href} href={item.href} className={navLinkClass(item.href)} aria-label={item.label} title={item.label}>
              <span className="inline-flex items-center gap-1">
                <NavIcon icon={item.icon} />
                <span className="sr-only">{item.label}</span>
                {item.href === '/notifications' && unread > 0 ? <Badge variant="warning">{unread}</Badge> : null}
              </span>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            className="shrink-0 rounded-xl border border-border bg-surface2 px-3 py-2 text-sm font-extrabold text-text md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            Menu
          </button>

          {!loggedIn ? (
            <>
              <Link href="/login" className={navLinkClass('/login')}>
                Login
              </Link>
              <Link href="/register" className={`${navLinkClass('/register')} hidden sm:inline`}>
                Sign up
              </Link>
            </>
          ) : (
            <div className="relative">
              <button
                type="button"
                className="relative inline-flex items-center justify-center rounded-full border border-border bg-surface2 p-1 text-text hover:bg-surface2/80"
                onClick={() => setProfileOpen((v) => !v)}
                aria-expanded={profileOpen}
                aria-haspopup="true"
                aria-controls="account-menu-dropdown"
                id="account-menu-button"
                aria-label={unread > 0 ? `Account menu, ${unread} unread notifications` : 'Account menu'}
                title="Account"
              >
                <Avatar name={user?.avatarUrl ? accountName : accountInitial} src={user?.avatarUrl || undefined} size={30} />
                {unread > 0 ? <span className="absolute -right-1 -top-1"><Badge variant="warning">{unread}</Badge></span> : null}
              </button>

              {profileOpen ? (
                <div
                  id="account-menu-dropdown"
                  role="region"
                  aria-label="Account menu"
                  className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-surface shadow-card p-2"
                >
                  <Link
                    href="/me"
                    className="block rounded-lg px-3 py-2 text-sm font-bold text-text hover:bg-surface2/80"
                    onClick={() => setProfileOpen(false)}
                  >
                    Profile
                  </Link>
                  {isCreator ? (
                    <Link
                      href="/creator"
                      className="block rounded-lg px-3 py-2 text-sm font-bold text-text hover:bg-surface2/80"
                      onClick={() => setProfileOpen(false)}
                    >
                      Creator studio
                    </Link>
                  ) : null}
                  <Link
                    href="/notifications"
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-bold text-text hover:bg-surface2/80"
                    onClick={() => setProfileOpen(false)}
                  >
                    <span>Notifications</span>
                    {unread > 0 ? <Badge variant="warning">{unread}</Badge> : null}
                  </Link>
                  <div className="my-1 h-px bg-border" />
                  <Button onClick={onLogout} variant="danger" size="sm" className="w-full">
                    Logout
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {open ? (
        <nav
          id="mobile-nav-menu"
          className="md:hidden border-t border-border bg-surface"
          aria-label="Mobile primary navigation"
        >
          <div className="mx-auto grid w-full max-w-[min(100%,88rem)] grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-2 sm:px-6 lg:px-8">
            {primaryNav.map((item) => (
              <Link key={item.href} href={item.href} className={navLinkClass(item.href)} onClick={() => setOpen(false)}>
                <span className="inline-flex items-center gap-2">
                  <NavIcon icon={item.icon} />
                  <span>{item.label}</span>
                  {item.href === '/notifications' && unread > 0 ? <Badge variant="warning">{unread}</Badge> : null}
                </span>
              </Link>
            ))}
            {!loggedIn ? (
              <Link href="/register" className={navLinkClass('/register')} onClick={() => setOpen(false)}>
                Sign up
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex justify-end">
          <Toast toast={toast} onDone={() => setToast(null)} />
        </div>
      ) : null}
    </header>
  );
}
