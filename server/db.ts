import sql from 'mssql';
import { randomUUID } from 'node:crypto';
import { DOCUMENT_MAX_COUNT, type EnquiryDocument } from '../shared/contracts.js';
import type { CentralUser, NewRequest, Page, Progress, RequestDetail, RequestSummary, RequestUpdate, StaffEvent } from '../shared/contracts.js';
import { config } from './config.js';
import { HttpError, logger } from './errors.js';
import { hashSecret } from './secrets.js';

const connection: sql.config | string = config.SQL_CONNECTION_STRING || config.SQLAZURECONNSTR_DefaultConnection || {
  server: config.SQL_SERVER!,
  database: config.SQL_DATABASE,
  options: { encrypt: config.SQL_ENCRYPT, trustServerCertificate: config.SQL_TRUST_SERVER_CERTIFICATE },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  ...(config.SQL_AUTH === 'sql'
    ? { user: config.SQL_USER, password: config.SQL_PASSWORD }
    : { authentication: { type: 'azure-active-directory-default', options: { clientId: config.SQL_MANAGED_IDENTITY_CLIENT_ID } } }),
};
export const pool = new sql.ConnectionPool(connection);
pool.on('error', (err) => logger.error({ err }, 'Admissions SQL pool error'));

async function transaction<T>(action: (tx: sql.Transaction) => Promise<T>): Promise<T> {
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await action(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch (rollbackError) { logger.error({ err: rollbackError }, 'SQL rollback failed'); }
    throw error;
  }
}

export async function migrate() {
  await transaction(async (tx) => {
    await new sql.Request(tx).query(`
      DECLARE @lock int;
      EXEC @lock = sp_getapplock @Resource=N'admissions-schema', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=30000;
      IF @lock < 0 THROW 50000, 'Could not acquire Admissions migration lock.', 1;
      IF OBJECT_ID(N'dbo.AdmissionsSchema', N'U') IS NULL
        CREATE TABLE dbo.AdmissionsSchema (version int NOT NULL PRIMARY KEY, appliedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME());
      IF NOT EXISTS (SELECT 1 FROM dbo.AdmissionsSchema WHERE version=1)
      BEGIN
        CREATE TABLE dbo.AdmissionsRequests (
          id int IDENTITY PRIMARY KEY,
          codeHash char(64) NOT NULL UNIQUE,
          kind nvarchar(30) NOT NULL,
          parentName nvarchar(120) NOT NULL,
          email nvarchar(254) NOT NULL,
          phone nvarchar(40) NOT NULL,
          yearGroup nvarchar(60) NOT NULL,
          message nvarchar(4000) NOT NULL,
          stage nvarchar(30) NOT NULL DEFAULT N'New',
          ownerId int NULL,
          ownerName nvarchar(200) NULL,
          notifications varchar(10) NOT NULL DEFAULT 'off',
          verificationHash char(64) NULL,
          verificationExpires datetime2 NULL,
          verificationSentAt datetime2 NULL,
          privacyAcceptedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          consentAt datetime2 NULL,
          createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          revision int NOT NULL DEFAULT 1,
          CONSTRAINT CK_AdmissionsStage CHECK(stage IN (N'New',N'In progress',N'Awaiting parent',N'Visit arranged',N'Resolved',N'Closed')),
          CONSTRAINT CK_AdmissionsKind CHECK(kind IN (N'Enquiry',N'Visit request')),
          CONSTRAINT CK_AdmissionsNotifications CHECK(notifications IN ('off','pending','verified'))
        );
        CREATE INDEX IX_AdmissionsRequests_pipeline ON dbo.AdmissionsRequests(stage, createdAt DESC);
        CREATE UNIQUE INDEX IX_AdmissionsRequests_verification ON dbo.AdmissionsRequests(verificationHash) WHERE verificationHash IS NOT NULL;
        CREATE TABLE dbo.AdmissionsEvents (
          id int IDENTITY PRIMARY KEY,
          requestId int NOT NULL REFERENCES dbo.AdmissionsRequests(id),
          stage nvarchar(30) NOT NULL,
          publicMessage nvarchar(2000) NOT NULL DEFAULT N'',
          internalNote nvarchar(max) NOT NULL DEFAULT N'',
          actorId int NULL,
          actorName nvarchar(200) NOT NULL,
          isPublic bit NOT NULL,
          createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_AdmissionsEvents_request ON dbo.AdmissionsEvents(requestId, id);
        CREATE TABLE dbo.AdmissionsPages (
          slug varchar(40) NOT NULL PRIMARY KEY,
          title nvarchar(120) NOT NULL,
          body nvarchar(max) NOT NULL,
          published bit NOT NULL DEFAULT 1,
          revision int NOT NULL DEFAULT 1,
          updatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updatedBy int NULL
        );
        CREATE TABLE dbo.AdmissionsPageAudit (
          id int IDENTITY PRIMARY KEY,
          slug varchar(40) NOT NULL,
          title nvarchar(120) NOT NULL,
          body nvarchar(max) NOT NULL,
          published bit NOT NULL,
          revision int NOT NULL,
          actorId int NOT NULL,
          createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE TABLE dbo.AdmissionsMail (
          id int IDENTITY PRIMARY KEY,
          requestId int NOT NULL REFERENCES dbo.AdmissionsRequests(id),
          kind varchar(15) NOT NULL,
          token varchar(32) NULL,
          attempts int NOT NULL DEFAULT 0,
          availableAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          leaseUntil datetime2 NULL,
          sentAt datetime2 NULL,
          failedAt datetime2 NULL,
          cancelledAt datetime2 NULL
        );
        CREATE INDEX IX_AdmissionsMail_pending ON dbo.AdmissionsMail(sentAt, failedAt, cancelledAt, availableAt);
        INSERT dbo.AdmissionsPages(slug,title,body) VALUES
          ('welcome',N'Welcome to Admissions',N'Explore admissions, ask our team a question or request a school visit. We look forward to helping your family.'),
          ('admissions',N'Your admissions journey',N'Start with an enquiry and our admissions team will help you understand the next steps. An enquiry is not a formal application or an offer of a place. Please contact the team for current entry requirements, fees and availability.'),
          ('visits',N'Visit our school',N'Request a school visit to learn more about our community. Our team will contact you to discuss availability. A visit request is not a confirmed booking.'),
          ('privacy',N'Privacy and your enquiry',N'We collect the contact details and enquiry you provide so our admissions team can respond. Do not include sensitive information or documents about your child in this form. Keep your tracking code private: anyone with the code can see the progress and public updates for your request. Email updates are optional and require confirmation of your email address. You can turn them off on the tracking page. Contact the admissions team for privacy enquiries. The school must publish its approved retention policy, contact details and privacy information here before launch.');
        INSERT dbo.AdmissionsSchema(version) VALUES(1);
      END
      IF OBJECT_ID(N'dbo.AdmissionsDocuments', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.AdmissionsDocuments (
          id uniqueidentifier NOT NULL PRIMARY KEY,
          requestId int NOT NULL REFERENCES dbo.AdmissionsRequests(id),
          blobName varchar(100) NOT NULL UNIQUE,
          filename nvarchar(180) NOT NULL,
          mimeType varchar(100) NOT NULL,
          size int NOT NULL CHECK (size>0 AND size<=10485760),
          uploadedBy varchar(6) NOT NULL CHECK (uploadedBy IN ('parent','staff')),
          actorId int NULL,
          createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_AdmissionsDocuments_request ON dbo.AdmissionsDocuments(requestId, createdAt);
      END;
      IF NOT EXISTS (SELECT 1 FROM dbo.AdmissionsSchema WHERE version=2)
        INSERT dbo.AdmissionsSchema(version) VALUES(2);
    `);
  });
}

type DbSummary = Omit<RequestSummary, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };
type DbEvent = Omit<StaffEvent, 'createdAt'> & { createdAt: Date };
const summary = (row: DbSummary): RequestSummary => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
const event = (row: DbEvent): StaffEvent => ({ ...row, createdAt: row.createdAt.toISOString() });
const summaryColumns = 'id,kind,parentName,email,yearGroup,stage,ownerId,ownerName,createdAt,updatedAt,revision';
const missing = () => new HttpError(404, 'Request not found.', 'NOT_FOUND');
const conflict = () => new HttpError(409, 'This record has changed. Reload it before saving.', 'REVISION_CONFLICT');

export type DocumentAccess = { code: string } | { requestId: number };
function documentAccess(request: sql.Request, access: DocumentAccess) {
  return 'code' in access
    ? request.input('codeHash', sql.Char(64), hashSecret(access.code))
    : request.input('requestId', sql.Int, access.requestId);
}
const accessWhere = (access: DocumentAccess) => 'code' in access ? 'codeHash=@codeHash' : 'id=@requestId';
export async function authorizeDocuments(access: DocumentAccess): Promise<number> {
  const result = await documentAccess(pool.request(), access).query(`SELECT id FROM dbo.AdmissionsRequests WHERE ${accessWhere(access)}`);
  if (!result.recordset[0]) throw missing();
  return result.recordset[0].id;
}
type StoredDocument = EnquiryDocument & { blobName: string };
const documentColumns = 'id,filename,mimeType,size,uploadedBy,createdAt';
function documentRow(row: Omit<EnquiryDocument, 'createdAt'> & { createdAt: Date }): EnquiryDocument {
  return { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size,
    uploadedBy: row.uploadedBy, createdAt: row.createdAt.toISOString() };
}
export async function listDocuments(requestId: number): Promise<EnquiryDocument[]> {
  const result = await pool.request().input('requestId', sql.Int, requestId)
    .query(`SELECT ${documentColumns} FROM dbo.AdmissionsDocuments WHERE requestId=@requestId ORDER BY createdAt,id`);
  return result.recordset.map(documentRow);
}
export async function getDocument(requestId: number, id: string): Promise<StoredDocument> {
  const result = await pool.request().input('requestId', sql.Int, requestId).input('id', sql.UniqueIdentifier, id)
    .query(`SELECT ${documentColumns},blobName FROM dbo.AdmissionsDocuments WHERE requestId=@requestId AND id=@id`);
  if (!result.recordset[0]) throw new HttpError(404, 'Document not found.');
  return { ...documentRow(result.recordset[0]), blobName: result.recordset[0].blobName };
}
export async function addDocument(requestId: number, metadata: { filename: string; mimeType: string; size: number },
  actorId: number | null, upload: (name: string) => Promise<void>, cleanup: (name: string) => Promise<void>): Promise<void> {
  const id = randomUUID();
  const blobName = `enquiries/${requestId}/${id}`;
  let uploaded = false, commitAttempted = false;
  try {
    await transaction(async (tx) => {
      // Lock the enquiry, not just current document rows, so a previously empty set is also safe across instances.
      const parent = await new sql.Request(tx).input('id', sql.Int, requestId)
        .query('SELECT id FROM dbo.AdmissionsRequests WITH (UPDLOCK,HOLDLOCK) WHERE id=@id');
      if (!parent.recordset[0]) throw missing();
      const count = await new sql.Request(tx).input('requestId', sql.Int, requestId)
        .query('SELECT COUNT(*) AS count FROM dbo.AdmissionsDocuments WHERE requestId=@requestId');
      if (count.recordset[0].count >= DOCUMENT_MAX_COUNT) throw new HttpError(409, 'This enquiry already has 5 documents. Contact Admissions for help.');
      await upload(blobName); uploaded = true;
      await new sql.Request(tx).input('id', sql.UniqueIdentifier, id).input('requestId', sql.Int, requestId)
        .input('blobName', sql.VarChar(100), blobName).input('filename', sql.NVarChar(180), metadata.filename)
        .input('mimeType', sql.VarChar(100), metadata.mimeType).input('size', sql.Int, metadata.size)
        .input('uploadedBy', sql.VarChar(6), actorId === null ? 'parent' : 'staff').input('actorId', sql.Int, actorId)
        .query(`INSERT dbo.AdmissionsDocuments(id,requestId,blobName,filename,mimeType,size,uploadedBy,actorId)
          VALUES(@id,@requestId,@blobName,@filename,@mimeType,@size,@uploadedBy,@actorId)`);
      commitAttempted = true;
    });
  } catch (error) {
    if (uploaded && !commitAttempted) {
      try { await cleanup(blobName); } catch { logger.error('Document cleanup failed; private orphan reconciliation required.'); }
    } else if (uploaded) {
      // A lost COMMIT acknowledgement is ambiguous: deleting here could destroy a committed document.
      logger.error('Document commit outcome uncertain; private orphan reconciliation may be required.');
    }
    throw error;
  }
}

export async function createRequest(data: NewRequest, code: string, verificationToken: string | null) {
  return transaction(async (tx) => {
    const result = await new sql.Request(tx)
      .input('hash', sql.Char(64), hashSecret(code))
      .input('kind', sql.NVarChar(30), data.kind)
      .input('name', sql.NVarChar(120), data.parentName)
      .input('email', sql.NVarChar(254), data.email)
      .input('phone', sql.NVarChar(40), data.phone)
      .input('year', sql.NVarChar(60), data.yearGroup)
      .input('message', sql.NVarChar(4000), data.message)
      .input('verification', sql.Char(64), verificationToken ? hashSecret(verificationToken) : null)
      .input('notifications', sql.VarChar(10), verificationToken ? 'pending' : 'off')
      .query<{ id: number }>(`
        INSERT dbo.AdmissionsRequests(codeHash,kind,parentName,email,phone,yearGroup,message,notifications,verificationHash,verificationExpires,verificationSentAt)
        OUTPUT INSERTED.id VALUES(@hash,@kind,@name,@email,@phone,@year,@message,@notifications,@verification,
          CASE WHEN @verification IS NOT NULL THEN DATEADD(hour,24,SYSUTCDATETIME()) END,
          CASE WHEN @verification IS NOT NULL THEN SYSUTCDATETIME() END)
      `);
    const id = result.recordset[0].id;
    await new sql.Request(tx).input('id', sql.Int, id).query(`
      INSERT dbo.AdmissionsEvents(requestId,stage,publicMessage,actorName,isPublic)
      VALUES(@id,N'New',N'Your request has been received. Our admissions team will review it.',N'Admissions',1)
    `);
    if (verificationToken) await enqueue(tx, id, 'confirmation', verificationToken);
    return id;
  });
}

export async function getProgress(code: string): Promise<Progress> {
  const result = await pool.request().input('hash', sql.Char(64), hashSecret(code)).query<{
    id: number; kind: Progress['kind']; stage: Progress['stage']; createdAt: Date; updatedAt: Date; notifications: Progress['notifications'];
  }>('SELECT id,kind,stage,createdAt,updatedAt,notifications FROM dbo.AdmissionsRequests WHERE codeHash=@hash');
  const row = result.recordset[0];
  if (!row) throw missing();
  const events = await pool.request().input('id', sql.Int, row.id).query<DbEvent>(`
    SELECT id,stage,publicMessage,createdAt FROM dbo.AdmissionsEvents WHERE requestId=@id AND isPublic=1 ORDER BY id
  `);
  return {
    kind: row.kind, stage: row.stage, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    notifications: row.notifications,
    timeline: events.recordset.map((entry) => ({
      id: entry.id, stage: entry.stage, publicMessage: entry.publicMessage, createdAt: entry.createdAt.toISOString(),
    })),
  };
}

async function enqueue(tx: sql.Transaction, id: number, kind: 'confirmation' | 'update', token: string | null = null) {
  await new sql.Request(tx).input('id', sql.Int, id).input('kind', sql.VarChar(15), kind).input('token', sql.VarChar(32), token)
    .query('INSERT dbo.AdmissionsMail(requestId,kind,token) VALUES(@id,@kind,@token)');
}

export async function setNotifications(code: string, enabled: boolean, token: string) {
  await transaction(async (tx) => {
    const result = await new sql.Request(tx).input('hash', sql.Char(64), hashSecret(code))
      .query<{ id: number; notifications: string; verificationSentAt: Date | null }>(`
        SELECT id,notifications,verificationSentAt FROM dbo.AdmissionsRequests WITH(UPDLOCK) WHERE codeHash=@hash
      `);
    const row = result.recordset[0];
    if (!row) throw missing();
    if (enabled && row.notifications === 'verified') return;
    if (enabled && row.verificationSentAt && Date.now() - row.verificationSentAt.getTime() < 120000) {
      throw new HttpError(429, 'Please wait two minutes before requesting another verification email.');
    }
    await new sql.Request(tx).input('id', sql.Int, row.id).input('enabled', sql.Bit, enabled)
      .input('hash', sql.Char(64), enabled ? hashSecret(token) : null).query(`
        UPDATE dbo.AdmissionsRequests SET notifications=CASE WHEN @enabled=1 THEN 'pending' ELSE 'off' END,
          verificationHash=@hash, verificationExpires=CASE WHEN @enabled=1 THEN DATEADD(hour,24,SYSUTCDATETIME()) END,
          verificationSentAt=CASE WHEN @enabled=1 THEN SYSUTCDATETIME() ELSE verificationSentAt END, consentAt=NULL WHERE id=@id;
        UPDATE dbo.AdmissionsMail SET cancelledAt=SYSUTCDATETIME(),token=NULL
          WHERE requestId=@id AND sentAt IS NULL AND failedAt IS NULL AND cancelledAt IS NULL;
      `);
    if (enabled) await enqueue(tx, row.id, 'confirmation', token);
  });
}

export async function verifyNotifications(token: string) {
  const result = await pool.request().input('hash', sql.Char(64), hashSecret(token)).query(`
    UPDATE dbo.AdmissionsRequests SET notifications='verified',consentAt=SYSUTCDATETIME(),verificationHash=NULL,verificationExpires=NULL
    WHERE verificationHash=@hash AND notifications='pending' AND verificationExpires>SYSUTCDATETIME()
  `);
  if (result.rowsAffected[0] !== 1) throw new HttpError(400, 'This confirmation link is invalid, expired or already used. Check your tracking page.');
}

export async function listRequests(q: string, stage: string | undefined, offset: number) {
  const result = await pool.request()
    .input('q', sql.NVarChar(120), q).input('stage', sql.NVarChar(30), stage ?? null).input('offset', sql.Int, offset)
    .query<DbSummary>(`
      SELECT ${summaryColumns} FROM dbo.AdmissionsRequests
      WHERE (@stage IS NULL OR stage=@stage) AND (@q=N'' OR CHARINDEX(@q,parentName)>0 OR CHARINDEX(@q,email)>0)
      ORDER BY createdAt DESC,id DESC OFFSET @offset ROWS FETCH NEXT 51 ROWS ONLY
    `);
  return { items: result.recordset.slice(0, 50).map(summary), hasMore: result.recordset.length > 50 };
}

export async function getRequest(id: number): Promise<RequestDetail> {
  const result = await pool.request().input('id', sql.Int, id).query<DbSummary & {
    phone: string; message: string; notifications: Progress['notifications'];
  }>(`SELECT ${summaryColumns},phone,message,notifications FROM dbo.AdmissionsRequests WHERE id=@id`);
  const row = result.recordset[0];
  if (!row) throw missing();
  const events = await pool.request().input('id', sql.Int, id)
    .query<DbEvent>('SELECT id,stage,publicMessage,internalNote,actorName,createdAt FROM dbo.AdmissionsEvents WHERE requestId=@id ORDER BY id');
  const mail = await pool.request().input('id', sql.Int, id).query<{ pending: number; failed: number }>(`
    SELECT COALESCE(SUM(CASE WHEN sentAt IS NULL AND failedAt IS NULL AND cancelledAt IS NULL THEN 1 ELSE 0 END),0) pending,
      COALESCE(SUM(CASE WHEN failedAt IS NOT NULL THEN 1 ELSE 0 END),0) failed
    FROM dbo.AdmissionsMail WHERE requestId=@id
  `);
  return { ...summary(row), phone: row.phone, message: row.message, notifications: row.notifications,
    events: events.recordset.map(event), emailQueue: mail.recordset[0] };
}

export async function updateRequest(id: number, data: RequestUpdate, user: CentralUser) {
  await transaction(async (tx) => {
    const previous = await new sql.Request(tx).input('id', sql.Int, id)
      .query<{ stage: string }>('SELECT stage FROM dbo.AdmissionsRequests WITH(UPDLOCK) WHERE id=@id');
    if (!previous.recordset[0]) throw missing();
    const isPublic = previous.recordset[0].stage !== data.stage || Boolean(data.publicMessage);
    const result = await new sql.Request(tx).input('id', sql.Int, id).input('revision', sql.Int, data.revision)
      .input('stage', sql.NVarChar(30), data.stage).input('assignment', sql.VarChar(15), data.assignment)
      .input('ownerId', sql.Int, user.id).input('ownerName', sql.NVarChar(200), user.displayName.slice(0, 200))
      .query(`
        UPDATE dbo.AdmissionsRequests SET stage=@stage,revision=revision+1,
          updatedAt=CASE WHEN stage<>@stage THEN SYSUTCDATETIME() ELSE updatedAt END,
          ownerId=CASE WHEN @assignment='me' THEN @ownerId WHEN @assignment='unassigned' THEN NULL ELSE ownerId END,
          ownerName=CASE WHEN @assignment='me' THEN @ownerName WHEN @assignment='unassigned' THEN NULL ELSE ownerName END
        WHERE id=@id AND revision=@revision
      `);
    if (result.rowsAffected[0] !== 1) throw conflict();
    await new sql.Request(tx).input('id', sql.Int, id).input('stage', sql.NVarChar(30), data.stage)
      .input('public', sql.NVarChar(2000), data.publicMessage)
      .input('internal', sql.NVarChar(sql.MAX), [
        data.assignment === 'me' ? 'Assigned to the acting staff member.' : data.assignment === 'unassigned' ? 'Request unassigned.' : '',
        data.internalNote,
      ].filter(Boolean).join('\n'))
      .input('actor', sql.Int, user.id).input('name', sql.NVarChar(200), user.displayName.slice(0, 200)).input('visible', sql.Bit, isPublic)
      .query(`
        INSERT dbo.AdmissionsEvents(requestId,stage,publicMessage,internalNote,actorId,actorName,isPublic)
        VALUES(@id,@stage,@public,@internal,@actor,@name,@visible);
        IF @visible=1 UPDATE dbo.AdmissionsRequests SET updatedAt=SYSUTCDATETIME() WHERE id=@id;
      `);
    if (isPublic) {
      await new sql.Request(tx).input('id', sql.Int, id).query(`
        INSERT dbo.AdmissionsMail(requestId,kind)
        SELECT id,'update' FROM dbo.AdmissionsRequests WHERE id=@id AND notifications='verified'
      `);
    }
  });
}

export async function getPages(includeUnpublished = false): Promise<Page[]> {
  const result = await pool.request().input('all', sql.Bit, includeUnpublished)
    .query<Page>('SELECT slug,title,body,published,revision FROM dbo.AdmissionsPages WHERE published=1 OR @all=1 ORDER BY slug');
  return result.recordset;
}
export async function updatePage(slug: string, data: Omit<Page, 'slug'>, userId: number) {
  if (slug === 'privacy' && !data.published) throw new HttpError(400, 'The privacy page must remain published.');
  await transaction(async (tx) => {
    const result = await new sql.Request(tx).input('slug', sql.VarChar(40), slug).input('title', sql.NVarChar(120), data.title)
      .input('body', sql.NVarChar(sql.MAX), data.body).input('published', sql.Bit, data.published)
      .input('revision', sql.Int, data.revision).input('actor', sql.Int, userId).query(`
        UPDATE dbo.AdmissionsPages SET title=@title,body=@body,published=@published,revision=revision+1,
          updatedAt=SYSUTCDATETIME(),updatedBy=@actor WHERE slug=@slug AND revision=@revision;
        IF @@ROWCOUNT=1 BEGIN
          INSERT dbo.AdmissionsPageAudit(slug,title,body,published,revision,actorId)
          SELECT slug,title,body,published,revision,@actor FROM dbo.AdmissionsPages WHERE slug=@slug;
          SELECT 1 updated;
        END
      `);
    if (!result.recordset?.length) throw conflict();
  });
}

export interface MailJob { id: number; requestId: number; kind: string; token: string | null; email: string; attempts: number }
export async function claimMail(): Promise<MailJob | null> {
  const claimed = await pool.request().query<{ id: number; requestId: number; kind: string; token: string | null; attempts: number }>(`
    UPDATE dbo.AdmissionsMail SET failedAt=SYSUTCDATETIME(),token=NULL,leaseUntil=NULL
      WHERE attempts>=8 AND sentAt IS NULL AND failedAt IS NULL AND cancelledAt IS NULL
        AND (leaseUntil IS NULL OR leaseUntil<SYSUTCDATETIME());
    ;WITH candidate AS (
      SELECT TOP(1) * FROM dbo.AdmissionsMail WITH(UPDLOCK,READPAST,READCOMMITTEDLOCK)
      WHERE sentAt IS NULL AND failedAt IS NULL AND cancelledAt IS NULL
        AND attempts<8
        AND availableAt<=SYSUTCDATETIME() AND (leaseUntil IS NULL OR leaseUntil<SYSUTCDATETIME())
      ORDER BY id
    )
    UPDATE candidate SET leaseUntil=DATEADD(second,120,SYSUTCDATETIME()),attempts=attempts+1
    OUTPUT INSERTED.id,INSERTED.requestId,INSERTED.kind,INSERTED.token,INSERTED.attempts
  `);
  const job = claimed.recordset[0];
  if (!job) return null;
  const recipient = await pool.request().input('id', sql.Int, job.requestId).query<{
    email: string; notifications: string; verificationHash: string | null; verificationExpires: Date | null;
  }>('SELECT email,notifications,verificationHash,verificationExpires FROM dbo.AdmissionsRequests WHERE id=@id');
  const row = recipient.recordset[0];
  const eligible = row && (job.kind === 'update' ? row.notifications === 'verified'
    : row.notifications === 'pending' && job.token && row.verificationHash === hashSecret(job.token)
      && row.verificationExpires && row.verificationExpires.getTime() > Date.now());
  if (!eligible) {
    await pool.request().input('id', sql.Int, job.id)
      .query('UPDATE dbo.AdmissionsMail SET cancelledAt=SYSUTCDATETIME(),token=NULL,leaseUntil=NULL WHERE id=@id');
    return null;
  }
  return { ...job, email: row.email };
}
export async function completeMail(job: MailJob) {
  await pool.request().input('id', sql.Int, job.id)
    .query('UPDATE dbo.AdmissionsMail SET sentAt=SYSUTCDATETIME(),token=NULL,leaseUntil=NULL WHERE id=@id');
}
export async function failMail(job: MailJob) {
  await pool.request().input('id', sql.Int, job.id).input('attempts', sql.Int, job.attempts)
    .input('delay', sql.Int, Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7))).query(`
      UPDATE dbo.AdmissionsMail SET leaseUntil=NULL,availableAt=DATEADD(second,@delay,SYSUTCDATETIME()),
        failedAt=CASE WHEN @attempts>=8 THEN SYSUTCDATETIME() END,
        token=CASE WHEN @attempts>=8 THEN NULL ELSE token END WHERE id=@id
    `);
}
