// Shape-only validator for the QQ <-> Life EventEnvelope described in CONTRACT.md v0.1.
// Pure, synchronous, dependency-free. It does not authenticate, authorize, deduplicate,
// transport or replay events; it only checks the envelope's documented shape and timestamps.

const EVENT_TYPES = new Set([
  'qq.message.observed',
  'qq.delivery.updated',
  'qq.scene.activity.changed',
  'activity.status.changed',
]);

const REQUIRED_STRING_FIELDS = [
  'eventId',
  'type',
  'personaId',
  'sceneId',
  'occurredAt',
  'observedAt',
  'sourceRef',
  'dataScopeRef',
];

const TIMESTAMP_FIELDS = ['occurredAt', 'observedAt'];

const OPTIONAL_REFERENCE_FIELDS = ['payloadRef', 'correlationId', 'causationId'];

const KNOWN_FIELDS = new Set([
  'schemaVersion',
  ...REQUIRED_STRING_FIELDS,
  ...OPTIONAL_REFERENCE_FIELDS,
]);

// YYYY-MM-DDTHH:mm:ss[.sss]Z -- UTC only, no date-only values, no offsets.
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

const isNonArrayObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const isNonBlankString = (value) => typeof value === 'string' && value.trim() !== '';

const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7]);

  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  if (millisecond > 999) return false;
  return true;
}

/**
 * Validate an EventEnvelope-shaped value.
 *
 * @param {unknown} value candidate envelope
 * @returns {string[]} deterministic, human-readable errors; an empty array means valid
 */
export function validateEnvelope(value) {
  if (!isNonArrayObject(value)) {
    return ['EventEnvelope must be a non-null, non-array object.'];
  }

  const errors = [];

  for (const key of Object.keys(value).sort()) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push(
        `Unknown top-level field "${key}" is not part of the EventEnvelope contract.`,
      );
    }
  }

  if (!hasOwn(value, 'schemaVersion') || value.schemaVersion !== 1) {
    errors.push('Field "schemaVersion" must be exactly the number 1.');
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!hasOwn(value, field)) {
      errors.push(`Field "${field}" is required and must be a nonblank string.`);
    } else if (!isNonBlankString(value[field])) {
      errors.push(`Field "${field}" must be a nonblank string.`);
    }
  }

  if (typeof value.type === 'string' && value.type.trim() !== '' && !EVENT_TYPES.has(value.type)) {
    errors.push(
      `Field "type" must be one of: ${[...EVENT_TYPES].map((type) => `"${type}"`).join(', ')}.`,
    );
  }

  for (const field of TIMESTAMP_FIELDS) {
    const candidate = value[field];
    if (isNonBlankString(candidate) && !isUtcTimestamp(candidate)) {
      errors.push(
        `Field "${field}" must be a real UTC calendar timestamp in the form YYYY-MM-DDTHH:mm:ss[.sss]Z.`,
      );
    }
  }

  for (const field of OPTIONAL_REFERENCE_FIELDS) {
    if (hasOwn(value, field) && !isNonBlankString(value[field])) {
      errors.push(`Field "${field}", when present, must be a nonblank string.`);
    }
  }

  return errors;
}
