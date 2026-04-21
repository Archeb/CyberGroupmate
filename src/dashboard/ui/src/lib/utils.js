/**
 * utils.js — Shared utility functions
 */

import { get } from 'svelte/store';
import { appState } from './stores.js';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';

hljs.registerLanguage('json', json);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);

export { hljs };

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract platform from composite ID (e.g. "telegram:123" → "telegram")
 */
export function getPlatform(id) {
  if (!id) return '';
  const s = String(id);
  const idx = s.indexOf(':');
  if (idx > 0 && idx < s.length - 1 && /^[a-z]+$/.test(s.slice(0, idx))) {
    return s.slice(0, idx);
  }
  return '';
}

/**
 * Strip platform prefix from composite ID (e.g. "telegram:123" → "123")
 */
export function stripPlatform(id) {
  if (!id) return '';
  const s = String(id);
  const idx = s.indexOf(':');
  if (idx > 0 && idx < s.length - 1 && /^[a-z]+$/.test(s.slice(0, idx))) {
    return s.slice(idx + 1);
  }
  return s;
}

/**
 * Get platform icon/label for badge display
 */
export function platformIcon(platform) {
  switch (platform) {
    case 'telegram': return '✈️';
    case 'discord': return '🎮';
    case 'onebot': return '🐧';
    default: return '';
  }
}

/**
 * Get short platform label for text display
 */
export function platformLabel(platform) {
  switch (platform) {
    case 'telegram': return 'TG';
    case 'discord': return 'DC';
    case 'onebot': return 'QQ';
    default: return platform.toUpperCase().slice(0, 2);
  }
}

export function shortId(id) {
  if (!id) return '?';
  const s = stripPlatform(String(id));
  return s.length > 15 ? '…' + s.slice(-12) : s;
}

export function getGroupLabel(chatId) {
  const state = get(appState);
  const g = state.groups.find(g => g.chatId === chatId);
  if (g?.chatTitle) return g.chatTitle;
  return shortId(chatId);
}

export function isAtBottom(el) {
  if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
}

export function scrollToBottom(el) {
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * Parse code blocks in text and highlight them (for CodeAct display).
 * Returns HTML string.
 */
export function formatCodeActContent(rawText) {
  const escaped = escapeHtml(rawText);
  const parts = escaped.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (match) {
      const lang = match[1] || 'plaintext';
      const code = match[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      let highlighted;
      try {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        highlighted = escapeHtml(code);
      }
      return `<pre class="code-block"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    }
    return `<span class="whitespace-pre-wrap">${part}</span>`;
  }).join('');
}

/**
 * Render JSON with syntax highlighting into an element
 */
export function renderJsonHighlighted(el, data) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  el.innerHTML = `<code class="language-json hljs">${escapeHtml(jsonStr)}</code>`;
  try {
    hljs.highlightElement(el.querySelector('code'));
  } catch { /* ignore */ }
  scrollToBottom(el);
}

/**
 * Format relative time
 */
export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}
