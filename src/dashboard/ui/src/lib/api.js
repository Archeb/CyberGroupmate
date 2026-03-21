/**
 * api.js — REST API helper
 *
 * Reads token from URL params and wraps fetch with auth + JSON handling.
 */

const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';
const API = '/api';

/**
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.body]
 * @param {object} [opts.headers]
 * @returns {Promise<any>}
 */
export async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API}${path}${sep}token=${TOKEN}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

export function getToken() {
  return TOKEN;
}

/** Returns a full API URL for the given path (useful for img src, etc.) */
export function apiBase(path = '') {
  const sep = path.includes('?') ? '&' : '?';
  return `${API}${path}${sep}token=${TOKEN}`;
}
