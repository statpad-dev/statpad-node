import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: 'openapi.yaml',
  output: {
    path: 'src/generated',
    module: { extension: '.js' },
  },
  plugins: [
    { name: '@hey-api/client-fetch', throwOnError: true },
    '@hey-api/typescript',
    {
      name: '@hey-api/sdk',
      operations: { strategy: 'byTags', methods: 'instance' },
    },
  ],
});
