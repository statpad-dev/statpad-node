import { Statpad, StatpadError } from '../dist/index.js';

const statpad = new Statpad({ apiKey: '', maxRetries: 0 });

try {
  await statpad.leagues.listLeagues();
  console.error('expected a StatpadError, but the request succeeded');
  process.exit(1);
} catch (error) {
  if (!(error instanceof StatpadError) || error.code !== 'unauthorized') throw error;
  const { status, code, title, detail, type, requestId } = error;
  console.log(`${error.name}: ${error.message}`);
  console.log(JSON.stringify({ status, code, title, detail, type, requestId }, null, 2));
}
