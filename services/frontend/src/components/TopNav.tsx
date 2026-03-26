"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTH_CHANGED_EVENT } from '../lib/authEvents';
import { loadTokens } from '../lib/tokenStore';
import { logout } from '../lib/authApi';
import Button from './ui/Button';
import Badge from './ui/Badge';
import Toast, { type ToastItem } from './ui/Toast';
import { apiGetCached, invalidateApiGetCache } from '../lib/apiClient';
import { subscribeNotifyWebSocket } from '../lib/notifyWebSocketHub';
import { appPathFromDeepLink, normalizeNotification } from '../lib/notificationUi';
import ThemeToggle from './ThemeToggle';
import { useAppSession } from '../context/AppSessionContext';

type NavItem = { href: string; label: string };

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

  const primaryNav = useMemo((): NavItem[] => {
    if (!loggedIn) {
      return [
        { href: '/feed/creators', label: 'Explore' },
        { href: '/feed/trending', label: 'Trending' },
        { href: '/live', label: 'Live' }
      ];
    }
    if (isCreator) {
      return [
        { href: '/creator', label: 'Studio' },
        { href: '/feed/creators', label: 'Discover' },
        { href: '/live', label: 'Live' },
        { href: '/calls', label: 'Calls' },
        { href: '/chat/rooms', label: 'Chat' },
        { href: '/notifications', label: 'Alerts' },
        { href: '/wallet', label: 'Wallet' }
      ];
    }
    return [
      { href: '/feed/creators', label: 'Feed' },
      { href: '/feed/following', label: 'Following' },
      { href: '/feed/trending', label: 'Trending' },
      { href: '/live', label: 'Live' },
      { href: '/calls', label: 'Calls' },
      { href: '/chat/rooms', label: 'Chat' },
      { href: '/notifications', label: 'Alerts' },
      { href: '/wallet', label: 'Wallet' }
    ];
  }, [loggedIn, isCreator]);

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
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/" className="text-text font-black tracking-tight">
          StripNoir
        </Link>

        <span className="hidden md:inline text-[10px] font-bold uppercase tracking-wider text-muted border border-border rounded-md px-1.5 py-0.5">
          {sessionLoading ? '…' : loggedIn ? (isCreator ? 'Creator' : 'Fan') : 'Guest'}
        </span>

        <nav className="hidden md:flex flex-1 flex-wrap items-center gap-1" aria-label="Primary">
          {primaryNav.map((item) => (
            <Link key={item.href} href={item.href} className={navLinkClass(item.href)}>
              {item.label}
            </Link>
          ))}
          {loggedIn ? (
            <Link href="/me" className={navLinkClass('/me')}>
              Profile
            </Link>
          ) : null}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            className="md:hidden rounded-xl border border-border bg-surface2 px-3 py-2 text-sm font-extrabold text-text"
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
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface2 px-3 py-2 text-sm font-extrabold text-text hover:bg-surface2/80"
                onClick={() => setProfileOpen((v) => !v)}
                aria-expanded={profileOpen}
                aria-haspopup="true"
                aria-controls="account-menu-dropdown"
                id="account-menu-button"
                aria-label={unread > 0 ? `Account menu, ${unread} unread notifications` : 'Account menu'}
              >
                Account
                {unread > 0 ? <Badge variant="warning">{unread}</Badge> : null}
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
          <div className="mx-auto max-w-6xl px-4 py-3 grid grid-cols-2 gap-2">
            {primaryNav.map((item) => (
              <Link key={item.href} href={item.href} className={navLinkClass(item.href)} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ))}
            {loggedIn ? (
              <Link href="/me" className={navLinkClass('/me')} onClick={() => setOpen(false)}>
                Profile
              </Link>
            ) : (
              <Link href="/register" className={navLinkClass('/register')} onClick={() => setOpen(false)}>
                Sign up
              </Link>
            )}
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
