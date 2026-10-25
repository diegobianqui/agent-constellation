#!/usr/bin/env node
// The relay has one source of truth: the file the lab serves at
// https://diegobianqui.com/relay/constellation-relay.mjs (in the site's repository:
// public/relay/constellation-relay.mjs). The plugin ships a byte-for-byte copy of it in
// plugins/agent-constellation/relay/. Never edit the copy: change the site's file, then run
//
//   node scripts/sync-relay.mjs [<file or URL>]           copy it here
//   node scripts/sync-relay.mjs --check [<file or URL>]   exit 1 if the copy differs
//
// The source defaults to the published file. Pass the path of a site checkout's file to sync
// before the site is deployed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE = 'https://diegobianqui.com/relay/constellation-relay.mjs';
const COPY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'agent-constellation', 'relay', 'constellation-relay.mjs');

const args = process.argv.slice(2);
const check = args.includes('--check');
const source = args.find(a => !a.startsWith('-')) || DEFAULT_SOURCE;

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${src} answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(src);
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const version = b => (/const VERSION = '([^']+)'/.exec(b.toString('utf8')) || [])[1] || '?';

let from;
try { from = await load(source); } catch (err) {
  console.error(`Could not read ${source}: ${err.message}`);
  process.exit(2);
}
if (!/^#!\/usr\/bin\/env node/.test(from.toString('utf8', 0, 32)) || !from.includes('function hookForward')) {
  console.error(`${source} does not look like the constellation relay.`);
  process.exit(2);
}
const current = fs.existsSync(COPY) ? fs.readFileSync(COPY) : Buffer.alloc(0);

if (check) {
  if (sha(from) === sha(current)) {
    console.log(`In sync: relay ${version(current)} (sha256 ${sha(current).slice(0, 12)}).`);
    process.exit(0);
  }
  console.error(`Out of sync: the plugin has relay ${version(current)}, ${source} has ${version(from)}. Run: node scripts/sync-relay.mjs ${source === DEFAULT_SOURCE ? '' : source}`.trim());
  process.exit(1);
}

fs.writeFileSync(COPY, from);
console.log(`Copied relay ${version(from)} (sha256 ${sha(from).slice(0, 12)}) from ${source}.`);
