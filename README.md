# @statpad/sdk

[![CI](https://github.com/statpad-dev/statpad-node/actions/workflows/ci.yml/badge.svg)](https://github.com/statpad-dev/statpad-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The TypeScript client for [Statpad](https://statpad.dev), a live sports data API. It covers schedules, live game state, play-by-play, box scores, rosters, injuries, transactions and season leaders.

## Install

```sh
npm install @statpad/sdk
```

The SDK needs Node.js 20 or later. It has no dependencies and uses only the standard `fetch` API, so Bun, Deno and Cloudflare Workers should run it too, but CI tests only Node.

Call Statpad from your server. The API doesn't allow requests from browsers, and a key shipped in a web page or mobile app is readable by anyone who opens it.

## Quickstart

Create an API key on the Keys page of [your Statpad account](https://app.statpad.dev) and put it in your environment as `STATPAD_API_KEY`. This script prints the NBA games that start in the next 24 hours:

```ts
import { Statpad } from '@statpad/sdk';

const statpad = new Statpad({ apiKey: process.env.STATPAD_API_KEY ?? '' });

const now = new Date();
const { data: page } = await statpad.games.listGames({
  path: { league: 'nba' },
  query: {
    from: now.toISOString(),
    to: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  },
});

const teams = new Map(page.teams.map((team) => [team.id, team]));
for (const game of page.data) {
  const away = teams.get(game.away_team_id);
  const home = teams.get(game.home_team_id);
  console.log(`${away?.market} ${away?.name} at ${home?.market} ${home?.name}, ${game.scheduled_at}`);
}
```

A list response includes the teams or players its items refer to, so one request has everything you need to print the page.

## What the client covers

Each method returns `{ data, request, response }`, where `data` is the parsed body and `response` is the raw `Response`. Methods take `path`, `query` and `headers` objects that match the [API reference](https://statpad.dev/docs).

| Property | Methods |
| --- | --- |
| `leagues` | `listLeagues` |
| `games` | `listGames`, `getGame`, `listGameRoster` |
| `playByPlay` | `listPlays`, `listPlayGroups` |
| `statistics` | `getBoxScore`, `listPlayerStats`, `listLeaders` |
| `teams` | `listTeams`, `getTeam`, `getTeamRoster`, `getDepthChart` |
| `players` | `getPlayer`, `listPlayerStats` |
| `leagueNews` | `listInjuries`, `listTransactions` |
| `changes` | `listGameChanges`, `listChangedEntities` |

The package exports a TypeScript type for every schema in the API, such as `Game`, `Team`, `Player` and `ErrorCode`:

```ts
import type { Game } from '@statpad/sdk';
```

## Pagination

List methods return one page at a time. `paginate` requests each next page until the list runs out:

```ts
import { paginate } from '@statpad/sdk';

for await (const page of paginate(statpad.playByPlay.listPlays, { path: { league: 'nfl', game_id: gameId } })) {
  for (const play of page.data) console.log(play.description);
}
```

`paginate` yields whole pages instead of single items, because each page also carries the teams or players its items refer to. It accepts only methods that page by cursor, so TypeScript rejects `listGameChanges`, which pages by sequence number.

## Errors

Every failed request throws a `StatpadError`. Branch on its `code`, which stays stable. The `title` and `detail` fields are for people and can change.

```ts
import { StatpadError } from '@statpad/sdk';

try {
  await statpad.games.getGame({ path: { league: 'nfl', game_id: gameId } });
} catch (error) {
  if (error instanceof StatpadError && error.code === 'not_found') {
    console.log('No such game');
  } else {
    throw error;
  }
}
```

These are the codes most applications handle:

| `code` | Status | What to do |
| --- | --- | --- |
| `unauthorized` | 401 | The key is missing, unknown or revoked. Check it on the Keys page. |
| `forbidden` | 403 | The key works, but your plan doesn't include this league or feature. An unknown league alias also returns `forbidden`. |
| `not_found` | 404 | The game, team or player doesn't exist in that league. |
| `resync_required` | 410 | The changes feed no longer holds the position you asked for. Read the game again, as shown in [Following a live game](#following-a-live-game). |
| `rate_limited` | 429 | You sent requests faster than your plan allows. The client retries these and throws only when its retries run out. |
| `quota_exhausted` | 429 | Your account used this billing period's request allowance. `resetsAt` says when the next period starts. |

The [errors page](https://statpad.dev/docs/errors) lists every code. Include `requestId` when you report a problem to Statpad.

## Retries and timeouts

The client retries `rate_limited`, `internal` and `unavailable` responses, plus network errors, up to two times. It waits the number of seconds in the `Retry-After` header when the response has one, and otherwise backs off exponentially with random jitter. It never retries `quota_exhausted`, because the allowance comes back only when the billing period renews. Every Statpad endpoint is a read, so a retry never repeats a write.

Set `maxRetries` to change the limit, or to `0` to turn retries off. The client sets no timeout of its own. To bound a request, pass an `AbortSignal`:

```ts
await statpad.games.getGame({
  path: { league: 'nfl', game_id: gameId },
  signal: AbortSignal.timeout(10_000),
});
```

## Following a live game

Every change to a game has a sequence number, `seq`. A game read returns the `seq` it reflects, and `changes.listGameChanges` returns the changes after a given `seq`, oldest first. Read the game once, then poll for changes:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { StatpadError } from '@statpad/sdk';

const path = { league: 'nfl', game_id: gameId };
let seq = (await statpad.games.getGame({ path })).data.seq;

while (true) {
  try {
    const { data: page } = await statpad.changes.listGameChanges({ path, query: { after_seq: seq } });
    for (const change of page.data) {
      applyChange(change);
      seq = change.seq;
    }
    if (seq < page.head_seq) continue;
  } catch (error) {
    if (!(error instanceof StatpadError && error.code === 'resync_required')) throw error;
    seq = (await statpad.games.getGame({ path })).data.seq;
  }
  await sleep(5_000);
}
```

`applyChange` stands for your own code. Each change carries the entity's full current state, so applying the same change twice is harmless. When `seq` is behind `head_seq`, the loop requests the next page without waiting. If you need changes as they happen instead of every few seconds, use the WebSocket stream described in the [docs](https://statpad.dev/docs). This SDK doesn't include a stream client yet.

## Conditional requests

Reads of a game, its plays, roster and box score, and of teams, players and injuries return an `ETag` header. Send it back in `If-None-Match`, and if nothing changed the API answers 304 with no body. The client doesn't throw on a 304. It returns `data` as `undefined`, so check the status before you read it:

```ts
const path = { league: 'nfl', game_id: gameId };
const first = await statpad.statistics.getBoxScore({ path });
const etag = first.response.headers.get('ETag');

const next = await statpad.statistics.getBoxScore({ path, headers: { 'If-None-Match': etag ?? undefined } });
const boxScore = next.response.status === 304 ? first.data : next.data;
```

The TypeScript type of `data` doesn't include `undefined`, so the compiler won't remind you to check for a 304. A 304 counts against your allowance like any other successful request, but it saves the transfer.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | Required | Your Statpad API key. The client sends it as `Authorization: Bearer <key>`. |
| `baseUrl` | `https://api.statpad.dev` | The API's address. |
| `fetch` | `globalThis.fetch` | The `fetch` function the client calls, for proxies, logging or tests. |
| `maxRetries` | `2` | How many times to retry a failed request. |

`statpad.client` is the underlying HTTP client, if you need to add request or response interceptors.

## Versioning

The SDK follows [semantic versioning](https://semver.org). Until 1.0, a minor release can include breaking changes, so pin a minor version, such as `~0.1.0`.

## Support

Report SDK bugs in [GitHub issues](https://github.com/statpad-dev/statpad-node/issues). For questions about the API, your account or your data, see the [Statpad docs](https://statpad.dev/docs). To change the SDK itself, read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
