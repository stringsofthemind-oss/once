function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}

function timingSafeTextEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string"
  ) {
    return false;
  }

  let diff = left.length ^ right.length;
  const length = Math.max(
    left.length,
    right.length
  );

  for (let index = 0; index < length; index++) {
    diff |=
      (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function authorized(request, env) {
  const token = String(
    env.SANDBOX_DEMO_PROVIDER_TOKEN || ""
  ).trim();

  if (!token) {
    return false;
  }

  const authorization =
    request.headers.get("authorization") || "";

  return timingSafeTextEqual(
    authorization,
    `Bearer ${token}`
  );
}

export class SandboxDemoEffect {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const task = this.queue.then(
      () => this.handle(request)
    );

    this.queue = task.catch(() => {});

    return task;
  }

  async handle(request) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/truth"
    ) {
      const state = await this.ctx.storage.get("state");

      if (!state) {
        return json({
          provider_executed: false,
          side_effects: 0,
          execute_calls: 0,
          result: null
        });
      }

      return json({
        provider_executed: state.side_effects > 0,
        side_effects: state.side_effects,
        execute_calls: state.execute_calls,
        result: state.result || null
      });
    }

    if (
      request.method !== "POST" ||
      url.pathname !== "/execute"
    ) {
      return json(
        { error: "not_found" },
        404
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        { error: "invalid_json" },
        400
      );
    }

    const operationId = String(
      body?.operation_id || ""
    ).trim();

    if (!operationId) {
      return json(
        { error: "operation_id_required" },
        400
      );
    }

    const action =
      body?.action &&
      typeof body.action === "object"
        ? body.action
        : {};

    const fault = String(
      action.fault || ""
    ).trim().toLowerCase();

    const previous =
      await this.ctx.storage.get("state") || {
        execute_calls: 0,
        side_effects: 0
      };

    const executeCalls =
      previous.execute_calls + 1;

    const sideEffects =
      previous.side_effects + 1;

    const result = {
      demo: true,
      message: "Sandbox side effect committed",
      effect_number: sideEffects
    };

    await this.ctx.storage.put(
      "state",
      {
        execute_calls: executeCalls,
        side_effects: sideEffects,
        result,
        updated_at: new Date().toISOString()
      }
    );

    if (
      fault === "commit_then_503" &&
      executeCalls === 1
    ) {
      return json(
        {
          error: "sandbox_commit_then_503",
          provider_executed: true,
          side_effects: sideEffects
        },
        503
      );
    }

    return json({
      provider_executed: true,
      side_effects: sideEffects,
      execute_calls: executeCalls,
      result
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return json({
        ok: true,
        service: "once-sandbox-demo-provider"
      });
    }

    if (
      url.pathname.startsWith("/demo-provider/") &&
      !env.SANDBOX_DEMO_PROVIDER_TOKEN
    ) {
      return json(
        { error: "sandbox_demo_not_configured" },
        503
      );
    }

    if (
      url.pathname.startsWith("/demo-provider/") &&
      !authorized(request, env)
    ) {
      return json(
        { error: "unauthorized" },
        401
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/demo-provider/execute"
    ) {
      let body;

      try {
        body = await request.clone().json();
      } catch {
        return json(
          { error: "invalid_json" },
          400
        );
      }

      const operationId = String(
        body?.operation_id || ""
      ).trim();

      if (!operationId) {
        return json(
          { error: "operation_id_required" },
          400
        );
      }

      const id =
        env.SANDBOX_DEMO.idFromName(operationId);

      const stub =
        env.SANDBOX_DEMO.get(id);

      return stub.fetch(
        new Request(
          "https://sandbox-demo.internal/execute",
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(body)
          }
        )
      );
    }

    const truthPrefix =
      "/demo-provider/truth/";

    if (
      request.method === "GET" &&
      url.pathname.startsWith(truthPrefix)
    ) {
      let operationId;

      try {
        operationId = decodeURIComponent(
          url.pathname.slice(truthPrefix.length)
        ).trim();
      } catch {
        return json(
          { error: "invalid_operation_id" },
          400
        );
      }

      if (!operationId) {
        return json(
          { error: "operation_id_required" },
          400
        );
      }

      const id =
        env.SANDBOX_DEMO.idFromName(operationId);

      const stub =
        env.SANDBOX_DEMO.get(id);

      return stub.fetch(
        new Request(
          "https://sandbox-demo.internal/truth",
          {
            method: "GET"
          }
        )
      );
    }

    return json(
      { error: "not_found" },
      404
    );
  }
};