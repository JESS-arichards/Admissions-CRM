import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router';
import type { Brand, CentralUser, Page, PublicConfig } from '../../shared/contracts';
import { canAdminister } from '../../shared/contracts';
import { api, ApiError, errorMessage } from './api';
import { clearLogin, login } from './auth';
import { accessibleBrandAccent, readableTextColor } from './branding/colorTokens';
import { NavigationBar } from './navigation/NavigationBar';
import { ConfirmEmail, Information, RequestForm, TrackRequest } from './Public';
import { ContentAdmin, Pipeline, RequestEditor } from './Staff';

export function Alert({ message }: { message: string }) {
  return <div className="alert" role="alert">{message}</div>;
}
export function App() {
  const [data, setData] = useState<{ brand: Brand; config: PublicConfig; pages: Page[] } | null>(null);
  const [user, setUser] = useState<CentralUser | null>(null);
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [trackingCode, setTrackingCode] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [brand, config, pages] = await Promise.all([
        api<Brand>('/api/branding'), api<PublicConfig>('/api/config'), api<Page[]>('/api/pages'),
      ]);
      setData({ brand, config, pages });
    } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<CentralUser>('/api/auth/me').then(setUser).catch((err: unknown) => {
      if (!(err instanceof ApiError && err.status === 401)) setAuthError(errorMessage(err));
    });
  }, []);
  useEffect(() => {
    if (!data) return;
    const brand = data.brand;
    const style = document.documentElement.style;
    style.setProperty('--brand', brand.primaryColor);
    style.setProperty('--brand-foreground', readableTextColor(brand.primaryColor));
    style.setProperty('--brand-accent', accessibleBrandAccent(brand.accentColor || brand.primaryColor));
    style.setProperty('--app-bg-color', brand.backgroundColor || brand.primaryColor);
    style.setProperty('--app-bg-image', brand.backgroundUrl ? `url("${brand.backgroundUrl}")` : 'none');
    style.setProperty('--branding-text', brand.textColor || '#f4f7fc');
    document.title = `${brand.organisationName} Admissions`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', brand.primaryColor);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = brand.iconUrl || 'data:,';
  }, [data]);
  const signIn = async () => {
    if (!data) return;
    setSigningIn(true); setAuthError('');
    try {
      const idToken = await login(data.config);
      setUser(await api<CentralUser>('/api/auth/session', 'POST', { idToken }));
    } catch (err) { setAuthError(errorMessage(err)); }
    finally { setSigningIn(false); }
  };
  const signOut = async () => {
    await api('/api/auth/logout', 'POST', {});
    setUser(null);
    await clearLogin();
  };
  if (!data) return <main className="container"><h1>Admissions</h1>{error
    ? <><Alert message={error} /><button onClick={() => void load()}>Try again</button></> : <p role="status">Loading Admissions...</p>}</main>;
  const nav = <>
    <li><NavLink to="/" end>Discover</NavLink></li>
    {data.pages.filter((page) => ['admissions', 'visits'].includes(page.slug)).map((page) =>
      <li key={page.slug}><NavLink to={`/information/${page.slug}`}>{page.slug === 'visits' ? 'Visit us' : 'Admissions'}</NavLink></li>)}
    <li><NavLink to="/track">Track a request</NavLink></li>
    {user && <li><NavLink to="/staff">Staff pipeline</NavLink></li>}
  </>;
  const staffAccess = user ? null : <section className="panel narrow"><p className="eyebrow">Staff access</p><h1>Admissions workspace</h1>
    <p>Sign in with your school Microsoft account. Access is managed in the Applications Portal.</p>
    {authError && <Alert message={authError} />}
    <button className="primary" disabled={signingIn} onClick={() => void signIn()}>{signingIn ? 'Signing in...' : 'Sign in with Microsoft'}</button></section>;
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <NavigationBar appName="Admissions" brand={data.brand.logoUrl ? <img src={data.brand.logoUrl} alt={data.brand.organisationName} /> : <strong>{data.brand.organisationName}</strong>}
      navigation={nav} mobileNavigation={<ul className="mobile-links">{nav}</ul>} user={user ?? undefined} profileUrl={data.config.profileUrl}
      adminUrl={user && canAdminister(user) ? '/staff/content' : undefined} signOut={user ? signOut : undefined}
      actions={<Link className="button primary" to="/request">Make a request</Link>}
      mobileActions={<Link className="button primary" to="/request">Make a request</Link>} />
    <main id="main" className="container">
      {error && <Alert message={error} />}
      <Routes>
        <Route path="/" element={<Information pages={data.pages} brand={data.brand} home />} />
        <Route path="/information/:slug" element={<Information pages={data.pages} brand={data.brand} />} />
        <Route path="/request" element={<RequestForm emailEnabled={data.config.emailEnabled} onCode={setTrackingCode} />} />
        <Route path="/track" element={<TrackRequest code={trackingCode} setCode={setTrackingCode} emailEnabled={data.config.emailEnabled} />} />
        <Route path="/confirm" element={<ConfirmEmail />} />
        <Route path="/staff" element={staffAccess ?? <Pipeline user={user!} />} />
        <Route path="/staff/requests/:id" element={staffAccess ?? <RequestEditor user={user!} />} />
        <Route path="/staff/content" element={staffAccess ?? (canAdminister(user!) ? <ContentAdmin onSaved={load} /> : <Alert message="Admissions Admin permission is required." />)} />
        <Route path="*" element={<section className="panel"><h1>Page not found</h1><Link to="/">Return home</Link></section>} />
      </Routes>
    </main>
    <footer className="container footer">
      {data.brand.footerLogoUrl && <img src={data.brand.footerLogoUrl} alt={data.brand.organisationName} />}
      <span>{data.brand.organisationName} Admissions</span>
      <Link to="/information/privacy">Privacy</Link><Link to="/staff">Staff sign-in</Link>
      {/^https:\/\//.test(data.brand.websiteUrl) && <a href={data.brand.websiteUrl} rel="noreferrer">School website</a>}
    </footer>
  </>;
}
