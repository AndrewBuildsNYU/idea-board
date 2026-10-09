// Live updates between everyone who has the board open, over one WebSocket
// to the board's own server (/api/live).
//
// The server sends every saved change the moment it's saved, to everyone who
// can see it. It also passes along what people do but don't save: who's
// here, notes being dragged and pen strokes being drawn. Nothing here is the
// record; if the connection drops, the board carries on by polling and this
// reconnects in the background.
//
// The session key goes as the second WebSocket subprotocol rather than in
// the address, so it never lands in a log.

const PROTOCOL = 'fedi-boards';
const MAX_PAYLOAD = 120000;
// The server closes with this code when the session has ended.
const SIGNED_OUT = 4001;

export class Live {
  // `onMessage(message)` gets every message from the server or somebody
  // else; `onStatus(status)` gets 'connecting', 'live' or 'offline'.
  constructor({ token, onMessage, onStatus }) {
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.stopped = false;
    this.failures = 0;
    this.retryTimer = null;
  }

  async start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // Already gone.
      }
    }
    this.ws = null;
  }

  connect() {
    if (this.stopped) return;
    this.onStatus(this.failures ? 'offline' : 'connecting');
    const url = new URL('/api/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(url, [PROTOCOL, this.token]);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.onStatus('live');
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && typeof message.t === 'string') this.onMessage(message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (event.code === SIGNED_OUT) {
        this.stopped = true;
        this.onMessage({ t: 'signed-out' });
        return;
      }
      this.retry();
    };
  }

  retry() {
    if (this.stopped) return;
    this.failures++;
    this.onStatus('offline');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)) * (0.75 + Math.random() * 0.5);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  // Resolves false when the message wasn't sent (not connected, or too big),
  // so the caller can fall back to a refresh hint.
  send(message) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const data = JSON.stringify(message);
    if (data.length > MAX_PAYLOAD) return Promise.resolve(false);
    try {
      ws.send(data);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
}
