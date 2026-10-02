// Live updates between everyone who has the board open.
//
// GitHub can't push changes to a web page, and its lists trail its writes by
// seconds. So alongside GitHub, which stays the record, every change is also
// relayed through a public MQTT broker over a WebSocket: the moment one
// person saves, everyone else's board applies it, and the next poll of GitHub
// confirms it. Drags and pen strokes in progress go the same way, so people
// see each other working.
//
// The broker is a free public one that anyone can connect to, so nothing
// readable goes through it. The channel name and the AES-GCM key are both
// derived from the board's access key, which only people who know the team
// password can unseal, and anything that doesn't decrypt with it is dropped.
// If no broker can be reached, the board carries on by polling GitHub.
//
// This is a minimal MQTT 3.1.1 client: connect, subscribe, publish and ping
// at QoS 0. Messages may be lost; nothing here is the record.

// Two independent public brokers; the second is used when the first fails.
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const KEEPALIVE_S = 60;
const PING_MS = 25000;
const MAX_PAYLOAD = 120000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function mqttString(text) {
  const bytes = encoder.encode(text);
  return concat(new Uint8Array([bytes.length >> 8, bytes.length & 255]), bytes);
}

function remainingLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    out.push(byte);
  } while (n > 0);
  return new Uint8Array(out);
}

function packet(type, body) {
  return concat(new Uint8Array([type]), remainingLength(body.length), body);
}

export class Live {
  // `secret` is shared by everyone on the board; `onMessage(message)` gets
  // every message from somebody else; `onStatus(status)` gets 'connecting',
  // 'live' or 'offline'.
  constructor({ secret, onMessage, onStatus }) {
    this.secret = secret;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.id = randomId(6);
    this.ws = null;
    this.buffer = new Uint8Array(0);
    this.ready = false;
    this.stopped = false;
    this.failures = 0;
    this.broker = 0;
    this.pingTimer = null;
    this.retryTimer = null;
  }

  async start() {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`idea-board-live-key|${this.secret}`));
    this.key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const topic = await crypto.subtle.digest('SHA-256', encoder.encode(`idea-board-live-topic|${this.secret}`));
    this.topic = `idea-board/v1/${hex(topic).slice(0, 40)}`;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        if (this.ready) this.ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        this.ws.close();
      } catch {
        // Already gone.
      }
    }
    this.ready = false;
  }

  connect() {
    if (this.stopped) return;
    this.onStatus(this.failures ? 'offline' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(BROKERS[this.broker % BROKERS.length], 'mqtt');
    } catch {
      this.retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buffer = new Uint8Array(0);
    ws.onopen = () => {
      const clientId = `ib-${randomId(8)}`;
      const body = concat(
        mqttString('MQTT'),
        new Uint8Array([4, 0x02, KEEPALIVE_S >> 8, KEEPALIVE_S & 255]), // level 4, clean session
        mqttString(clientId),
      );
      ws.send(packet(0x10, body));
    };
    ws.onmessage = (event) => this.feed(new Uint8Array(event.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      clearInterval(this.pingTimer);
      this.retry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // onclose follows either way.
      }
    };
  }

  retry() {
    if (this.stopped) return;
    this.failures++;
    // After a couple of failures, try the other broker.
    if (this.failures % 2 === 0) this.broker++;
    this.onStatus('offline');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)) * (0.75 + Math.random() * 0.5);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  feed(bytes) {
    this.buffer = concat(this.buffer, bytes);
    for (;;) {
      if (this.buffer.length < 2) return;
      let length = 0;
      let multiplier = 1;
      let index = 1;
      let byte;
      do {
        if (index >= this.buffer.length) return;
        byte = this.buffer[index++];
        length += (byte & 127) * multiplier;
        multiplier *= 128;
      } while (byte & 128);
      if (this.buffer.length < index + length) return;
      const type = this.buffer[0];
      const body = this.buffer.slice(index, index + length);
      this.buffer = this.buffer.slice(index + length);
      this.handle(type, body);
    }
  }

  handle(type, body) {
    const kind = type >> 4;
    if (kind === 2) {
      // CONNACK
      if (body[1] !== 0) {
        this.ws.close();
        return;
      }
      const subscribe = concat(new Uint8Array([0, 1]), mqttString(this.topic), new Uint8Array([0]));
      this.ws.send(packet(0x82, subscribe));
    } else if (kind === 9) {
      // SUBACK
      this.ready = true;
      this.failures = 0;
      this.onStatus('live');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ready) this.ws.send(new Uint8Array([0xc0, 0x00]));
      }, PING_MS);
    } else if (kind === 3) {
      // PUBLISH
      const topicLength = (body[0] << 8) | body[1];
      let offset = 2 + topicLength;
      if ((type >> 1) & 3) offset += 2; // a packet id, only present above QoS 0
      this.receive(body.slice(offset));
    }
  }

  async receive(payload) {
    if (payload.length < 13) return;
    let message;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, this.key, payload.slice(12));
      message = JSON.parse(decoder.decode(plain));
    } catch {
      return; // Not ours, or damaged.
    }
    if (!message || message.from === this.id) return;
    this.onMessage(message);
  }

  // Fire and forget, in order: encryption is async, and a drag's positions
  // arriving out of order would make the note jitter on everyone else's
  // screen. Resolves false when the message wasn't sent (not connected, or
  // too big), so the caller can fall back to a refresh hint.
  send(message) {
    const next = (this.queue || Promise.resolve()).then(() => this.sendNow(message));
    this.queue = next.catch(() => false);
    return next;
  }

  async sendNow(message) {
    if (!this.ready || !this.key) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = encoder.encode(JSON.stringify({ ...message, from: this.id }));
    if (plain.length > MAX_PAYLOAD) return false;
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain));
    if (!this.ready) return false;
    try {
      this.ws.send(packet(0x30, concat(mqttString(this.topic), iv, sealed)));
      return true;
    } catch {
      return false;
    }
  }
}
