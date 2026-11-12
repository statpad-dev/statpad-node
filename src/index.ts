import { type Client, createClient, createConfig } from './generated/client/index.js';
import {
  Changes,
  Games,
  LeagueNews,
  Leagues,
  PlayByPlay,
  Players,
  Statistics,
  Teams,
} from './generated/sdk.gen.js';
import type { ErrorCode } from './generated/types.gen.js';

export type * from './generated/types.gen.js';

export const DEFAULT_BASE_URL = 'https://api.statpad.dev';

export interface StatpadOptions {
  /** An API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** @default 'https://api.statpad.dev' */
  baseUrl?: string;
  /** @default globalThis.fetch */
  fetch?: typeof fetch;
  /**
   * Retries after a 429 `rate_limited`, a 500, a 503 or a network error. A 429
   * `quota_exhausted` is never retried.
   *
   * @default 2
   */
  maxRetries?: number;
}

/** A non-2xx, non-304 response, from its RFC 9457 problem body. */
export class StatpadError extends Error {
  override readonly name = 'StatpadError';
  readonly status: number;
  readonly code: ErrorCode | undefined;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string | undefined;
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfter: number | undefined;
  /** With `quota_exhausted`, when the next period's allowance starts. */
  readonly resetsAt: string | undefined;
  /** With `resync_required`, the oldest seq the stream still holds. */
  readonly minSeq: number | undefined;

  constructor(response: Response, body: unknown) {
    const problem: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};
    const text = (key: string) => (typeof problem[key] === 'string' ? (problem[key] as string) : undefined);
    const code = text('code') as ErrorCode | undefined;
    const title = text('title') ?? (response.statusText || `HTTP ${response.status}`);
    const detail = text('detail');
    super(`${response.status}${code ? ` ${code}` : ''}: ${detail ?? title}`);
    this.status = response.status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.type = text('type');
    this.requestId = text('request_id');
    this.retryAfter = retryAfterSeconds(response);
    this.resetsAt = text('resets_at');
    this.minSeq = typeof problem.min_seq === 'number' ? problem.min_seq : undefined;
  }
}

/**
 * The Statpad API client. Each property groups the operations of one API tag.
 *
 * @example
 * const statpad = new Statpad({ apiKey: process.env.STATPAD_API_KEY! });
 * const { data } = await statpad.games.listGames({ path: { league: 'nba' }, query: { date: '2026-11-12' } });
 */
export class Statpad {
  /** The underlying generated fetch client, for interceptors. */
  readonly client: Client;
  readonly leagues: Leagues;
  readonly games: Games;
  readonly playByPlay: PlayByPlay;
  readonly statistics: Statistics;
  readonly teams: Teams;
  readonly players: Players;
  readonly leagueNews: LeagueNews;
  readonly changes: Changes;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl, maxRetries = 2 }: StatpadOptions) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(`maxRetries must be a non-negative integer, got ${maxRetries}`);
    }
    const base = createClient(
      createConfig({
        auth: apiKey,
        baseUrl,
        fetch: retrying(fetchImpl ?? ((input, init) => globalThis.fetch(input, init)), maxRetries),
        throwOnError: true,
      }),
    );
    base.interceptors.error.use((error, response, request) => {
      if (!response || response.ok) return error;
      if (response.status === 304 && request) return new NotModified(request, response);
      return new StatpadError(response, error);
    });
    const client: Client = { ...base, get: passNotModified(base.get) };
    this.client = client;
    this.leagues = bound(new Leagues({ client }));
    this.games = bound(new Games({ client }));
    this.playByPlay = bound(new PlayByPlay({ client }));
    this.statistics = bound(new Statistics({ client }));
    this.teams = bound(new Teams({ client }));
    this.players = bound(new Players({ client }));
    this.leagueNews = bound(new LeagueNews({ client }));
    this.changes = bound(new Changes({ client }));
  }
}

/**
 * Pages through a cursor-paginated list, passing each page's `next_cursor` back as `cursor`
 * until it is null. It yields whole pages, because they carry sidecars (`teams`, `players`)
 * and `seq`. The game changes feed pages by `after_seq` instead, so it isn't accepted here.
 *
 * @example
 * for await (const page of paginate(statpad.teams.listTeams, { path: { league: 'nba' } })) {
 *   console.log(page.data.length);
 * }
 */
export async function* paginate<TOperation extends CursorOperation>(
  operation: TOperation,
  options: Parameters<TOperation>[0],
): AsyncGenerator<NonNullable<Awaited<ReturnType<TOperation>>['data']>, void, undefined> {
  const first = options as { query?: { cursor?: string } };
  let cursor = first.query?.cursor;
  do {
    const { data } = await operation({ ...first, query: { ...first.query, cursor } } as never);
    if (!data) return;
    yield data as NonNullable<Awaited<ReturnType<TOperation>>['data']>;
    cursor = data.next_cursor ?? undefined;
  } while (cursor !== undefined);
}

type CursorOperation = (options: never) => Promise<{ data?: { next_cursor: string | null } | undefined }>;

class NotModified {
  constructor(
    readonly request: Request,
    readonly response: Response,
  ) {}
}

function passNotModified(get: Client['get']): Client['get'] {
  return (async (options: Parameters<Client['get']>[0]) => {
    try {
      const result = await get(options);
      if (result && typeof result === 'object' && 'error' in result && result.error instanceof NotModified) {
        return { data: undefined, error: undefined, request: result.error.request, response: result.error.response };
      }
      return result;
    } catch (error) {
      if (error instanceof NotModified) return { data: undefined, request: error.request, response: error.response };
      throw error;
    }
  }) as Client['get'];
}

function bound<T extends object>(group: T): T {
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(group))) {
    const value: unknown = Reflect.get(group, key);
    if (key !== 'constructor' && typeof value === 'function') Reflect.set(group, key, value.bind(group));
  }
  return group;
}

function retrying(fetchImpl: typeof fetch, maxRetries: number): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(request.clone());
      } catch (error) {
        if (attempt >= maxRetries || request.signal.aborted) throw error;
        await sleep(backoffMs(attempt), request.signal);
        continue;
      }
      if (attempt >= maxRetries || !(await isRetryable(response))) return response;
      await response.body?.cancel();
      const retryAfter = retryAfterSeconds(response);
      await sleep(retryAfter === undefined ? backoffMs(attempt) : retryAfter * 1000, request.signal);
    }
  };
}

async function isRetryable(response: Response): Promise<boolean> {
  if (response.status === 500 || response.status === 503) return true;
  if (response.status !== 429) return false;
  const problem: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return !(typeof problem === 'object' && problem !== null && 'code' in problem && problem.code === 'quota_exhausted');
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function backoffMs(attempt: number): number {
  return Math.random() * Math.min(8_000, 500 * 2 ** attempt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
