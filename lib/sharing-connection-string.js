'use strict';

/**
 * Trim, validate, and return a Mongo connection string.
 * Throws on empty, non-string, or unsupported scheme.
 */
function normalizeConnectionString(input) {
  if (typeof input !== 'string') {
    throw new Error('Connection string must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Connection string is empty');
  }
  if (!trimmed.startsWith('mongodb://') && !trimmed.startsWith('mongodb+srv://')) {
    throw new Error('Connection string must start with mongodb:// or mongodb+srv://');
  }
  return trimmed;
}

/**
 * Extract the host(s) portion of a connection string for display.
 * Strips userinfo (user:password@) and everything after the host list.
 * Returns "(invalid)" if the input can't be parsed.
 */
function redactHost(cs) {
  if (typeof cs !== 'string' || !cs) return '(invalid)';
  const match = cs.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  if (!match) return '(invalid)';
  return match[1];
}

module.exports = { normalizeConnectionString, redactHost };
