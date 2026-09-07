import { createStubServer } from './create-stub-server';

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';
const apiKey = process.env.WAHA_API_KEY ?? 'stub-api-key';

const server = createStubServer({ apiKey });

async function main(): Promise<void> {
  await server.listen({ port, host });
  process.stdout.write(`WAHA stub listening on ${host}:${String(port)}\n`);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`The WAHA stub failed to start: ${String(error)}\n`);
    process.exit(1);
  }
}

void run();
