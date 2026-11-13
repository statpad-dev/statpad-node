import { readFileSync } from 'node:fs';

const allowed = /^(dist\/.+|README\.md|LICENSE|package\.json)$/;

const output = JSON.parse(readFileSync(0, 'utf8'));
const [pack] = Array.isArray(output) ? output : Object.values(output);
const files = pack.files.map((file) => file.path).sort();
const unexpected = files.filter((path) => !allowed.test(path));

console.log(`${pack.filename}: ${files.length} files, ${pack.size} bytes packed`);
for (const path of files) console.log(`  ${path}`);
if (unexpected.length > 0 || !files.includes('dist/index.js') || !files.includes('dist/index.d.ts')) {
  console.error(`unexpected tarball contents: ${unexpected.join(', ') || 'missing dist/index.js or dist/index.d.ts'}`);
  process.exit(1);
}
