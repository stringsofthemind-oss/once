# Draft PR #303 review follow-up

The independent agent review found two actionable defects: provider exception
causes exposed sensitive details through error inspection, and leases could
expire during witness admission. Both have regression tests and fixes. A bounded
witness acknowledgement deadline prevents an indefinitely pending CAS from
holding the execution lock forever. The deadline never authorizes retry.

Dependency advisory GHSA-6qxp-vccf-f47h is addressed by pinning the SDK MCP test
client to @modelcontextprotocol/sdk 1.31.0 and the MCP production client to
@modelcontextprotocol/client 2.2.0. No OAuth provider or persisted OAuth token
path is present in these source trees; stdio/server flows are retained. Historical
published-version claims are not rewritten. Run fresh audits and regressions;
this does not republish either package.

Review scope remains independent agent review, not external human security
certification. Separate physical-host and production witness qualification,
incomplete-history disaster recovery, and real-provider payment proof remain
release gates. PR stays draft until these claims are scoped and review is clean.

Advisory: https://github.com/advisories/GHSA-6qxp-vccf-f47h
