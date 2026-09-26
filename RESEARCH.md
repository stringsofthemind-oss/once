# Once Research

## Reliable Execution of Consequential AI Agent Actions Under Retries and Ambiguous Outcomes

**Jamie Oswald — Once Research**  
Published: **26 September 2026**  
Version: **1.0**  
DOI: **10.5281/zenodo.22969881**

[Read the DOI record](https://doi.org/10.5281/zenodo.22969881) · [Once research page](https://onceexec.com/research/) · [Once website](https://onceexec.com/)

### Abstract

AI agents increasingly invoke tools that create externally visible side effects, including payments, refunds, bookings, messages, account changes, deployments, orders, and other mutations. When a tool invocation crosses a network boundary, a timeout or lost acknowledgement can leave the caller unable to determine whether the external effect occurred. A naive retry may therefore transform a recoverable communications failure into a duplicate real-world action.

The paper frames that condition as an ambiguous-outcome execution problem and presents a practical execution-safety model based on stable logical operation identity, effect binding, durable outcome state, conservative handling of `UNKNOWN` outcomes, and authoritative reconciliation where available.

It also describes selective protection: read-only and generation-only tools can remain direct, while consequential mutations are routed through a protection boundary and semantically uncertain tools fail closed.

Once is presented as a reference implementation of this model, including same-machine durable protection, MCP/tool discovery, framework integrations, and hostile-retry evidence across multiple agent frameworks.

The paper does **not** claim universal exactly-once execution. It specifies the assumptions under which a one-effect invariant can be demonstrated and the cases that remain dependent on downstream provider guarantees and authoritative reconciliation.

### Cite this paper

```text
Oswald, Jamie. (2026). Reliable Execution of Consequential AI Agent Actions Under Retries and Ambiguous Outcomes (Version 1.0). Zenodo. https://doi.org/10.5281/zenodo.22969881
```

### Reproducibility and implementation

The public implementation and evidence labs are maintained in this repository. Relevant areas include:

- automatic tool classification and Connect protection wiring;
- logical operation identity and effect binding;
- durable same-machine protection;
- reconciliation for ambiguous outcomes;
- LangGraph, CrewAI, and Agno hostile-retry evidence;
- selective Gateway `DIRECT / PROTECT / BLOCK` routing.

See the main [README](./README.md) and [automatic Connect guide](./docs/CONNECT_AUTO.md) for current implementation boundaries.
