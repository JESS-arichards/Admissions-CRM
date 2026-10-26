import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Info, LogOut, Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, ShieldCheck, UserRound, X } from 'lucide-react';
import './navigation.css';

export interface NavigationUser {
  displayName: string;
  email: string;
  roles?: readonly string[];
}

export interface NavigationBarProps {
  appName: string;
  brand: ReactNode;
  navigation: ReactNode;
  mobileNavigation: ReactNode;
  desktopSidebar?: boolean;
  actions?: ReactNode;
  mobileActions?: ReactNode;
  user?: NavigationUser;
  avatar?: ReactNode;
  support?: ReactNode;
  profileUrl?: string | null;
  adminUrl?: string;
  accountItems?: ReactNode;
  signOut?: () => Promise<void>;
}

function ProfileLink({ url }: { url: string }) {
  return url.startsWith('/') && !url.startsWith('//')
    ? <Link to={url} role="menuitem"><UserRound size={18} /> My Profile</Link>
    : <a href={url} role="menuitem"><UserRound size={18} /> My Profile</a>;
}

export function NavigationAvatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return <span className="jess-nav-avatar" aria-hidden="true">{initials}</span>;
}

function ApplicationInfo({ appName, user }: { appName: string; user?: NavigationUser }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  return (
    <>
      <button type="button" className="jess-nav-icon" aria-label="Application information" title="Application information" onClick={() => setOpen(true)}>
        <Info size={20} />
      </button>
      {open && (
        <dialog ref={dialog} className="jess-nav-info" aria-label="Application information" onClose={() => setOpen(false)}>
          <button type="button" className="jess-nav-icon" aria-label="Close information" onClick={() => dialog.current?.close()}><X size={20} /></button>
          <h2>{appName}</h2>
          <p>{window.location.origin}</p>
          {user && <><p>{user.displayName}<br />{user.email}</p><p>Roles: {user.roles?.join(', ') || 'None'}</p></>}
          <p>{navigator.userAgent}</p>
          <p>Account details are personal information. Share only with trusted support staff.</p>
        </dialog>
      )}
    </>
  );
}

export function NavigationBar({
  appName, brand, navigation, mobileNavigation, actions, mobileActions, user, avatar, support,
  profileUrl, adminUrl, accountItems, signOut,
  desktopSidebar = false,
}: NavigationBarProps) {
  const location = useLocation();
  const id = useId();
  const menuId = `${id}-account`;
  const mobileId = `${id}-navigation`;
  const sidebarId = `${id}-sidebar`;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const logoutPending = useRef(false);

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [location.pathname, location.search, user?.email]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen && !mobileOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!account.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) {
        setMenuOpen(false);
        trigger.current?.focus();
      } else {
        setMobileOpen(false);
        mobileTrigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, mobileOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const entries = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
    entries?.forEach((entry) => { entry.tabIndex = -1; });
    entries?.[0]?.focus();
  }, [menuOpen]);

  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    if (!entries.length) return;
    const index = entries.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % entries.length; break;
      case 'ArrowUp': next = (index - 1 + entries.length) % entries.length; break;
      case 'Home': next = 0; break;
      case 'End': next = entries.length - 1; break;
      default: return;
    }
    event.preventDefault();
    entries[next]?.focus();
  };

  const logout = async () => {
    if (!signOut || logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await signOut();
      setMenuOpen(false);
      setMobileOpen(false);
    } catch (error) {
      setLogoutError(`Sign out could not be completed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      logoutPending.current = false;
      setLoggingOut(false);
    }
  };

  const profileLink = profileUrl ? <ProfileLink url={profileUrl} /> : <><button type="button" role="menuitem" disabled><UserRound size={18} /> My Profile</button><p role="status">My Profile unavailable: APPLICATIONS_PORTAL_URL is not configured.</p></>;
  const accountLinks = (
    <>
      {adminUrl && <Link to={adminUrl} role="menuitem"><ShieldCheck size={18} /> Admin</Link>}
      {signOut && <button type="button" role="menuitem" disabled={loggingOut} onClick={() => void logout()}><LogOut size={18} />{loggingOut ? 'Signing out...' : 'Sign out'}</button>}
      {logoutError && <p role="alert">{logoutError}</p>}
    </>
  );

  return (
    <header className={`jess-navigation${scrolled || mobileOpen ? ' is-scrolled' : ''}${desktopSidebar ? ' jess-navigation--sidebar' : ''}${desktopSidebar && sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <nav className="jess-nav-bar" aria-label="Main">
        <Link to="/" className="jess-nav-brand" aria-label={`${appName} home`} onClick={() => { setMobileOpen(false); setMenuOpen(false); }}>
          {brand}<span>{appName}</span>
        </Link>
        {!desktopSidebar && <ul className="jess-nav-links">{navigation}</ul>}
        <div className="jess-nav-actions">{actions}</div>
        <div className="jess-nav-controls">
          {support ?? <ApplicationInfo appName={appName} user={user} />}
          {user && (
            <div className="jess-nav-account" ref={account} onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
            }}>
              <button type="button" className="jess-nav-avatar-link" aria-label={`Account manager for ${user.displayName}`}
                title={user.displayName} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId}
                onClick={() => { setMobileOpen(false); setMenuOpen((value) => !value); }}>
                {avatar ?? <NavigationAvatar name={user.displayName} />}
              </button>
              <button ref={trigger} type="button" className="jess-nav-icon" aria-label="Settings and more" title="Settings and more"
                aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId}
                onClick={() => { setMobileOpen(false); setMenuOpen((value) => !value); }}
                onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true); } }}>
                <MoreHorizontal size={20} />
              </button>
              {menuOpen && (
                <div id={menuId} ref={menu} className="jess-nav-dropdown" role="menu" aria-label="Account" onKeyDown={menuKeys}>
                  <div className="jess-nav-account-heading" role="presentation"><strong>{user.displayName}</strong><span>{user.email}</span></div>
                  {profileLink}
                  {accountItems}
                  {accountLinks}
                </div>
              )}
            </div>
          )}
          <button ref={mobileTrigger} type="button" className="jess-nav-icon jess-nav-toggle" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileOpen} aria-controls={mobileId} onClick={() => { setMenuOpen(false); setMobileOpen((value) => !value); }}>
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </nav>
      {desktopSidebar && (
        <nav className="jess-nav-sidebar" aria-label="Applications">
          <div className="jess-nav-sidebar-heading">
            <span className="jess-nav-sidebar-title">Applications</span>
            <button type="button" className="jess-nav-icon" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed}
              aria-controls={sidebarId} onClick={() => setSidebarCollapsed((value) => !value)}>
              {sidebarCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
          </div>
          <ul id={sidebarId} className="jess-nav-sidebar-links">{navigation}</ul>
        </nav>
      )}
      {mobileOpen && (
        <>
          <button type="button" className="jess-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <nav id={mobileId} className="jess-nav-mobile" aria-label="Application" onClick={(event) => {
            if ((event.target as Element).closest('a')) setMobileOpen(false);
          }}>
            {user && (
              <div className="jess-nav-mobile-user">
                {avatar ?? <NavigationAvatar name={user.displayName} />}
                <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
              </div>
            )}
            {mobileNavigation}{mobileActions}
            {user && (
              <div className="jess-nav-mobile-account" role="menu" aria-label="Account" onKeyDown={menuKeys}>
                {accountItems}
                {profileLink}
                {accountLinks}
              </div>
            )}
          </nav>
        </>
      )}
    </header>
  );
}
