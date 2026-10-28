import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_COUNT, DOCUMENT_TYPES, type EnquiryDocument } from '../../shared/contracts';
import { formatDateTime } from '../../shared/dateFormatting';
import { api, ApiError, errorMessage } from './api';
import { Alert } from './App';

export function validateSelectedDocument(file: Pick<File, 'name' | 'size'>): string {
  if (!file.size || file.size > DOCUMENT_MAX_BYTES) return 'Choose a non-empty document of at most 10 MB.';
  if (!file.name.includes('.') || !Object.hasOwn(DOCUMENT_TYPES, file.name.split('.').at(-1)?.toLowerCase() ?? '')) return 'Choose PDF, DOCX, XLSX, PPTX, PNG, JPG, WEBP or GIF.';
  return '';
}
async function documentResponse(response: Response) {
  if (response.ok) return;
  const content: unknown = await response.json().catch(() => null);
  throw new ApiError(typeof content === 'object' && content !== null && 'error' in content && typeof content.error === 'string'
    ? content.error : 'Document service unavailable. Please try again.', response.status);
}
type DocumentList = { documents: EnquiryDocument[]; ready: boolean };
export function Documents({ code, requestId }: { code?: string; requestId?: number }) {
  const base = requestId ? `/api/staff/requests/${requestId}/documents` : '/api/tracking/documents';
  const [result, setResult] = useState<DocumentList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setResult(await api<DocumentList>(requestId ? base : `${base}/list`, requestId ? 'GET' : 'POST', requestId ? undefined : { code }));
  }, [base, code, requestId]);
  useEffect(() => {
    let current = true;
    setResult(null); setError('');
    api<DocumentList>(requestId ? base : `${base}/list`, requestId ? 'GET' : 'POST', requestId ? undefined : { code })
      .then((data) => { if (current) setResult(data); }).catch((err: unknown) => { if (current) setError(errorMessage(err)); });
    return () => { current = false; };
  }, [base, code, requestId]);
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) { setError('Choose a document first.'); return; }
    const issue = validateSelectedDocument(file);
    if (issue) { setError(issue); return; }
    if ((result?.documents.length ?? 0) >= DOCUMENT_MAX_COUNT) { setError('This enquiry already has 5 documents.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(base, {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name),
          ...(code ? { 'X-Tracking-Code': code } : {}) },
      });
      await documentResponse(response);
      if (input.current) input.current.value = '';
      await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const download = async (document: EnquiryDocument) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${base}/${document.id}/download`, {
        method: requestId ? 'GET' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, ...(requestId ? {} : { body: JSON.stringify({ code }) }),
      });
      await documentResponse(response);
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement('a');
      link.href = url; link.download = document.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <section className="panel"><h2>Enquiry documents</h2>
    <p>Up to {DOCUMENT_MAX_COUNT} documents per enquiry, {DOCUMENT_MAX_BYTES / 1024 / 1024} MB each. PDF, DOCX, XLSX, PPTX, PNG, JPG, WEBP or GIF. Original files are preserved without compression.</p>
    <p>Only upload documents requested by Admissions. Anyone with your private tracking code and authorised Admissions staff can upload and download these files. Staff uploads are also visible to the parent.</p>
    {error && <Alert message={error} />}
    {!result ? !error && <p role="status">Loading documents...</p> : <>
      {!result.ready && <p role="status">Private document storage is unavailable. Existing enquiries still work. Contact Admissions if you need to send a document.</p>}
      <ul>{result.documents.map((document) => <li key={document.id}>
        {document.filename} — {(document.size / 1024).toFixed(0)} KB, uploaded by {document.uploadedBy}, {formatDateTime(document.createdAt)}{' '}
        <button type="button" disabled={busy || !result.ready} onClick={() => void download(document)}>Download</button>
      </li>)}</ul>
      {!result.documents.length && <p>No documents yet.</p>}
      {result.documents.length >= DOCUMENT_MAX_COUNT ? <p>The 5-document limit has been reached. Contact Admissions if you need help.</p>
        : <form onSubmit={(event) => void upload(event)}><fieldset disabled={busy || !result.ready}>
          <label>Choose a document<input ref={input} type="file" accept={Object.keys(DOCUMENT_TYPES).map((ext) => `.${ext}`).join(',')} /></label>
          <button type="submit">{busy ? 'Please wait...' : 'Upload document'}</button>
        </fieldset></form>}
    </>}
  </section>;
}
