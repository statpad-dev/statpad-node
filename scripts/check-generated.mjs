import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const changed = git('status', '--porcelain', '--untracked-files=all', '--', 'src/generated')
  .split('\n')
  .filter((line) => line && !/^[AM] /.test(line));
if (changed.length > 0) {
  console.error('src/generated is out of date with openapi.yaml; run npm run generate and commit the result:');
  console.error(changed.join('\n'));
  console.error(git('diff', '--', 'src/generated'));
  process.exit(1);
}
