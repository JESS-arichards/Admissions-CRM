-- Run against the existing Admissions database after version 1, never against the Portal.
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @lock int;
  EXEC @lock = sys.sp_getapplock @Resource=N'admissions-schema', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=30000;
  IF @lock < 0 THROW 50000, 'Could not acquire Admissions migration lock.', 1;
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
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
