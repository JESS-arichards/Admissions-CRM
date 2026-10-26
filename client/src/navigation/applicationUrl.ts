export type JessApplication = 'apps' | 'learn' | 'admissions';

export function applicationUrl(hostname: string, application: JessApplication): string | null {
  const match = /^(?:apps|learn|admissions)(dev)?\.jess\.sch\.ae$/i.exec(hostname);
  if (!match) return null;
  return `https://${application}${match[1] ? 'dev' : ''}.jess.sch.ae/`;
}
