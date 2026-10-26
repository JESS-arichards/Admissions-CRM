import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ index: 0, menu: true, mobile: false, scrolled: false, collapsed: false, setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: vi.fn(),
  useId: () => 'navigation',
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = state.index++;
    const setter = vi.fn();
    state.setters[index] = setter;
    return [index === 0 ? state.mobile : index === 1 ? state.menu : index === 2 ? state.scrolled : index === 5 ? state.collapsed : initial, setter];
  },
}));
vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => createElement('a', { href: to, ...props }, children),
}));
import { NavigationBar, type NavigationBarProps } from './NavigationBar';

const defaults: NavigationBarProps = {
  appName: 'Test app', brand: createElement('img', { src: '/logo.svg', alt: '' }),
  user: { displayName: 'Test User', email: 'user@example.org', roles: ['Staff'] },
  navigation: createElement('li', null, createElement('a', { href: '/lessons' }, 'Lessons')),
  mobileNavigation: createElement('a', { href: '/lessons' }, 'Lessons'),
  profileUrl: '/profile', signOut: async () => {},
};

function find(root: ReactNode, predicate: (props: Record<string, unknown>) => boolean): ReactNode {
  for (const child of Children.toArray(root)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child.props)) return child;
    const found = find(child.props.children as ReactNode, predicate);
    if (found) return found;
  }
  return null;
}

beforeEach(() => { state.index = 0; state.menu = true; state.mobile = false; state.scrolled = false; state.collapsed = false; state.setters = []; });

describe('shared navigation', () => {
  it('enables the navigation shield after scrolling or opening mobile navigation', () => {
    expect(NavigationBar(defaults).props.className).not.toContain('is-scrolled');
    state.index = 0;
    state.scrolled = true;
    expect(NavigationBar(defaults).props.className).toContain('is-scrolled');
    state.index = 0;
    state.scrolled = false;
    state.mobile = true;
    expect(NavigationBar(defaults).props.className).toContain('is-scrolled');
  });
  it('opts into a desktop sidebar without duplicating links across the top', () => {
    const tree = NavigationBar({ ...defaults, desktopSidebar: true });
    const sidebar = renderToStaticMarkup(find(tree, (props) => props.className === 'jess-nav-sidebar'));
    const header = renderToStaticMarkup(find(tree, (props) => props.className === 'jess-nav-bar'));
    expect(sidebar).toContain('aria-label="Applications"');
    expect(sidebar).toContain('href="/lessons"');
    expect(sidebar).toContain('aria-label="Collapse sidebar"');
    expect(sidebar).toContain('aria-expanded="true"');
    expect(header).not.toContain('href="/lessons"');
    expect(header).toContain('Application information');
    expect(header).toContain('Account manager for Test User');
    expect(header).toContain('Settings and more');
    expect(renderToStaticMarkup(tree)).toContain('jess-navigation--sidebar');
  });
  it('collapses to an accessible icon rail and can expand again', () => {
    const tree = NavigationBar({ ...defaults, desktopSidebar: true });
    const toggle = find(tree, (props) => props['aria-label'] === 'Collapse sidebar');
    if (!isValidElement<{ onClick: () => void }>(toggle)) throw new Error('Missing sidebar toggle');
    toggle.props.onClick();
    const updater = state.setters[5]!.mock.calls[0][0] as (value: boolean) => boolean;
    expect(updater(false)).toBe(true);
    expect(updater(true)).toBe(false);
    state.index = 0;
    state.collapsed = true;
    const collapsed = renderToStaticMarkup(createElement(NavigationBar, { ...defaults, desktopSidebar: true }));
    expect(collapsed).toContain('is-sidebar-collapsed');
    expect(collapsed).toContain('aria-label="Expand sidebar"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('href="/lessons"');
  });
  it('leaves the complete mobile panel unchanged in sidebar mode', () => {
    state.mobile = true; state.menu = false;
    const original = renderToStaticMarkup(find(NavigationBar(defaults), (props) => props.className === 'jess-nav-mobile'));
    state.index = 0;
    state.collapsed = true;
    const sidebarMode = renderToStaticMarkup(find(NavigationBar({ ...defaults, desktopSidebar: true }), (props) => props.className === 'jess-nav-mobile'));
    expect(sidebarMode).toBe(original);
  });
  it('preserves horizontal navigation for applications that do not opt into the sidebar', () => {
    const tree = NavigationBar(defaults);
    expect(find(tree, (props) => props.className === 'jess-nav-sidebar')).toBeNull();
    expect(renderToStaticMarkup(find(tree, (props) => props.className === 'jess-nav-links'))).toContain('href="/lessons"');
  });
  it('orders info, avatar and three dots and keeps account links out of application navigation', () => {
    const html = renderToStaticMarkup(createElement(NavigationBar, { ...defaults, adminUrl: '/admin' }));
    expect(html.indexOf('aria-label="Application information"')).toBeLessThan(html.indexOf('aria-label="Account manager for'));
    expect(html.indexOf('aria-label="Account manager for')).toBeLessThan(html.indexOf('aria-label="Settings and more"'));
    const account = html.slice(html.indexOf('role="menu"'));
    expect(account.indexOf('My Profile')).toBeLessThan(account.indexOf('> Admin'));
    expect(account.indexOf('> Admin')).toBeLessThan(account.indexOf('Sign out'));
    expect(html.match(/href="\/admin"/g)).toHaveLength(1);
  });

  it('uses a full-page cross-application link for the Portal profile', () => {
    const html = renderToStaticMarkup(createElement(NavigationBar, { ...defaults, profileUrl: 'https://portal.example.org/profile' }));
    expect(html).toContain('href="https://portal.example.org/profile" role="menuitem"');
    expect(html).not.toContain('href="/admin"');
  });

  it('makes missing Portal configuration explicit instead of linking to a nonexistent profile', () => {
    const html = renderToStaticMarkup(createElement(NavigationBar, { ...defaults, profileUrl: null }));
    expect(html).toContain('APPLICATIONS_PORTAL_URL is not configured');
    expect(html).toContain('role="menuitem" disabled=""');
    expect(html).not.toContain('href="/profile"');
  });

  it('puts the user and all account links inside the single mobile navigation panel', () => {
    state.mobile = true;
    state.menu = false;
    const tree = NavigationBar({
      ...defaults, adminUrl: '/admin',
      accountItems: createElement('a', { href: '/parking?release=1', role: 'menuitem' }, 'Parking Release'),
    });
    const panel = find(tree, (props) => props.className === 'jess-nav-mobile');
    const html = renderToStaticMarkup(panel);
    expect(html).toContain('Test User');
    expect(html).toContain('user@example.org');
    expect(html).toContain('jess-nav-mobile-user');
    expect(html.indexOf('Test User')).toBeLessThan(html.indexOf('Lessons'));
    expect(html.indexOf('Lessons')).toBeLessThan(html.indexOf('Parking Release'));
    expect(html.indexOf('Parking Release')).toBeLessThan(html.indexOf('My Profile'));
    expect(html.indexOf('My Profile')).toBeLessThan(html.indexOf('> Admin'));
    expect(html.indexOf('> Admin')).toBeLessThan(html.indexOf('Sign out'));
    expect(html).not.toContain('Settings and more');
    expect(html).not.toContain('Account manager');
  });

  it('uses the Portal URL inside the mobile menu too', () => {
    state.mobile = true; state.menu = false;
    const tree = NavigationBar({ ...defaults, profileUrl: 'https://portal.example.org/profile' });
    const html = renderToStaticMarkup(find(tree, (props) => props.className === 'jess-nav-mobile'));
    expect(html).toContain('href="https://portal.example.org/profile" role="menuitem"');
  });

  it('does not render account controls for anonymous visitors', () => {
    const html = renderToStaticMarkup(createElement(NavigationBar, { ...defaults, user: undefined }));
    expect(html).not.toContain('Settings and more');
    expect(html).not.toContain('My Profile');
    expect(html).not.toContain('Sign out');
    expect(html).toContain('Lessons');
  });

  it('reports sign-out failures and prevents simultaneous sign-out requests', async () => {
    let reject: (error: Error) => void = () => {};
    const signOut = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const tree = NavigationBar({ ...defaults, signOut });
    const button = find(tree, (props) => props.role === 'menuitem' && typeof props.onClick === 'function');
    if (!isValidElement<{ onClick: () => void }>(button)) throw new Error('Missing sign out');
    button.props.onClick();
    button.props.onClick();
    expect(signOut).toHaveBeenCalledTimes(1);
    reject(new Error('Network unavailable'));
    await vi.waitFor(() => expect(state.setters[4]).toHaveBeenCalledWith('Sign out could not be completed: Network unavailable'));
    expect(state.setters[3]).toHaveBeenLastCalledWith(false);
  });
});
