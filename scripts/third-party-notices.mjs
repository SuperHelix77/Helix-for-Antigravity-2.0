import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'LICENSES'); fs.mkdirSync(output, {recursive: true});
const entries = [
  ['ibm-plex-sans', '@fontsource/ibm-plex-sans', 'LICENSE'],
  ['react', 'react', 'LICENSE'], ['react-dom', 'react-dom', 'LICENSE'],
  ['lucide-react', 'lucide-react', 'LICENSE'], ['electron', 'electron', 'LICENSE'],
];
const manifest = entries.map(([name, packageName, license]) => {
  const directory = path.join(root, 'node_modules', packageName);
  const meta = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const bytes = fs.readFileSync(path.join(directory, license)), file = `${name}.txt`;
  fs.writeFileSync(path.join(output, file), bytes);
  return {package: packageName, version: meta.version, license: meta.license, file, sha256: createHash('sha256').update(bytes).digest('hex')};
});
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Preserved ${manifest.length} exact dependency license notices.`);
