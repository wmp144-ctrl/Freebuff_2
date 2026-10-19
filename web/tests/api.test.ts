import test from 'node:test';
import assert from 'node:assert/strict';
import { api, apiRequest, ApiError, isAbortError } from '../src/lib/api.ts';

type FetchLike = typeof globalThis.fetch;
const realFetch = globalThis.fetch;

function stubFetch(impl: FetchLike): void {
  globalThis.fetch = impl;
}

function restore(): void {
  globalThis.fetch = realFetch;
}

test('a request that never answers is aborted and reported as TIMEOUT', async () => {
  stubFetch((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  const started = Date.now();
  try {
    await assert.rejects(
      () => apiRequest('/dashboard/summary', { timeoutMs: 30 }),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'TIMEOUT');
        assert.equal(e.status, 0);
        assert.equal(e.aborted, false, 'a timeout is a real error, not a silent abort');
        return true;
      }
    );
  } finally {
    restore();
  }
  assert.ok(Date.now() - started < 2000, 'timeout must fire promptly');
});

test('calling api methods with an already-aborted signal makes no network call', async () => {
  let called = 0;
  stubFetch(() => {
    called += 1;
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => api.dashboard(controller.signal),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'ABORTED');
        assert.equal(isAbortError(e), true);
        return true;
      }
    );
    assert.equal(called, 0, 'aborted request must not hit the network');
  } finally {
    restore();
  }
});

test('a non-JSON response is rejected instead of silently returning text', async () => {
  stubFetch(() =>
    Promise.resolve(new Response('<html>proxy error</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  );
  try {
    await assert.rejects(
      () => api.dashboard(),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'INVALID_RESPONSE');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('broken JSON in a JSON response is rejected with a clear error', async () => {
  stubFetch(() =>
    Promise.resolve(new Response('{"oops": ', { status: 200, headers: { 'content-type': 'application/json' } }))
  );
  try {
    await assert.rejects(
      () => api.dashboard(),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'INVALID_RESPONSE');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('network failure becomes a friendly NETWORK ApiError', async () => {
  stubFetch(() => Promise.reject(new TypeError('fetch failed')));
  try {
    await assert.rejects(
      () => api.dashboard(),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'NETWORK');
        assert.match(e.message, /ارتباط/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('HTTP errors keep the server message and status', async () => {
  stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'تجهیز یافت نشد' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
  );
  try {
    await assert.rejects(
      () => api.device(999),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 404);
        assert.equal(e.message, 'تجهیز یافت نشد');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('204 and empty successful responses resolve without parse errors', async () => {
  stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
  try {
    const res = await api.logout();
    assert.equal(res, undefined);
  } finally {
    restore();
  }
});
