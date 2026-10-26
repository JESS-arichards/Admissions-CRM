export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiError(`The server is unavailable or returned an unreadable response (${response.status}). Please try again or contact Admissions.`, response.status);
    }
    const content: unknown = await response.json();
    const message = typeof content === 'object' && content !== null && 'error' in content && typeof content.error === 'string'
      ? content.error : 'The request failed. Please try again.';
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'An unexpected error occurred.';
