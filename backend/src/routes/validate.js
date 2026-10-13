

const REQUIRED_TEXT_FIELDS = ['sample_id', 'patient', 'analyte', 'unit', 'instrument', 'reagent_lot', 'timestamp'];
const REQUIRED_NUMBER_FIELDS = ['value', 'h_index', 'i_index', 'l_index'];

const TIMESTAMP_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validateMessage(msg) {
  const errors = [];

  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return ['message is not a JSON object'];
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (msg[field] === undefined || msg[field] === null || msg[field] === '') {
      errors.push('missing field: ' + field);
    } else if (typeof msg[field] !== 'string') {
      errors.push(field + ' must be a string');
    }
  }

  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (msg[field] === undefined || msg[field] === null || msg[field] === '') {
      errors.push('missing field: ' + field);
    } else if (typeof msg[field] !== 'number' || !Number.isFinite(msg[field])) {
      errors.push(field + ' must be a number');
    }
  }

  for (const field of ['h_index', 'i_index', 'l_index']) {
    if (typeof msg[field] === 'number' && msg[field] < 0) {
      errors.push(field + ' cannot be negative');
    }
  }

  if (typeof msg.timestamp === 'string') {
    if (!TIMESTAMP_WITH_TZ.test(msg.timestamp)) {
      errors.push('timestamp must be ISO 8601 with a timezone (e.g. 2026-03-04T09:15:22+05:30)');
    } else if (isNaN(new Date(msg.timestamp).getTime())) {
      errors.push('timestamp is not a real date');
    }
  }

  if (typeof msg.patient === 'string' && !/^P-[A-Za-z0-9]+$/.test(msg.patient)) {
    errors.push('patient must be a pseudonym like P-1234');
  }

  if (msg.instrument_flags !== undefined) {
    if (!Array.isArray(msg.instrument_flags)) {
      errors.push('instrument_flags must be a list');
    }
  }

  return errors;
}

module.exports = { validateMessage };
