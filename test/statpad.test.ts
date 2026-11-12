import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Game, paginate, Statpad, StatpadError } from '../src/index.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status < 400 ? 'application/json' : 'application/problem+json', ...headers },
  });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `https://statpad.dev/docs/errors/${code}`,
  title: code,
  status,
  code,
  detail: `detail for ${code}`,
  request_id: `req_${code}`,
  ...extra,
});

const leagues = { data: [] };

function mockFetch(...responses: Array<Response | Error>) {
  const queue = [...responses];
  return vi.fn(async (input: RequestInfo | URL) => {
    void input;
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
}

const requestAt = (fetch: ReturnType<typeof mockFetch>, call: number) => fetch.mock.calls[call]?.[0] as Request;

afterEach(() => {
  vi.useRealTimers();
});

describe('Statpad', () => {
  it('sends the key as a bearer token to the configured base URL', async () => {
    const fetch = mockFetch(json(200, { data: [], teams: [], next_cursor: null }));
    const statpad = new Statpad({ apiKey: 'sk_test', baseUrl: 'https://example.test/', fetch });

    await statpad.games.listGames({ path: { league: 'nba' }, query: { date: '2026-11-12' } });

    const request = requestAt(fetch, 0);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://example.test/v1/nba/games?date=2026-11-12');
    expect(request.headers.get('Authorization')).toBe('Bearer sk_test');
  });

  it('defaults to the production base URL', async () => {
    const fetch = mockFetch(json(200, leagues));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const { data } = await statpad.leagues.listLeagues();

    expect(data).toEqual(leagues);
    expect(requestAt(fetch, 0).url).toBe('https://api.statpad.dev/v1/leagues');
  });

  it('retries a 429 rate_limited after Retry-After, then succeeds', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(json(429, problem(429, 'rate_limited'), { 'Retry-After': '2' }), json(200, leagues));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const result = statpad.leagues.listLeagues();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ data: leagues });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a 429 quota_exhausted at once without retrying', async () => {
    const fetch = mockFetch(
      json(429, problem(429, 'quota_exhausted', { resets_at: '2026-12-01T00:00:00Z' }), { 'Retry-After': '1555200' }),
      json(200, leagues),
    );
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    await expect(statpad.leagues.listLeagues()).rejects.toMatchObject({ code: 'quota_exhausted', retryAfter: 1555200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxRetries: 0, calls: 1 },
    { maxRetries: 1, calls: 2 },
    { maxRetries: undefined, calls: 3 },
  ])('makes $calls attempts with maxRetries $maxRetries', async ({ maxRetries, calls }) => {
    vi.useFakeTimers();
    const fetch = mockFetch(
      json(503, problem(503, 'unavailable')),
      json(500, problem(500, 'internal')),
      json(503, problem(503, 'unavailable')),
      json(200, leagues),
    );
    const statpad = new Statpad({ apiKey: 'sk_test', fetch, ...(maxRetries === undefined ? {} : { maxRetries }) });

    const result = statpad.leagues.listLeagues();
    const settled = expect(result).rejects.toBeInstanceOf(StatpadError);
    await vi.runAllTimersAsync();

    await settled;
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('retries a network error', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(new TypeError('fetch failed'), json(200, leagues));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const result = statpad.leagues.listLeagues();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ data: leagues });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    const fetch = mockFetch(json(404, problem(404, 'not_found')), json(200, leagues));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    await expect(statpad.games.getGame({ path: { league: 'nfl', game_id: 'x' } })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a negative maxRetries', () => {
    expect(() => new Statpad({ apiKey: 'sk_test', maxRetries: -1 })).toThrow(RangeError);
  });

  it('returns a 304 without throwing', async () => {
    const fetch = mockFetch(new Response(null, { status: 304, headers: { ETag: '"v1"' } }));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const { data, response } = await statpad.games.getGame({
      path: { league: 'nfl', game_id: '01a1b987-644f-7459-b8e0-810b314f71da' },
      headers: { 'If-None-Match': '"v1"' },
    });

    expect(data).toBeUndefined();
    expect(response.status).toBe(304);
    expect(requestAt(fetch, 0).headers.get('If-None-Match')).toBe('"v1"');
  });
});

describe('StatpadError', () => {
  it('carries every problem field and Retry-After', async () => {
    const fetch = mockFetch(
      json(429, problem(429, 'quota_exhausted', { title: 'Quota exhausted', resets_at: '2026-12-01T00:00:00Z' }), {
        'Retry-After': '86400',
      }),
    );
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const error = await statpad.leagues.listLeagues().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(StatpadError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'StatpadError',
      message: '429 quota_exhausted: detail for quota_exhausted',
      status: 429,
      code: 'quota_exhausted',
      title: 'Quota exhausted',
      detail: 'detail for quota_exhausted',
      type: 'https://statpad.dev/docs/errors/quota_exhausted',
      requestId: 'req_quota_exhausted',
      retryAfter: 86400,
      resetsAt: '2026-12-01T00:00:00Z',
      minSeq: undefined,
    });
  });

  it('carries min_seq from a 410 resync_required', async () => {
    const fetch = mockFetch(json(410, problem(410, 'resync_required', { min_seq: 1200 })));
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const error = await statpad.changes
      .listGameChanges({ path: { league: 'nfl', game_id: 'x' }, query: { after_seq: 40 } })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ status: 410, code: 'resync_required', minSeq: 1200, retryAfter: undefined });
  });

  it('falls back to the status line for a body that is not a problem', async () => {
    const fetch = mockFetch(
      new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } }),
    );
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    await expect(statpad.leagues.listLeagues()).rejects.toMatchObject({
      status: 502,
      code: undefined,
      title: 'Bad Gateway',
      message: '502: Bad Gateway',
    });
  });
});

describe('paginate', () => {
  const game = (id: string) => ({ id }) as Game;

  it('follows next_cursor across pages and stops on null', async () => {
    const fetch = mockFetch(
      json(200, { data: [game('a')], teams: [], next_cursor: 'c2' }),
      json(200, { data: [game('b')], teams: [], next_cursor: 'c3' }),
      json(200, { data: [game('c')], teams: [], next_cursor: null }),
    );
    const statpad = new Statpad({ apiKey: 'sk_test', fetch });

    const pages = [];
    for await (const page of paginate(statpad.games.listGames, { path: { league: 'nba' }, query: { date: '2026-11-12' } })) {
      pages.push(page);
    }

    expect(pages.map((page) => page.data.map((g) => g.id))).toEqual([['a'], ['b'], ['c']]);
    expect(fetch.mock.calls.map((_, call) => new URL(requestAt(fetch, call).url).search)).toEqual([
      '?date=2026-11-12',
      '?date=2026-11-12&cursor=c2',
      '?date=2026-11-12&cursor=c3',
    ]);
  });

  it('only accepts cursor-paginated operations', () => {
    const statpad = new Statpad({ apiKey: 'sk_test', fetch: mockFetch() });
    const typeOnly = () => {
      // @ts-expect-error listGameChanges pages by after_seq, not cursor.
      paginate(statpad.changes.listGameChanges, { path: { league: 'nfl', game_id: 'x' }, query: { after_seq: 0 } });
      // @ts-expect-error getGame is not a list.
      paginate(statpad.games.getGame, { path: { league: 'nfl', game_id: 'x' } });
    };
    expect(typeOnly).toBeTypeOf('function');
  });
});
