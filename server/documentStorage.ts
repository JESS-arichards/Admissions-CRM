import { BlobServiceClient } from '@azure/storage-blob';
import { config } from './config.js';
import { HttpError, logger } from './errors.js';

const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'RestError', 'AbortError', 'TimeoutError',
  'AggregateAuthenticationError', 'AuthenticationError', 'CredentialUnavailableError']);
const errorCodes = new Set(['AuthenticationFailed', 'AuthorizationFailure', 'AuthorizationPermissionMismatch',
  'BlobNotFound', 'ContainerNotFound', 'InvalidResourceName', 'AccountIsDisabled', 'PublicAccessNotPermitted',
  'ConditionNotMet', 'BlobAlreadyExists', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'REQUEST_SEND_ERROR', 'PARSE_ERROR']);
function storageFailure(operation: 'configure' | 'readiness' | 'upload' | 'delete' | 'download', error: unknown) {
  const value = typeof error === 'object' && error !== null ? error : {};
  const status = 'statusCode' in value ? value.statusCode : undefined;
  const code = 'code' in value ? value.code : undefined;
  const name = error instanceof Error ? error.name : undefined;
  // Azure exceptions can contain signed URLs in message, stack, request, and even arbitrary names/codes.
  logger.error({
    operation,
    statusCode: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
    errorCode: typeof code === 'string' && errorCodes.has(code) ? code : 'Unknown',
    errorType: typeof name === 'string' && errorTypes.has(name) ? name : 'Unknown',
  }, 'Private document storage operation failed.');
}

function container() {
  try {
    const service = config.AZURE_STORAGE_CONNECTION_STRING
      ? BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING, { retryOptions: { maxTries: 2, tryTimeoutInMs: 30000 } })
      : null;
    if (!service) {
      logger.warn({ operation: 'configure', reason: 'not_configured' }, 'Private document uploads/downloads are disabled; set AZURE_STORAGE_CONNECTION_STRING to enable them. Enquiries remain available.');
      return null;
    }
    return service.getContainerClient(config.AZURE_STORAGE_CONTAINER ?? 'admissions-files');
  } catch (error) { storageFailure('configure', error); return null; }
}
const client = container();
const unavailable = () => new HttpError(503, 'Private document storage is unavailable. Please contact Admissions.');

export async function storageReady(): Promise<boolean> {
  if (!client) return false;
  try {
    // Never accept a container configured for anonymous access, even if the account currently blocks it.
    const properties = await client.getProperties();
    if (properties.blobPublicAccess) {
      logger.warn({ operation: 'readiness', reason: 'public_container' }, 'Private document storage rejected an anonymously accessible container.');
      return false;
    }
    return true;
  } catch (error) { storageFailure('readiness', error); return false; }
}
export async function requireStorage() {
  if (!await storageReady()) throw unavailable();
}
export async function uploadBlob(name: string, bytes: Buffer, mimeType: string) {
  await requireStorage();
  try {
    await client!.getBlockBlobClient(name).uploadData(bytes, {
      concurrency: 1, maxSingleShotSize: 10 * 1024 * 1024,
      conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: mimeType, blobCacheControl: 'private, no-store' },
    });
  } catch (error) { storageFailure('upload', error); throw unavailable(); }
}
export async function deleteBlob(name: string) {
  if (!client) throw unavailable();
  try { await client.getBlockBlobClient(name).deleteIfExists(); }
  catch (error) { storageFailure('delete', error); throw unavailable(); }
}
export async function downloadBlob(name: string) {
  await requireStorage();
  let stream: NodeJS.ReadableStream | undefined;
  try {
    const result = await client!.getBlockBlobClient(name).download();
    stream = result.readableStreamBody;
  } catch (error) { storageFailure('download', error); throw unavailable(); }
  if (!stream) {
    logger.error({ operation: 'download', reason: 'missing_stream' }, 'Private document storage returned no download stream.');
    throw unavailable();
  }
  stream.on('error', (error) => storageFailure('download', error));
  return stream;
}
