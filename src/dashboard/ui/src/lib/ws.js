/**
 * ws.js — WebSocket connection manager
 *
 * Auto-reconnects. Dispatches events to update stores.
 */

import { getToken } from './api.js';
import {
  wsStatus, appState, messages, llmLogs, llmStats,
  addMessage, handleLLMCall, handleLLMResponse, handleLLMRetry, handleLLMInit, setTokenPricing,
  handleCodeActProgress, handleRecordingEvent,
} from './stores.js';
import { get } from 'svelte/store';

let ws = null;

export function connectWS() {
  const token = getToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?token=${token}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    wsStatus.set('connected');
  };

  ws.onclose = () => {
    wsStatus.set('disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      handleEvent(event);
    } catch { /* ignore */ }
  };
}

/** 发送命令到服务端（如 llm:cancel） */
export function sendCommand(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'snapshot': {
      const data = event.data;
      // Normalize queue format
      if (Array.isArray(data.queue)) {
        data.queue = { active: data.queue, dequeued: [] };
      }
      appState.set(data);
      // Token pricing config
      if (data.tokenPricing) {
        setTokenPricing(data.tokenPricing);
      }
      break;
    }
    case 'nc:message':
      addMessage(event.data, event.timestamp);
      break;
    case 'queue:update': {
      appState.update(s => {
        if (Array.isArray(event.data)) {
          s.queue = { active: event.data, dequeued: s.queue?.dequeued || [] };
        } else {
          s.queue = event.data;
        }
        return s;
      });
      break;
    }
    case 'llm:call':
      handleLLMCall(event.data);
      break;
    case 'llm:response':
      handleLLMResponse(event.data);
      break;
    case 'llm:retry':
      handleLLMRetry(event.data);
      break;
    case 'llm:init':
      handleLLMInit(event.data);
      break;
    case 'codeact:progress':
      handleCodeActProgress(event.data);
      break;
    case 'recording:flush-start':
    case 'recording:flush-complete':
    case 'recording:flush-error':
    case 'recording:triage-passed':
      handleRecordingEvent({ ...event.data, _type: event.type, _timestamp: event.timestamp });
      break;
  }
}
