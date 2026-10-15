import { invalidResponse } from './errors.js';
import { isObject, validQueryId } from './resources.js';
import { clean, quote, secretKey } from './output.js';

export function decodeQuery(data, invocation) {
  if (!isObject(data)) throw invalidResponse();
  if (data.query_status != null) {
    const status = data.query_status;
    if (
      !isObject(status) ||
      typeof status.id !== 'string' ||
      !validQueryId(status.id) ||
      ![true, false, null, undefined].includes(status.complete) ||
      ![true, false, null, undefined].includes(status.error) ||
      (status.error_message != null && typeof status.error_message !== 'string')
    )
      throw invalidResponse();
    if (status.error === true || status.error_message)
      return {
        state: 'failed',
        id: status.id,
        message: 'PostHog query failed. Inspect the query in PostHog.',
      };
    if (status.complete !== true)
      return {
        state: 'pending',
        id: status.id,
        next: `posthog-axi query status ${quote(status.id)} --host ${quote(invocation.host)} --project ${quote(invocation.project)} --limit ${invocation.limit}${invocation.flags.json ? ' --json' : ''}${invocation.flags.full ? ' --full' : ''}`,
      };
    return complete(status.results, invocation);
  }
  if (invocation.kind === 'query-status') throw invalidResponse();
  return complete(data, invocation);
}
function complete(data, invocation) {
  const { limit } = invocation;
  if (
    !isObject(data) ||
    !Array.isArray(data.results) ||
    !data.results.every(Array.isArray) ||
    (data.hasMore != null && typeof data.hasMore !== 'boolean')
  )
    throw invalidResponse();
  const columns =
    data.columns ??
    Array.from(
      { length: data.results[0]?.length ?? 0 },
      (_, index) => `column_${index + 1}`,
    );
  if (
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === 'string') ||
    !data.results.every((row) => row.length === columns.length)
  )
    throw invalidResponse();
  return {
    state: 'complete',
    columns,
    rows: clean(
      data.results
        .slice(0, limit)
        .map((row) =>
          row.map((cell, index) =>
            secretKey.test(columns[index]) ? '[REDACTED]' : cell,
          ),
        ),
      invocation.flags.full,
    ),
    returned: Math.min(limit, data.results.length),
    received: data.results.length,
    backend_has_more: data.hasMore ?? null,
    truncated: data.results.length > limit || data.hasMore === true,
    message:
      data.hasMore === true
        ? 'PostHog reports more rows. Narrow the SQL and time range to obtain a complete result.'
        : data.results.length === 0
          ? 'Query completed with zero rows.'
          : data.results.length > limit
            ? 'Displayed rows are capped. Use a SQL LIMIT and time range to bound computation.'
            : 'Query completed.',
  };
}
