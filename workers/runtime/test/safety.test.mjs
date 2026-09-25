import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadRuntime, storage, deferred, execute } from './harness.mjs';

for (const state of ['PREPARED', 'FAILED_BEFORE_EFFECT']) {
  test(`concurrent retries from ${state} produce one effect`, async () => {
    const { Runtime } = await loadRuntime();
    const store = storage();
    const runtime = new Runtime({ storage: store }, {});
    runtime.insertOperation('race', state, new Date().toISOString());
    const bothLooking = deferred();
    let lookups = 0;
    let effects = 0;
    runtime.getProvider = async () => {
      if (++lookups === 2) bothLooking.resolve();
      await bothLooking.promise;
      return undefined;
    };
    runtime.executeProvider = async () => ({ side_effects: ++effects });
    const results = await Promise.all([execute(runtime), execute(runtime)]);
    assert.equal(effects, 1, `statuses: ${results.map(r => r.status)}`);
    assert.equal(runtime.getOperation('race').state, 'CONFIRMED');
    store.db.close();
  });
}

for (const payload of [
  {},
  { provider_executed: 'false', side_effects: 0 },
  { provider_executed: true, side_effects: 0 },
  { provider_executed: false, side_effects: 1 },
  { provider_executed: true, side_effects: '1' },
  { provider_executed: true, side_effects: -1 },
  { provider_executed: false, side_effects: 0, operation_id: 'wrong' }
]) {
  test(`malformed provider truth cannot authorize execution: ${JSON.stringify(payload)}`, async () => {
    const context = await loadRuntime();
    const store = storage();
    const runtime = new context.Runtime({ storage: store }, {});
    runtime.getHttpV1Config = () => ({ baseUrl: 'https://provider.test', token: 'fixture' });
    let effects = 0;
    context.fetch = async () => Response.json(payload);
    runtime.executeProvider = async () => ({ side_effects: ++effects });
    const result = await execute(runtime, 'invalid', { provider: 'http_v1' });
    assert.equal(effects, 0);
    assert.equal(result.status, 503);
    store.db.close();
  });
}

const registered = 'registered_http_v1:pv_' + 'a'.repeat(32);
const httpAction = {
  type: 'http_write_v1',
  method: 'POST',
  url: 'https://target.test/orders',
  body_json: '{}'
};
const httpConfig = { allowedUrls: [httpAction.url], responseReplay: 'required' };
const replay = {
  status: 201,
  body_text: '{"id":"one"}',
  headers: { 'content-type': 'application/json' }
};

for (const state of [null, 'PREPARED', 'FAILED_BEFORE_EFFECT']) {
  test(`independent object instances with shared SQLite and async config: ${state}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'once-race-'));
    const stores = [storage(join(dir, 'ledger.db')), storage(join(dir, 'ledger.db'))];
    try {
      // Separate VM contexts and object instances: no shared in-process lock.
      const contexts = await Promise.all([loadRuntime(), loadRuntime()]);
      const runtimes = contexts.map((c, i) => new c.Runtime({ storage: stores[i] }, {}));
      if (state) runtimes[0].insertOperation('race', state, new Date().toISOString(), registered);
      const ready = deferred();
      let waiting = 0;
      let effects = 0;
      for (const runtime of runtimes) {
        let configs = 0;
        runtime.getRegisteredHttpV1Config = async () => {
          if (++configs === 2) {
            if (++waiting === 2) ready.resolve();
            await ready.promise;
          }
          return httpConfig;
        };
        runtime.getProvider = async () => undefined;
        runtime.executeProvider = async () => ({ side_effects: ++effects, http_response: replay });
      }
      const responses = await Promise.all(
        runtimes.map(r => execute(r, 'race', { provider: registered, action: httpAction }))
      );
      assert.equal(effects, 1);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
      assert.equal(runtimes[0].getOperation('race').state, 'CONFIRMED');
      assert.equal(runtimes[0].getHttpResponseReplay('race').body_text, replay.body_text);
    } finally {
      stores.forEach(s => s.db.close());
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('no provider dispatch before durable sync, including sync failure', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});
  const entered = deferred();
  const release = deferred();
  store.sync = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('disk unavailable');
  };
  runtime.getProvider = async () => undefined;
  let effects = 0;
  runtime.executeProvider = async () => ({ side_effects: ++effects });
  const pending = execute(runtime);
  await entered.promise;
  assert.equal(runtime.getOperation('race').state, 'EXECUTING');
  assert.equal(effects, 0);
  release.resolve();
  await assert.rejects(pending, /disk unavailable/);
  assert.equal((await execute(runtime)).status, 409);
  assert.equal(effects, 0);
  store.db.close();
});

for (const truth of ['absent', 'unavailable', 'confirmed']) {
  test(`concurrent ${truth} observer cannot prevent owner committing HTTP replay`, async () => {
    const { Runtime } = await loadRuntime();
    const store = storage();
    const runtime = new Runtime({ storage: store }, {});
    const entered = deferred();
    const release = deferred();
    let effects = 0;
    runtime.getRegisteredHttpV1Config = async () => httpConfig;
    runtime.getProvider = async () => undefined;
    runtime.executeProvider = async () => {
      ++effects;
      entered.resolve();
      await release.promise;
      return { side_effects: 1, http_response: replay };
    };
    const pending = execute(runtime, 'race', { provider: registered, action: httpAction });
    await entered.promise;
    runtime.getProvider = async () => {
      if (truth === 'unavailable') throw new Error('offline');
      return truth === 'confirmed' ? { side_effects: 1 } : undefined;
    };
    const observer = await execute(runtime, 'race', { provider: registered, action: httpAction });
    assert.notEqual(observer.status, 200);
    release.resolve();
    assert.equal((await pending).status, 200);
    assert.equal(effects, 1);
    assert.equal(runtime.getOperation('race').state, 'CONFIRMED');
    assert.equal(runtime.getHttpResponseReplay('race').body_text, replay.body_text);
    store.db.close();
  });
}

test('stale negative truth cannot overwrite a newly confirmed operation', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});
  runtime.insertOperation('race', 'FAILED_BEFORE_EFFECT', new Date().toISOString());
  const entered = deferred();
  const release = deferred();
  let lookups = 0;
  let effects = 0;
  runtime.getProvider = async () => {
    if (++lookups === 1) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  runtime.executeProvider = async () => ({ side_effects: ++effects });
  const stale = execute(runtime);
  await entered.promise;
  assert.equal((await execute(runtime)).status, 200);
  release.resolve();
  assert.equal((await stale).status, 200);
  assert.equal(effects, 1);
  store.db.close();
});

for (const boundary of ['before_dispatch', 'after_effect']) {
  test(`hard process exit ${boundary}; fresh process storage recovery`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'once-crash-'));
    try {
      const crash = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), dir, boundary],
        { env: {}, encoding: 'utf8' }
      );
      assert.equal(crash.status, 77, crash.stderr);
      const { Runtime } = await loadRuntime();
      const store = storage(join(dir, 'ledger.db'));
      const effects = storage(join(dir, 'provider.db'));
      try {
        const runtime = new Runtime({ storage: store }, {});
        let dispatches = 0;
        runtime.executeProvider = async () => {
          ++dispatches;
          throw new Error('must not execute');
        };
        runtime.getProvider = async () => undefined;
        assert.equal((await execute(runtime)).status, 409, 'negative lookup must not reclaim a crash');
        assert.equal(runtime.getOperation('race').state, 'UNKNOWN');
        runtime.getProvider = async () => {
          const count = effects.sql.exec('SELECT count(*) AS n FROM effects')[0].n;
          return count ? { side_effects: count } : undefined;
        };
        const result = await execute(runtime);
        assert.equal(result.status, boundary === 'after_effect' ? 200 : 409);
        assert.equal(dispatches, 0);
        assert.equal(
          effects.sql.exec('SELECT count(*) AS n FROM effects')[0].n,
          boundary === 'after_effect' ? 1 : 0
        );
      } finally {
        store.db.close();
        effects.db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('reconciliation alarm redelivery only confirms; never dispatches', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});
  runtime.insertOperation('race', 'UNKNOWN', new Date().toISOString());
  await runtime.enqueueUnknownReconciliation('race', 0);
  store.sql.exec('UPDATE unknown_reconciliation SET next_check_at = 0');
  runtime.getProvider = async () => ({ side_effects: 1 });
  runtime.executeProvider = async () => { throw new Error('alarm cannot execute'); };
  await runtime.alarm();
  await runtime.alarm();
  assert.equal(runtime.getOperation('race').state, 'CONFIRMED');

  const receipt =
    runtime.getConfirmationReceipt('race');

  assert.equal(receipt.side_effects, 1);
  assert.equal(receipt.provider, 'blind_test');

  store.db.close();
});

test('provider requests do not follow redirects and have an abort deadline', async () => {
  const c = await loadRuntime();
  const store = storage();
  const runtime = new c.Runtime({ storage: store }, {});
  runtime.getHttpV1Config = () => ({ baseUrl: 'https://adapter.test', token: 'fixture' });

  let mode = 'normal';

  c.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);

    if (mode === 'redirect') {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://redirected.test/'
        }
      });
    }

    return Response.json({
      provider_executed: false,
      side_effects: 0
    });
  };

  assert.equal(
    await runtime.getHttpV1Provider('race'),
    undefined
  );

  mode = 'redirect';

  await assert.rejects(
    runtime.getHttpV1Provider('race'),
    /http_v1_truth_http_302/
  );

  store.db.close();
});


test('confirmed replay uses durable local receipt without provider I/O', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});

  let truthCalls = 0;
  let effects = 0;

  runtime.getProvider = async () => {
    ++truthCalls;
    return undefined;
  };

  runtime.executeProvider = async () => ({
    side_effects: ++effects,
    executed_at: '2026-09-25T07:00:00.000Z'
  });

  const fresh =
    await execute(runtime);

  const freshBody =
    await fresh.json();

  assert.equal(fresh.status, 200);
  assert.equal(freshBody.result, 'executed');
  assert.equal(freshBody.state, 'CONFIRMED');
  assert.equal(freshBody.side_effects, 1);
  assert.equal(effects, 1);
  assert.equal(truthCalls, 1);

  const receipt =
    runtime.getConfirmationReceipt('race');

  assert.equal(receipt.provider, 'blind_test');
  assert.equal(receipt.side_effects, 1);
  assert.equal(
    receipt.executed_at,
    '2026-09-25T07:00:00.000Z'
  );

  runtime.getProvider = async () => {
    ++truthCalls;
    throw new Error(
      'provider truth must not run on fast replay'
    );
  };

  runtime.executeProvider = async () => {
    throw new Error(
      'provider execute must not run on replay'
    );
  };

  const replayResponse =
    await execute(runtime);

  const replayBody =
    await replayResponse.json();

  assert.equal(replayResponse.status, 200);
  assert.equal(
    replayBody.result,
    'already_executed'
  );
  assert.equal(
    replayBody.state,
    'CONFIRMED'
  );
  assert.equal(
    replayBody.side_effects,
    1
  );
  assert.equal(
    replayBody.first_executed_at,
    '2026-09-25T07:00:00.000Z'
  );

  assert.equal(
    truthCalls,
    1,
    'fast replay must make zero additional truth calls'
  );

  assert.equal(
    effects,
    1,
    'fast replay must make zero additional effects'
  );

  store.db.close();
});


test('legacy confirmed operation backfills receipt once then fast-replays locally', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});

  const now =
    '2026-09-25T07:01:00.000Z';

  runtime.insertOperation(
    'legacy',
    'CONFIRMED',
    now,
    'blind_test'
  );

  assert.equal(
    runtime.getConfirmationReceipt('legacy'),
    undefined
  );

  let truthCalls = 0;

  runtime.getProvider = async () => {
    ++truthCalls;

    return {
      side_effects: 1,
      executed_at:
        '2026-09-25T06:59:00.000Z'
    };
  };

  runtime.executeProvider = async () => {
    throw new Error(
      'confirmed legacy operation must never execute'
    );
  };

  const firstReplay =
    await execute(
      runtime,
      'legacy'
    );

  const firstBody =
    await firstReplay.json();

  assert.equal(firstReplay.status, 200);
  assert.equal(
    firstBody.result,
    'already_executed'
  );
  assert.equal(truthCalls, 1);

  const receipt =
    runtime.getConfirmationReceipt(
      'legacy'
    );

  assert.equal(
    receipt.side_effects,
    1
  );

  assert.equal(
    receipt.executed_at,
    '2026-09-25T06:59:00.000Z'
  );

  runtime.getProvider = async () => {
    ++truthCalls;

    throw new Error(
      'backfilled receipt should suppress provider truth'
    );
  };

  const secondReplay =
    await execute(
      runtime,
      'legacy'
    );

  const secondBody =
    await secondReplay.json();

  assert.equal(
    secondReplay.status,
    200
  );

  assert.equal(
    secondBody.result,
    'already_executed'
  );

  assert.equal(
    secondBody.side_effects,
    1
  );

  assert.equal(
    truthCalls,
    1,
    'only the first legacy replay may query provider truth'
  );

  store.db.close();
});


test('receipt cannot bypass a missing required HTTP replay', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});

  const now =
    '2026-09-25T07:02:00.000Z';

  runtime.insertOperation(
    'race',
    'CONFIRMED',
    now,
    registered
  );

  runtime.recordConfirmationReceipt(
    'race',
    registered,
    {
      side_effects: 1,
      executed_at:
        '2026-09-25T07:01:00.000Z'
    },
    now
  );

  runtime.requireHttpResponseReplay(
    'race',
    now
  );

  runtime.getRegisteredHttpV1Config =
    async () => httpConfig;

  let truthCalls = 0;

  runtime.getProvider = async () => {
    ++truthCalls;

    return {
      side_effects: 1,
      executed_at:
        '2026-09-25T07:01:00.000Z'
    };
  };

  runtime.executeProvider = async () => {
    throw new Error(
      'missing HTTP replay may not execute'
    );
  };

  const response =
    await execute(
      runtime,
      'race',
      {
        provider: registered,
        action: httpAction
      }
    );

  const body =
    await response.json();

  assert.equal(response.status, 409);
  assert.equal(
    body.result,
    'replay_required_missing'
  );

  assert.equal(
    runtime.getOperation('race').state,
    'UNKNOWN'
  );

  assert.equal(
    truthCalls,
    1,
    'missing required replay must fall through to provider truth'
  );

  store.db.close();
});
