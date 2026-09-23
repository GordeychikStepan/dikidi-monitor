import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

test('серверный секрет посылается только в заголовке apikey', async () => {
  const calls = [];
  const store = new Store('https://example.supabase.co', 'sb_secret_TEST', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ run: true, lease: 'uuid', master_id: 4145159 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  });
  const result = await store.begin(false);
  assert.equal(result.master_id, 4145159);
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_TEST');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[0].options.body).p_force, false);
});
