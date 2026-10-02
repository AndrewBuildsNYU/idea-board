// Seals and opens the board's access keys with a password.
//
// The deploy workflow calls seal() with the secrets it can see at build time
// and publishes only the sealed boxes. The browser calls open() with what the
// person typed. A wrong password fails AES-GCM's authentication check, so
// open() returns null rather than garbage.
//
// Shared by the browser and Node (scripts/build.mjs), so it uses nothing but
// Web Crypto, TextEncoder and btoa/atob.

const ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const plain = encoder.encode(JSON.stringify(payload));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
}

export async function open(password, box) {
  if (!box || !password) return null;
  const key = await deriveKey(password, fromBase64(box.salt), box.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv) }, key, fromBase64(box.data));
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}
