# @statpad/sdk

TypeScript client for the [Statpad](https://statpad.dev) live sports data API. It is generated
from the API's OpenAPI spec, has no runtime dependencies and runs anywhere `fetch` does (Node 20+,
Deno, Bun, browsers and workers). The full API reference is at <https://statpad.dev/docs>.

## Install

```sh
npm install @statpad/sdk
```

## Quickstart

List tonight's NBA games:

```ts
import { Statpad } from '@statpad/sdk';

const statpad = new Statpad({ apiKey: process.env.STATPAD_API_KEY! });

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const { data: page } = await statpad.games.listGames({ path: { league: 'nba' }, query: { date: today } });

const teams = new Map(page.teams.map((team) => [team.id, team]));
for (const game of page.data) {
  console.log(`${teams.get(game.away_team_id)?.name} at ${teams.get(game.home_team_id)?.name}`, game.scheduled_at);
}
```

Operations are grouped by API tag: `leagues`, `games`, `playByPlay`, `statistics`, `teams`,
`players`, `leagueNews` and `changes`. Each call takes `path`, `query` and `headers` and resolves
to `{ data, request, response }`. Every schema is exported as a type (`Game`, `Team`, `Problem`,
`ErrorCode`, ...). Options: `apiKey` (required), `baseUrl` (default `https://api.statpad.dev`),
`fetch` and `maxRetries` (default 2).

## Errors

A response other than 2xx or 304 throws a `StatpadError` built from the
[problem details](https://statpad.dev/docs) body: `status`, `code`, `title`, `detail`, `type`,
`requestId`, `retryAfter` (seconds, from `Retry-After`), `resetsAt` (with `quota_exhausted`) and
`minSeq` (with `resync_required`).

```ts
import { StatpadError } from '@statpad/sdk';

try {
  await statpad.games.getGame({ path: { league: 'nfl', game_id: id } });
} catch (error) {
  if (error instanceof StatpadError && error.code === 'not_found') {
    // ...
  }
  throw error;
}
```

A 304 doesn't throw: when you send `If-None-Match`, check `response.status === 304` before reading
`data`, which is then `undefined`. A network error that outlasts its retries is rethrown as is.

## Retries

A 429 `rate_limited`, a 500, a 503 and a network error are retried up to `maxRetries` times, after
`Retry-After` when the response has one and otherwise after an exponential backoff with jitter. A
429 `quota_exhausted` throws at once, because the allowance only comes back when the period renews
(`resetsAt`). Every operation is a GET, so retrying is safe. Pass `maxRetries: 0` to turn it off.

## Pagination

`paginate` follows `next_cursor` until it is null. It yields whole pages rather than items, because
pages carry the teams or players they reference and, for game-scoped lists, `seq`.

```ts
import { paginate } from '@statpad/sdk';

for await (const page of paginate(statpad.playByPlay.listPlays, { path: { league: 'nfl', game_id: id } })) {
  for (const play of page.data) console.log(play.description);
}
```

It only accepts operations whose response has `next_cursor`.

## The changes feed

`changes.listGameChanges` is a game's change journal, the same changes the WebSocket stream
`game:<id>` carries. It pages by `after_seq` rather than a cursor, so `paginate` doesn't take it: poll
with the last seq you applied, starting from the `seq` a game read returns. A position older than
the retained history throws `StatpadError` with code `resync_required` and `minSeq`; fetch the game
again and continue from its `seq`.

```ts
const { data: detail } = await statpad.games.getGame({ path: { league: 'nfl', game_id: id } });
let afterSeq = detail.seq;

const { data: changes } = await statpad.changes.listGameChanges({
  path: { league: 'nfl', game_id: id },
  query: { after_seq: afterSeq },
});
for (const change of changes.data) {
  afterSeq = change.seq;
}
```

`changes.listChangedEntities` lists which entities of a league changed in a time window, for
clients that refetch rather than stream. It is cursor-paginated.

## Development

`openapi.yaml` is the Statpad API's OpenAPI spec. It's synced from the API's source repository,
which opens a pull request here with the regenerated client whenever the spec changes, so don't
edit it here. `src/generated` is written from it by `npm run generate` with
[@hey-api/openapi-ts](https://heyapi.dev); don't edit that by hand either. Changes to the
hand-written surface go in `src/index.ts`, with tests in `test/`. `npm run check` regenerates,
fails if `src/generated` is out of date, then type-checks, tests, builds and packs the package. `npm run check:live` builds and calls the production API without a
key, expecting a 401 `unauthorized`.
