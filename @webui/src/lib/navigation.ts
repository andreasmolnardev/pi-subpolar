export function getSessionListPath(projectId: string | number, tab?: string): string {
  const base = `/projects/${String(projectId)}`;
  if (tab && tab !== 'project') {
    return `${base}?projectTab=${tab}`;
  }
  return base;
}

function isSafeInternalPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//');
}

export function getPathWithReturnTo(path: string, returnTo: string): string {
  if (!isSafeInternalPath(returnTo)) return path;
  const [base, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('returnTo', returnTo);
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

export function getReturnToPath(search: string, fallback: string): string {
  const returnTo = new URLSearchParams(search).get('returnTo');
  return returnTo && isSafeInternalPath(returnTo) ? returnTo : fallback;
}

export function getSwipeBackTarget(pathname: string, search = ''): string | null {
  const sessionDetailRegex = /^\/projects\/([^/]+)\/sessions\/[^/]+$/;
  const match = pathname.match(sessionDetailRegex);

  if (match) {
    const projectId = match[1];
    const params = new URLSearchParams(search);
    const tab = params.get('projectTab') ?? undefined;
    return getSessionListPath(projectId, tab);
  }

  if (/^\/projects\/[^/]+$/.test(pathname)) {
    return '/';
  }

  if (/^\/projects\/[^/]+\/automations$/.test(pathname)) {
    const returnTo = getReturnToPath(search, '');
    if (returnTo) return returnTo;
    const projectId = pathname.split('/')[2];
    return `/projects/${projectId}`;
  }

  if (pathname === '/automations') {
    return '/';
  }

  if (pathname === '/' || pathname === '/login' || pathname === '/setup' || pathname === '/register') {
    return null;
  }

  return null;
}
