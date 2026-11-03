import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/internal/history-sync/route';

const originalSecret = process.env.MCP_INTERNAL_SECRET;
const originalDatabase = process.env.DATABASE_URL;
const originalFetch = globalThis.fetch;
let outboundCalls = 0;

before(() => {
  // No test request can touch a real database, and any HA call is trapped.
  delete process.env.DATABASE_URL;
  globalThis.fetch = async () => {
    outboundCalls++;
    throw new Error('The scheduled route must not contact HA in these tests');
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({ MCP_INTERNAL_SECRET: originalSecret, DATABASE_URL: originalDatabase })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const request = (headers: Record<string, string> = {}) => new Request(
  'https://example.test/api/internal/history-sync?start=1970-01-01&maxDays=100000',
  { method: 'POST', headers, body: 'not JSON and never parsed by this scheduled route' },
);

test('the scheduler fails closed when its internal secret is missing', async () => {
  delete process.env.MCP_INTERNAL_SECRET;
  const response = await POST(request({ 'x-internal-secret': 'invented-secret' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.equal(outboundCalls, 0);
});

test('missing, wrong and wrong-header secrets cannot start scheduled ingestion', async () => {
  process.env.MCP_INTERNAL_SECRET = 'scheduler-test-secret';
  const cases: Record<string, string>[] = [
    {},
    { 'x-internal-secret': 'incorrect' },
    { 'x-internal-secret': 'scheduler-test-secreu' },
    { Authorization: 'Bearer scheduler-test-secret' },
  ];
  for (const headers of cases) {
    const response = await POST(request(headers));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  assert.equal(outboundCalls, 0);
});

test('authorized scheduler requests report unavailable storage without fake success or HA side effects', async () => {
  process.env.MCP_INTERNAL_SECRET = 'scheduler-test-secret';
  const response = await POST(request({ 'x-internal-secret': 'scheduler-test-secret' }));
  assert.equal(response.status, 503);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(await response.json(), {
    ok: false, error: 'History ingestion failed; the next scheduled run will retry.',
  });
  assert.equal(outboundCalls, 0);
});
