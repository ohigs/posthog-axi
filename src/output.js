import { encode } from '@toon-format/toon';
import { CliError } from './errors.js';

export const secretKey =
  /(?:api[_-]?(?:key|token)|personal[_-]?api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)/i;
export function clean(value, full = false, depth = 0) {
  if (depth > 30)
    throw new CliError(
      'OUTPUT_TOO_DEEP',
      'Output nesting exceeds 30 levels. Select shallower fields.',
    );
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (typeof value === 'string') {
    const safe = (key ? value.split(key).join('[REDACTED]') : value).replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
    if (!full && safe.length > 300)
      return {
        preview: safe.slice(0, 300),
        characters: safe.length,
        hint: 'Use --full for untruncated content.',
      };
    return safe;
  }
  if (Array.isArray(value))
    return value.map((item) => clean(item, full, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        clean(name, true, depth),
        secretKey.test(name) ? '[REDACTED]' : clean(item, full, depth + 1),
      ]),
    );
  return value;
}
export function serialize(value, invocation) {
  const safe = clean(value, true);
  const output = invocation.flags.json ? JSON.stringify(safe) : encode(safe);
  if (Buffer.byteLength(output) > 524288)
    throw new CliError(
      'OUTPUT_TOO_LARGE',
      'Output exceeds 524288 bytes. Select fewer fields or rows.',
    );
  return output;
}
export function projectItem(item, fields, full) {
  return Object.fromEntries(
    fields.map((field) => [field, clean(item[field] ?? null, full)]),
  );
}
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
