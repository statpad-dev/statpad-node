import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { parse } from 'yaml';

type Operation = { responses: Record<string, { $ref?: string; content?: Record<string, unknown> }> };
type Spec = { paths: Record<string, Record<string, Operation>>; components: { responses: Record<string, Operation['responses'][string]> } };

const doc = parse(readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8')) as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
formats.default(ajv);
ajv.addSchema(doc, 'spec');

const segment = (key: string) => encodeURIComponent(key.replaceAll('~', '~0').replaceAll('/', '~1'));

/** Throws unless body matches the schema the spec gives operationId's response with this status. */
export function expectMatchesSpec(operationId: string, body: unknown, status = '200'): void {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if ((operation as { operationId?: string }).operationId !== operationId) continue;
      const response = operation.responses[status];
      if (!response) throw new Error(`${operationId} has no ${status} response in the spec`);
      let pointer = `#/paths/${segment(path)}/${method}/responses/${status}`;
      let content = response.content;
      if (response.$ref) {
        pointer = response.$ref;
        content = doc.components.responses[response.$ref.split('/').at(-1)!]?.content;
      }
      const type = Object.keys(content ?? {})[0];
      if (!type) throw new Error(`${operationId} ${status} has no content in the spec`);
      const validate = ajv.getSchema(`spec${pointer}/content/${segment(type)}/schema`);
      if (!validate) throw new Error(`no schema for ${operationId} ${status}`);
      if (!validate(body)) throw new Error(`${operationId} ${status} doesn't match the spec: ${ajv.errorsText(validate.errors)}`);
      return;
    }
  }
  throw new Error(`no operation ${operationId} in the spec`);
}
