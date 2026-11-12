# Contributing

Most of this package is generated from the Statpad API's OpenAPI spec. Know which files are generated before you change anything.

## How the code fits together

- `openapi.yaml` is the API's OpenAPI spec. It comes from the private repository that holds the API, which opens a pull request here whenever the spec changes. Don't edit it here, because the next sync overwrites it.
- `src/generated` is the client that [`@hey-api/openapi-ts`](https://heyapi.dev) writes from `openapi.yaml`. Don't edit it by hand. Run `npm run generate` and commit the result.
- `src/index.ts` is written by hand. It holds the `Statpad` class, `StatpadError`, the retry logic and `paginate`. Most changes belong here, with tests in `test/`.

`@hey-api/openapi-ts` is pinned to an exact version, because its releases before 1.0 change the generated code. It also needs TypeScript 6 and fails under TypeScript 7.

## Checks

```sh
npm ci
npm run check
```

`npm run check` regenerates the client and fails if `src/generated` doesn't match `openapi.yaml`. It then type-checks, runs the tests, builds `dist/` and checks that the package contains only `dist/`, the README, the license and `package.json`. CI runs the same command on every pull request.

`npm run check:live` builds the package and calls the production API without a key. It passes when the API answers 401 `unauthorized`. CI doesn't run it.

## Spec updates

When the API's spec changes, a pull request named "Sync the OpenAPI spec" appears here. It updates `openapi.yaml` and `src/generated` together. If its CI fails, the change broke `src/index.ts` or its tests. Fix that in a separate pull request, because each sync rewrites the sync branch.

## Releases

1. Update `version` in `package.json` and merge the change.
2. Publish a GitHub release whose tag is `v` followed by that version, such as `v0.2.0`.
3. The release workflow checks the tag against `package.json`, runs `npm run check` and stages the package on npm.
4. A maintainer approves the staged version on npm with two-factor authentication, and it goes live.
