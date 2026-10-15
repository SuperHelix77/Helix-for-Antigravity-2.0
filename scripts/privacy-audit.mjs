import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const findings = [], sources = [];
for (const file of [...new Set(files)].sort()) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) { findings.push(`${file}: not a regular release file`); continue; }
  if (/(?:^|\/)(?:auth\.json|endpoint\.json|monitor\.json|config\.toml|\.env(?:\..*)?|id_rsa|credentials[^/]*)$|\.(?:sqlite[0-9]*|db|log|jsonl)(?:-|$)/i.test(file)) findings.push(`${file}: prohibited private artifact name`);
  const bytes = fs.readFileSync(file);
  sources.push({file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length});
  if (/\.(?:png|woff2?|ico|icns)$/.test(file)) continue;
  const text = new TextDecoder('utf8', {fatal: true}).decode(bytes);
  const rules = [
    ['personal absolute path', /\/Users\/[a-zA-Z0-9._-]+\//g],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['provider key', /\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}\b/g],
    ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/g],
    ['JWT bearer', /Bearer\s+eyJ[a-zA-Z0-9_.-]{30,}/g],
    ['private model/session content', /"safety_identifier"\s*:\s*"user-|"access_token"\s*:\s*"[^"\n]{20,}/g],
  ];
  for (const [label, pattern] of rules) if (pattern.test(text)) findings.push(`${file}: ${label}`);
}
let generatedFiles = 0;
if (fs.existsSync('dist')) for (const relative of fs.readdirSync('dist', {recursive: true})) {
  if (!/\.js$/.test(relative)) continue;
  const file = path.join('dist', relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) { findings.push(`${file}: unsafe generated file`); continue; }
  generatedFiles++;
  const text = fs.readFileSync(file, 'utf8');
  if (/jsxDEV|jsx-dev-runtime|react\.development/.test(text)) findings.push(`${file}: development transform in release build`);
  if (/\/Users\/[a-zA-Z0-9._-]+\/|[A-Za-z]:\\\\Users\\\\[^\\]+\\\\/.test(text)) findings.push(`${file}: personal absolute path in generated build`);
}
if (findings.length) { for (const issue of findings) console.error(issue); process.exitCode = 1; }
else console.log(JSON.stringify({schema: 'helix.privacy-scan.v1', status: 'pass', scanned_files: sources.length,
  generated_js_scanned: generatedFiles,
  source_set_sha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
  scope: 'Mechanical current release file scan. Requires separate semantic/privacy/license review; not a universal guarantee.'}));
