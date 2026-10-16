import { CliError, invalidResponse } from './errors.js';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 10000;

export async function request(invocation, path, { method = 'GET', body } = {}) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key || /[\r\n]/.test(key))
    throw new CliError(
      'AUTH_REQUIRED',
      'Set POSTHOG_PERSONAL_API_KEY to a personal API key.',
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${invocation.host}${path}`, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CliError(
        'REDIRECT_REFUSED',
        'PostHog redirected the request. Configure the canonical --host.',
      );
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new CliError(
          'RESPONSE_TOO_LARGE',
          'PostHog response exceeds 2097152 bytes. Narrow the request.',
        );
      }
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (response.ok) throw invalidResponse();
    }
    if (!response.ok) {
      const status = data?.query_status;
      if (
        [400, 500].includes(response.status) &&
        path.startsWith(`/api/projects/${invocation.project}/query/`) &&
        status &&
        (status.error === true ||
          (typeof status.error_message === 'string' &&
            status.error_message.length > 0))
      )
        return data;
      if (
        response.status === 409 &&
        invocation.kind === 'mutation' &&
        ['approval_required', 'change_request_pending'].includes(data?.code)
      ) {
        const reference = data.change_request_id;
        throw new CliError(
          'APPROVAL_REQUIRED',
          'PostHog requires approval. A change request may have been created; inspect it before retrying. The requested flag change is not confirmed applied.',
          1,
          {
            status: 409,
            outcome: 'approval_required',
            ...((typeof reference === 'string' &&
              /^[A-Za-z0-9_-]{1,128}$/.test(reference)) ||
            (Number.isSafeInteger(reference) && reference > 0)
              ? { change_request_id: reference }
              : {}),
          },
        );
      }
      const retry = response.headers.get('retry-after');
      const advice =
        {
          400: 'Check command inputs and SQL, then use scoped --help.',
          401: 'Set POSTHOG_PERSONAL_API_KEY to a valid personal API key for this host.',
          403:
            invocation.kind === 'mutation'
              ? 'Check personal API key read and write permissions and the selected project scope.'
              : 'Check personal API key read permissions and the selected project scope.',
          409: 'The change conflicts with current state or approval policy. Inspect the resource before retrying.',
          404: 'Check the resource ID, --project, and --host.',
        }[response.status] ??
        (response.status >= 500
          ? 'PostHog is temporarily unavailable. Retry later; query POSTs are not retried automatically.'
          : '');
      throw new CliError(
        'HTTP_ERROR',
        `PostHog returned HTTP ${response.status}.${advice ? ` ${advice}` : ''}`,
        1,
        {
          status: response.status,
          ...(response.status === 429
            ? {
                retry: /^\d{1,6}$/.test(retry ?? '')
                  ? `Retry after ${Math.min(Number(retry), 86400)} seconds.`
                  : 'Retry later.',
              }
            : {}),
        },
      );
    }
    return data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      controller.signal.aborted
        ? 'PostHog request timed out after 10000ms.'
        : 'Cannot reach PostHog. Check --host and connectivity.',
    );
  } finally {
    clearTimeout(timer);
  }
}

export function continuation(next, invocation, path, received, spec) {
  if (!next) return null;
  let url;
  try {
    url = new URL(next, invocation.host);
  } catch {
    throw invalidResponse();
  }
  if (
    url.origin !== invocation.host ||
    url.pathname !== path ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new CliError(
      'UNSAFE_PAGINATION',
      'PostHog returned an unsafe continuation URL.',
    );
  }
  const params = new URLSearchParams();
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    const pagination = spec.pagination ?? ['offset'];
    const filterFlag = Object.keys(spec.filters ?? {}).find(
      (flag) => spec.filters[flag] === name,
    );
    if (
      seen.has(name) ||
      !['limit', ...pagination, ...Object.values(spec.filters ?? {})].includes(
        name,
      ) ||
      value.length > 256
    )
      throw invalidResponse();
    if (filterFlag && value !== invocation.flags[filterFlag])
      throw invalidResponse();
    if (
      ['before', 'after'].includes(name) &&
      (!/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw invalidResponse();
    seen.add(name);
    if (
      ['limit', 'offset'].includes(name) &&
      (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    )
      throw invalidResponse();
    if (pagination.includes(name)) params.set(name, value);
  }
  if (![...params.keys()].length) throw invalidResponse();
  for (const name of spec.pagination ?? [])
    if (!params.has(name) && invocation.flags[name])
      params.set(name, invocation.flags[name]);
  if (
    spec.pagination &&
    [...params].every(([name, value]) => invocation.flags[name] === value)
  )
    throw invalidResponse();
  if (params.has('offset') && Number(params.get('offset')) <= invocation.offset)
    throw invalidResponse();
  if (!received) throw invalidResponse();
  return params;
}
