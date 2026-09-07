import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { generateEnvironmentExample } from '../src/generate-environment-example';

const targetPath = path.resolve(process.cwd(), '../../.env.example');
writeFileSync(targetPath, generateEnvironmentExample(), 'utf8');
process.stdout.write(`Wrote ${targetPath}
`);
