/*
  Admissions CRM - SQL Server / Azure SQL Database schema (version 1).

  Run in the existing, separate Admissions database, not the Portal database.
  Creates missing tables/indexes and starter pages without replacing existing data.
  Does not create a database, users, permissions, or central Portal roles.
  Uses the same transaction-owned lock and version ledger as application startup.
*/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @lock int;
  EXEC @lock = sys.sp_getapplock @Resource=N'admissions-schema', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=30000;
  IF @lock < 0 THROW 50000, 'Could not acquire Admissions migration lock.', 1;

  IF OBJECT_ID(N'dbo.AdmissionsSchema', N'U') IS NULL
    CREATE TABLE dbo.AdmissionsSchema (version int NOT NULL PRIMARY KEY, appliedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME());

  IF OBJECT_ID(N'dbo.AdmissionsRequests', N'U') IS NULL
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

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AdmissionsRequests') AND name=N'IX_AdmissionsRequests_pipeline')
    CREATE INDEX IX_AdmissionsRequests_pipeline ON dbo.AdmissionsRequests(stage, createdAt DESC);
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AdmissionsRequests') AND name=N'IX_AdmissionsRequests_verification')
    CREATE UNIQUE INDEX IX_AdmissionsRequests_verification ON dbo.AdmissionsRequests(verificationHash) WHERE verificationHash IS NOT NULL;

  IF OBJECT_ID(N'dbo.AdmissionsEvents', N'U') IS NULL
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

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AdmissionsEvents') AND name=N'IX_AdmissionsEvents_request')
    CREATE INDEX IX_AdmissionsEvents_request ON dbo.AdmissionsEvents(requestId, id);

  IF OBJECT_ID(N'dbo.AdmissionsPages', N'U') IS NULL
    CREATE TABLE dbo.AdmissionsPages (
      slug varchar(40) NOT NULL PRIMARY KEY,
      title nvarchar(120) NOT NULL,
      body nvarchar(max) NOT NULL,
      published bit NOT NULL DEFAULT 1,
      revision int NOT NULL DEFAULT 1,
      updatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
      updatedBy int NULL
    );

  IF OBJECT_ID(N'dbo.AdmissionsPageAudit', N'U') IS NULL
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

  IF OBJECT_ID(N'dbo.AdmissionsMail', N'U') IS NULL
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

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AdmissionsMail') AND name=N'IX_AdmissionsMail_pending')
    CREATE INDEX IX_AdmissionsMail_pending ON dbo.AdmissionsMail(sentAt, failedAt, cancelledAt, availableAt);

  INSERT dbo.AdmissionsPages(slug,title,body)
  SELECT seed.slug,seed.title,seed.body
  FROM (VALUES
    ('welcome',N'Welcome to Admissions',N'Explore admissions, ask our team a question or request a school visit. We look forward to helping your family.'),
    ('admissions',N'Your admissions journey',N'Start with an enquiry and our admissions team will help you understand the next steps. An enquiry is not a formal application or an offer of a place. Please contact the team for current entry requirements, fees and availability.'),
    ('visits',N'Visit our school',N'Request a school visit to learn more about our community. Our team will contact you to discuss availability. A visit request is not a confirmed booking.'),
    ('privacy',N'Privacy and your enquiry',N'We collect the contact details and enquiry you provide so our admissions team can respond. Do not include sensitive information or documents about your child in this form. Keep your tracking code private: anyone with the code can see the progress and public updates for your request. Email updates are optional and require confirmation of your email address. You can turn them off on the tracking page. Contact the admissions team for privacy enquiries. The school must publish its approved retention policy, contact details and privacy information here before launch.')
  ) AS seed(slug,title,body)
  WHERE NOT EXISTS (SELECT 1 FROM dbo.AdmissionsPages AS existing WHERE existing.slug=seed.slug);

  IF NOT EXISTS (SELECT 1 FROM dbo.AdmissionsSchema WHERE version=1)
    INSERT dbo.AdmissionsSchema(version) VALUES(1);

  COMMIT TRANSACTION;
  PRINT N'Admissions schema is ready (version 1). Existing data and page content preserved.';
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
