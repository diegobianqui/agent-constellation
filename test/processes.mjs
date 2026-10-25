// For the tests: the relays running in plugin mode on a port, found without `ps` where there is
// none (minimal Linux images have no procps; Windows has no ps at all).
//   Linux: /proc/<pid>/cmdline.   Windows: Win32_Process through PowerShell.   macOS: ps.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function commandLines() {
  if (process.platform === 'linux') {
    const out = [];
    for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
      try { out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') }); } catch { /* gone */ }
    }
    return out;
  }
  if (process.platform === 'win32') {
    const ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: 'utf8', windowsHide: true });
    return ps.split(/\r?\n/).filter(Boolean).map(l => { const i = l.indexOf('\t'); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1).trim() }; });
  }
  const ps = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').filter(Boolean).map(l => { const t = l.trim(); const i = t.search(/\s/); return { pid: Number(t.slice(0, i)), cmd: t.slice(i + 1) }; });
}

/** PIDs of relays started in plugin mode on this port (`... constellation-relay.mjs --plugin --port <port>`). */
export function relayPids(port) {
  // On Windows the command line has the script quoted ("C:\...\constellation-relay.mjs" --plugin ...).
  const re = new RegExp(`constellation-relay\\.mjs"? --plugin --port ${port}(\\s|$)`);
  return commandLines().filter(p => p.pid !== process.pid && re.test(p.cmd)).map(p => p.pid);
}
