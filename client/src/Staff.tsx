import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { canAdminister, STAGES, type CentralUser, type Page, type RequestDetail, type RequestSummary } from '../../shared/contracts';
import { formatDate, formatDateTime } from '../../shared/dateFormatting';
import { api, errorMessage } from './api';
import { Alert } from './App';
import { Documents } from './Documents';

export function Pipeline({ user }: { user: CentralUser }) {
  const [result, setResult] = useState<{ items: RequestSummary[]; hasMore: boolean } | null>(null);
  const [query, setQuery] = useState({ q: '', stage: '', offset: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const params = new URLSearchParams({ q: query.q, offset: String(query.offset) });
    if (query.stage) params.set('stage', query.stage);
    api<{ items: RequestSummary[]; hasMore: boolean }>(`/api/staff/requests?${params}`).then((data) => {
      if (current) setResult(data);
    }).catch((err: unknown) => { if (current) { setError(errorMessage(err)); setResult(null); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, reload]);
  return <>
    <div className="section-heading"><div><p className="eyebrow">Admissions workspace</p><h1>Request pipeline</h1></div>
      {canAdminister(user) && <Link className="button" to="/staff/content">Manage information pages</Link>}</div>
    <form className="panel filters" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      setQuery({ q: String(data.get('q') ?? ''), stage: String(data.get('stage') ?? ''), offset: 0 });
    }}>
      <label>Search parents<input name="q" type="search" maxLength={120} placeholder="Name or email" /></label>
      <label>Stage<select name="stage"><option value="">All stages</option>{STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
      <button className="primary">Apply filters</button><button type="button" onClick={() => setReload((n) => n + 1)}>Refresh</button>
    </form>
    {error && <Alert message={error} />}
    {loading ? <p role="status">Loading requests...</p> : result && <>
      <p className="muted">{result.items.length} requests on this page. Newest first. Columns show this page only.</p>
      {!result.items.length && <div className="panel"><h2>No requests found</h2><p>New parent submissions will appear here. Try changing your filters.</p></div>}
      <div className="pipeline">{STAGES.filter((stage) => !query.stage || query.stage === stage).map((stage) => {
        const items = result.items.filter((item) => item.stage === stage);
        return <section className="pipeline-column" key={stage} aria-label={stage}>
          <h2>{stage} <span className="count">{items.length}</span></h2>
          {items.map((item) => <Link to={`/staff/requests/${item.id}`} key={item.id} className="request-card panel">
            <span className="eyebrow">#{item.id} / {item.kind}</span><h3>{item.parentName}</h3>
            <p>{item.email}</p>{item.yearGroup && <p>{item.yearGroup}</p>}
            <div className="card-meta"><span>{item.ownerName || 'Unassigned'}</span><time>{formatDate(item.createdAt)}</time></div>
          </Link>)}
        </section>;
      })}</div>
      <div className="actions"><button disabled={!query.offset} onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - 50) })}>Previous</button>
        <span>Page {query.offset / 50 + 1}</span><button disabled={!result.hasMore} onClick={() => setQuery({ ...query, offset: query.offset + 50 })}>Next</button></div>
    </>}
  </>;
}

export function RequestEditor({ user }: { user: CentralUser }) {
  const { id } = useParams();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setError('');
    try { setDetail(await api<RequestDetail>(`/api/staff/requests/${id}`)); }
    catch (err) { setError(errorMessage(err)); setDetail(null); }
  }, [id]);
  useEffect(() => { setDetail(null); void load(); }, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(''); setSaved(false);
    try {
      await api(`/api/staff/requests/${id}`, 'PATCH', {
        revision: detail.revision, stage: form.get('stage'), publicMessage: form.get('publicMessage'),
        internalNote: form.get('internalNote'), assignment: form.get('assignment'),
      });
      setDetail(await api<RequestDetail>(`/api/staff/requests/${id}`)); setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="section-heading"><Link to="/staff">Back to pipeline</Link><button disabled={busy} onClick={() => void load()}>Reload request</button></div>
    {error && <Alert message={error} />}
    {!detail ? (!error && <p role="status">Loading request...</p>) : <>
      <div className="section-heading"><div><p className="eyebrow">Request #{detail.id} / {detail.kind}</p><h1>{detail.parentName}</h1></div><span className="badge">{detail.stage}</span></div>
      <div className="workspace">
        <section className="panel"><h2>Request details</h2><dl>
          <dt>Email</dt><dd><a href={`mailto:${detail.email}`}>{detail.email}</a></dd>
          <dt>Phone</dt><dd>{detail.phone || 'Not provided'}</dd>
          <dt>Year group / entry</dt><dd>{detail.yearGroup || 'Not provided'}</dd>
          <dt>Owner</dt><dd>{detail.ownerName || 'Unassigned'}{detail.ownerId === user.id ? ' (you)' : ''}</dd>
          <dt>Received</dt><dd>{formatDateTime(detail.createdAt)}</dd>
          <dt>Email updates</dt><dd>{detail.notifications}</dd>
        </dl><h3>Parent's message</h3><p className="plain-text">{detail.message}</p>
          <p className="muted">Email queue: {detail.emailQueue.pending} pending, {detail.emailQueue.failed} failed.</p>
          {detail.emailQueue.failed > 0 && <Alert message="Some emails exhausted their delivery retries. Contact your system administrator; parents can still track requests with their code." />}
        </section>
        <section className="panel"><h2>Update request</h2>
          <p>Stage changes and parent-facing messages appear on the tracking page. Internal notes and ownership do not.</p>
          <form key={`${detail.id}-${detail.revision}`} onSubmit={(event) => void save(event)}>
            <fieldset disabled={busy}>
              <label>Stage<select name="stage" defaultValue={detail.stage}>{STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
              <label>Assignment<select name="assignment" defaultValue="keep"><option value="keep">Keep current owner</option><option value="me">Assign to me</option><option value="unassigned">Unassign</option></select></label>
              <label>Parent-facing update (optional)<textarea name="publicMessage" rows={4} maxLength={2000} placeholder="Visible to anyone with the tracking code. Avoid personal or sensitive details." /></label>
              <label>Internal note (staff only)<textarea name="internalNote" rows={4} maxLength={4000} /></label>
              <button className="primary">{busy ? 'Saving...' : 'Save update'}</button>
            </fieldset>
          </form>{saved && <p role="status">Update saved.</p>}
        </section>
      </div>
      <Documents key={detail.id} requestId={detail.id} />
      <section className="panel"><h2>Activity history</h2><ol className="timeline">{detail.events.map((entry) => <li key={entry.id}>
        <div className="section-heading"><strong>{entry.actorName}</strong><time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time></div>
        <span className="badge">{entry.stage}</span>
        {entry.publicMessage && <div><h3>Parent-facing update</h3><p className="plain-text">{entry.publicMessage}</p></div>}
        {entry.internalNote && <div className="internal"><h3>Internal note</h3><p className="plain-text">{entry.internalNote}</p></div>}
      </li>)}</ol></section>
    </>}
  </>;
}

export function ContentAdmin({ onSaved }: { onSaved: () => Promise<void> }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setPages(await api<Page[]>('/api/staff/pages')); }
    catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent<HTMLFormElement>, page: Page) => {
    event.preventDefault(); setBusy(true); setError(''); setSaved('');
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/staff/pages/${page.slug}`, 'PUT', {
        revision: page.revision, title: data.get('title'), body: data.get('body'),
        published: page.slug === 'privacy' || data.get('published') === 'on',
      });
      await load(); await onSaved(); setSaved(`${page.title} saved.`);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <>
    <Link to="/staff">Back to pipeline</Link><h1>Public information pages</h1>
    <p>Branding and user permissions are managed in the Applications Portal. Admissions text is managed here. Content is plain text; HTML is not rendered.</p>
    <p>Replace the starter text, especially the privacy notice, with school-approved information before public launch.</p>
    {error && <Alert message={error} />}{saved && <p role="status">{saved}</p>}
    <button disabled={busy} onClick={() => { setError(''); void load(); }}>Reload pages</button>
    {!pages ? <p role="status">Loading pages...</p> : pages.map((page) =>
      <form className="panel content-editor" key={`${page.slug}-${page.revision}`} onSubmit={(event) => void save(event, page)}>
        <fieldset disabled={busy}><legend>{page.slug}</legend>
          <label>Page title<input name="title" required minLength={2} maxLength={120} defaultValue={page.title} /></label>
          <label>Page content<textarea name="body" required minLength={10} maxLength={20000} rows={8} defaultValue={page.body} /></label>
          <label className="check"><input name="published" type="checkbox" defaultChecked={page.published} disabled={page.slug === 'privacy'} />Published</label>
          <button className="primary">Save page</button>
        </fieldset>
      </form>)}
  </>;
}
