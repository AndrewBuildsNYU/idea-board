// Builds the published site into dist/.
//
// Copies site/ as-is and writes dist/vault.json: the member key sealed with
// the team password, and the admin key sealed with the admin password. The
// passwords, tokens and names come from environment variables (GitHub
// Actions secrets in production) and never reach dist/ in readable form.
//
// If a secret is missing the site still deploys, in a "not set up yet" state,
// so a first push before the keys exist is not a failed run.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { seal } from '../site/vault.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = `${root}site`;
const dist = `${root}dist`;

const REQUIRED = ['BOARD_PASSWORD', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'ALLOWED_NAMES', 'MEMBER_TOKEN', 'ADMIN_TOKEN', 'DATA_REPO'];

export function parseNames(text) {
  const seen = new Set();
  const names = [];
  for (const line of String(text || '').split(/[\n,]/)) {
    const name = line.replace(/^\s*[-*]\s+/, '').trim().replace(/\s+/g, ' ');
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

async function main() {
  const env = process.env;
  const missing = REQUIRED.filter((key) => !String(env[key] || '').trim());

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(site, dist, { recursive: true });

  if (missing.length) {
    console.log(`::warning::Deployed in setup mode; nobody can sign in yet. Missing secrets: ${missing.join(', ')}`);
    await writeFile(`${dist}/vault.json`, JSON.stringify({ v: 1, pending: true }));
    return;
  }

  const names = parseNames(env.ALLOWED_NAMES);
  const adminName = env.ADMIN_NAME.trim();
  if (!names.some((name) => name.toLowerCase() === adminName.toLowerCase())) names.push(adminName);
  const repo = env.DATA_REPO.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('DATA_REPO must look like owner/repository.');

  const member = await seal(env.BOARD_PASSWORD, { repo, token: env.MEMBER_TOKEN.trim(), names, admin: adminName });
  const admin = await seal(env.ADMIN_PASSWORD, { repo, token: env.ADMIN_TOKEN.trim() });
  await writeFile(`${dist}/vault.json`, JSON.stringify({ v: 1, member, admin }));
  // Actions logs on a public repository are public: print a count, never names.
  console.log(`Sealed the board for ${names.length} ${names.length === 1 ? 'person' : 'people'}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
