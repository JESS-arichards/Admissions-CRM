import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowRight, CalendarDays, CheckCircle2, MessageCircle, Search } from 'lucide-react';
import type { Brand, Page, Progress } from '../../shared/contracts';
import { KINDS } from '../../shared/contracts';
import { formatDateTime } from '../../shared/dateFormatting';
import { Alert } from './App';
import { api, errorMessage } from './api';
import { Documents } from './Documents';

const date = (value: string) => formatDateTime(value);
export function Information({ pages, brand, home = false }: { pages: Page[]; brand: Brand; home?: boolean }) {
  const { slug } = useParams();
  const page = pages.find((item) => item.slug === (home ? 'welcome' : slug));
  if (!page) return <section className="panel"><h1>Information unavailable</h1><p>This page is not currently published.</p><Link to="/">Return home</Link></section>;
  return <>
    <section className={home ? 'hero panel' : 'panel prose'}>
      <p className="eyebrow">{brand.organisationName} / Admissions</p>
      <h1>{page.title}</h1>
      <div className="plain-text">{page.body}</div>
      {page.slug !== 'privacy' && <div className="actions"><Link className="button primary" to="/request">Start a conversation <ArrowRight size={18} /></Link>
        <Link className="button" to="/track">Track your request</Link></div>}
    </section>
    {home && <>
      <section className="cards" aria-label="How we can help">
        <Link className="panel feature" to="/request"><MessageCircle /><h2>Ask Admissions</h2><p>Get help with entry requirements, availability and your next steps.</p><span>Make an enquiry <ArrowRight size={16} /></span></Link>
        <Link className="panel feature" to="/request?kind=visit"><CalendarDays /><h2>Come and visit</h2><p>Tell us you would like to visit. Our team will help arrange a suitable time.</p><span>Request a visit <ArrowRight size={16} /></span></Link>
        <Link className="panel feature" to="/track"><Search /><h2>Stay in the loop</h2><p>No account needed. Use your private code to follow your request.</p><span>Check progress <ArrowRight size={16} /></span></Link>
      </section>
      {brand.homeValues && <section className="panel"><h2>{brand.valuesTitle || 'Our values'}</h2><div className="cards">
        {brand.homeValues.split('\n').filter(Boolean).map((line, index) => {
          const [name, ...description] = line.split('|');
          return <div key={index}><h3>{name?.trim()}</h3><p>{description.join('|').trim()}</p></div>;
        })}</div></section>}
    </>}
  </>;
}

export function RequestForm({ emailEnabled, onCode }: { emailEnabled: boolean; onCode: (code: string) => void }) {
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ code: string; notifications: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await api<{ code: string; notifications: string }>('/api/requests', 'POST', {
        kind: form.get('kind'), parentName: form.get('parentName'), email: form.get('email'),
        phone: form.get('phone'), yearGroup: form.get('yearGroup'), message: form.get('message'),
        emailOptIn: form.get('emailOptIn') === 'on', privacyAccepted: form.get('privacy') === 'on', website: form.get('website'),
      });
      setResult(response); onCode(response.code);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  if (result) return <section className="panel narrow" role="status"><CheckCircle2 size={36} /><h1>We have your request</h1>
    <p>Save this private tracking code now. It is shown only once and cannot be recovered by email.</p>
    <code className="tracking-code">{result.code}</code>
    <p>Anyone with this code can view your progress and upload or download enquiry documents. Do not share it publicly. The code is case-sensitive.</p>
    <p>Need to send a document? Open View progress, look up your code, then use Enquiry documents.</p>
    <div className="actions"><button onClick={() => {
      navigator.clipboard.writeText(result.code).then(() => setCopied(true)).catch((err: unknown) => setError(`Could not copy the code: ${errorMessage(err)}. Select and copy it manually.`));
    }}>{copied ? 'Copied' : 'Copy code'}</button><Link className="button primary" to="/track">View progress</Link></div>
    {result.notifications === 'pending' && <p>A confirmation email has been queued. Email updates start only after you confirm your address. Delivery may take a few minutes; check your junk folder.</p>}
    {error && <Alert message={error} />}
  </section>;
  return <section className="panel narrow"><p className="eyebrow">Let us help</p><h1>Make an admissions request</h1>
    <p>Send an enquiry or request a visit. This is not a formal application or a confirmed visit booking.</p>
    <p>Please do not include sensitive child information in this message. If Admissions requests documents, submit this form first, then upload them privately on the tracking page using your code.</p>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        <label>Request type<select name="kind" defaultValue={params.get('kind') === 'visit' ? 'Visit request' : 'Enquiry'}>{KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
        <label>Your name<input name="parentName" autoComplete="name" required minLength={2} maxLength={120} /></label>
        <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        <label>Phone number (optional)<input name="phone" type="tel" autoComplete="tel" maxLength={40} /></label>
        <label>Year group / intended entry (optional)<input name="yearGroup" maxLength={60} /></label>
        <label>How can we help?<textarea name="message" required minLength={10} maxLength={4000} rows={6} /></label>
        <div className="honeypot" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <label className="check"><input type="checkbox" name="privacy" required /><span>I have read the <Link to="/information/privacy" target="_blank">privacy notice</Link> and agree to the school using these details to respond to my request.</span></label>
        <label className="check"><input type="checkbox" name="emailOptIn" disabled={!emailEnabled} /><span>Email me when my request is updated. I will verify my email address first. (Optional)</span></label>
        {!emailEnabled && <p className="muted">Email notifications are not currently available. You can still track your request with your code.</p>}
        {error && <Alert message={error} />}
        <button className="primary" type="submit">{busy ? 'Submitting...' : 'Submit request'}</button>
      </fieldset>
    </form>
  </section>;
}

export function TrackRequest({ code, setCode, emailEnabled }: { code: string; setCode: (code: string) => void; emailEnabled: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeCode, setActiveCode] = useState('');
  const lookup = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setProgress(null);
    try { setProgress(await api<Progress>('/api/tracking', 'POST', { code })); setActiveCode(code); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const notifications = async (enabled: boolean) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/tracking/notifications', 'POST', { code: activeCode, enabled });
      setProgress(await api<Progress>('/api/tracking', 'POST', { code: activeCode }));
      setNotice(enabled ? 'A verification email has been queued. Confirm your email address to start receiving updates.' : 'Email updates have been turned off.');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <section className="panel narrow"><p className="eyebrow">Your admissions journey</p><h1>Track your request</h1>
    <p>Enter the case-sensitive code you saved when you submitted your request. No account is needed.</p>
    <form onSubmit={(event) => void lookup(event)} className="lookup">
      <label>Private tracking code<input value={code} onChange={(event) => {
        setCode(event.target.value.trim()); setProgress(null); setNotice('');
      }} autoComplete="off" autoCapitalize="none" spellCheck={false} required pattern="[A-Za-z0-9_\-]{32}" minLength={32} maxLength={32} /></label>
      <button className="primary" disabled={busy}>{busy ? 'Please wait...' : 'View progress'}</button>
    </form>
    <p className="muted">Lost your code? Contact Admissions using the school's official contact details. Codes cannot be recovered through this site.</p>
    {error && <Alert message={error} />}
    {notice && <p role="status">{notice}</p>}
    {progress && <div className="progress">
      <div className="section-heading"><h2>{progress.kind}</h2><span className="badge">{progress.stage}</span></div>
      <p className="muted">Received {date(progress.createdAt)}</p>
      <ol className="timeline">{progress.timeline.map((entry) => <li key={entry.id}>
        <span className="badge">{entry.stage}</span><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>
        {entry.publicMessage && <p className="plain-text">{entry.publicMessage}</p>}
      </li>)}</ol>
      <h3>Email updates</h3><p>{progress.notifications === 'verified' ? 'Your email address is verified and updates are enabled.'
        : progress.notifications === 'pending' ? 'Waiting for email confirmation. Links expire after 24 hours.' : 'Email updates are off.'}</p>
      <div className="actions">
        {progress.notifications !== 'verified' && emailEnabled && <button disabled={busy} onClick={() => void notifications(true)}>
          {progress.notifications === 'pending' ? 'Resend confirmation email' : 'Enable email updates'}</button>}
        {progress.notifications !== 'off' && <button disabled={busy} onClick={() => void notifications(false)}>Turn off email updates</button>}
      </div>
      <p className="muted">Updates go only to the email address provided with your request. Your tracking code is never sent by email.</p>
      <Documents key={activeCode} code={activeCode} />
    </div>}
  </section>;
}

export function ConfirmEmail() {
  const token = useRef(window.location.hash.slice(1));
  const [state, setState] = useState<'ready' | 'busy' | 'done'>('ready');
  const [error, setError] = useState('');
  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);
  const confirm = async () => {
    setState('busy'); setError('');
    try { await api('/api/notifications/confirm', 'POST', { token: token.current }); setState('done'); token.current = ''; }
    catch (err) { setError(errorMessage(err)); setState('ready'); }
  };
  return <section className="panel narrow"><h1>{state === 'done' ? 'Email updates confirmed' : 'Confirm email updates'}</h1>
    {state === 'done' ? <p>You will be notified when the team publishes an update. Use your saved tracking code to view details or turn off notifications.</p>
      : <><p>Confirm that you want to receive email updates about your admissions request.</p>
        <button className="primary" disabled={state === 'busy' || !token.current} onClick={() => void confirm()}>{state === 'busy' ? 'Confirming...' : 'Confirm email updates'}</button>
        {!token.current && <p>No confirmation token was provided. Request a new email from the tracking page.</p>}</>}
    {error && <Alert message={error} />}<p><Link to="/track">Track your request</Link></p>
  </section>;
}
