import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type Game, paginate, Statpad, StatpadError } from '../../src/index.js';
import { expectMatchesSpec } from './spec.js';

const apiKey = process.env.STATPAD_API_KEY;
if (!apiKey) throw new Error('test:live needs STATPAD_API_KEY, a key for an account that can read at least one league');

const statpad = new Statpad({ apiKey, ...(process.env.STATPAD_BASE_URL ? { baseUrl: process.env.STATPAD_BASE_URL } : {}) });
const finished = new Set<Game['status']>(['complete', 'closed']);
const days = 14;

const leagues = await statpad.leagues.listLeagues();
expectMatchesSpec('listLeagues', leagues.data);

async function lastFinishedGame(league: string): Promise<Game | undefined> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  let last: Game | undefined;
  for await (const page of paginate(statpad.games.listGames, {
    path: { league },
    query: { from: from.toISOString(), to: to.toISOString(), limit: 100 },
  })) {
    expectMatchesSpec('listGames', page);
    for (const game of page.data) if (finished.has(game.status)) last = game;
  }
  return last;
}

const games = new Map<string, Game | undefined>();
for (const { alias } of leagues.data!.data) games.set(alias, await lastFinishedGame(alias));

describe('account', () => {
  it('can read at least one league', () => {
    expect(leagues.data!.data.length).toBeGreaterThan(0);
  });

  it('reports the period allowance on a metered response', () => {
    expect(leagues.response.headers.get('RateLimit-Policy')).toMatch(/^"allowance";q=\d+;w=\d+$/);
    expect(leagues.response.headers.get('RateLimit')).toMatch(/^"allowance";r=\d+;t=\d+$/);
  });

  it(`has a finished game from the last ${days} days in some league`, () => {
    expect([...games.values()].some(Boolean)).toBe(true);
  });

  it("answers a league the account can't read with 403 forbidden", async () => {
    const error = await statpad.games.listGames({ path: { league: 'nosuchleague' }, query: { date: '2026-11-07' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatpadError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe.each(leagues.data!.data.map(({ alias }) => alias))('%s', (league) => {
  const game = games.get(league);

  it('lists teams and reads one', async () => {
    const teams = await statpad.teams.listTeams({ path: { league }, query: { limit: 5 } });
    expectMatchesSpec('listTeams', teams.data);
    const first = teams.data!.data[0];
    expect(first).toBeDefined();
    const team = await statpad.teams.getTeam({ path: { league, team_id: first!.id } });
    expectMatchesSpec('getTeam', team.data);
  });

  it.skipIf(!game)('reads the last finished game, and answers its ETag with 304', async () => {
    const detail = await statpad.games.getGame({ path: { league, game_id: game!.id } });
    expectMatchesSpec('getGame', detail.data);
    expect(detail.data!.game.id).toBe(game!.id);
    expect(finished.has(detail.data!.game.status)).toBe(true);

    const etag = detail.response.headers.get('ETag');
    expect(etag).toBeTruthy();
    const again = await statpad.games.getGame({ path: { league, game_id: game!.id }, headers: { 'If-None-Match': etag! } });
    expect(again.response.status).toBe(304);
    expect(again.data).toBeUndefined();
  });

  it.skipIf(!game)('reads its box score', async () => {
    const box = await statpad.statistics.getBoxScore({ path: { league, game_id: game!.id } });
    expectMatchesSpec('getBoxScore', box.data);
    expect(box.data!.game_id).toBe(game!.id);
    expect(box.data!.players.length).toBeGreaterThan(0);
  });

  it.skipIf(!game)('pages through the start of its plays', async () => {
    const first = await statpad.playByPlay.listPlays({ path: { league, game_id: game!.id }, query: { limit: 5 } });
    expectMatchesSpec('listPlays', first.data);
    expect(first.data!.data.length).toBeGreaterThan(0);
    const cursor = first.data!.next_cursor;
    if (cursor === null) return;
    const second = await statpad.playByPlay.listPlays({ path: { league, game_id: game!.id }, query: { limit: 5, cursor } });
    expectMatchesSpec('listPlays', second.data);
    const seen = new Set(first.data!.data.map((play) => play.id));
    expect(second.data!.data.some((play) => seen.has(play.id))).toBe(false);
  });

  it('answers an unknown game with 404 not_found', async () => {
    const error = await statpad.games.getGame({ path: { league, game_id: randomUUID() } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatpadError);
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
  });
});
