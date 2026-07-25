# External source transactions

## Approved bounded source GET

Prefer current project/local content. If one exact file or API response is
needed from a user-supplied GitLab, modules, or Common Hooks HTTP(S) source,
use a signed one-use source-read transaction. First prepare the complete
request without contacting the source:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind source-read --source <gitlab|modules|common-hooks> --base-url <exact-user-supplied-base-url> --relative-url <exact-relative-path-and-query> [--credential-env <user-selected-variable-name>] [--output-limit-bytes <1..16384>] [--timeout-ms <1..60000>]
```

Apply the returned
[review transaction](review-and-safety.md#review-transaction). It displays and
binds the exact base URL, relative path and non-secret query, endpoint/request
digests, credential-variable name, bounds, project, task, and phase. The signed
challenge additionally binds the active session and lease. After exact
approval, execute the same argument vector:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <gitlab|modules|common-hooks> --base-url <exact-user-supplied-base-url> --relative-url <exact-relative-path-and-query> [--credential-env <same-variable-name>] [--output-limit-bytes <same-value>] [--timeout-ms <same-value>]
```

The helper consumes approval before the network request. Replay fails. Any
changed source, path/query, credential selector, or bound fails without
contacting the source and without consuming a still-matching approval.
Credential values may exist only in the selected environment variable; signed
or high-entropy query values are rejected. This is not a general HTTP client.

## Approved reference-source checkout

Prefer existing project/local content and the approved bounded GET above. Only
during `DISCOVERING`, when understanding requires repository semantics, stage
one complete `source-checkout.schema.json` document. Its `source` is exactly
`modules`, `common-hooks`, or `reference-project`. Put the exact user-reviewed
URL directly in `repositoryUrl`; no URL environment setup is required. For a
private source, `credentialEnv` contains only the user-selected `GLAB_TOKEN` or
`GITLAB_TOKEN` variable name, never its value. The ref and commit are immutable.
Use the exact content transport, then stage it:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind source-checkout --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind source-checkout
```

Apply the [review transaction](review-and-safety.md#review-transaction). After
exact approval, perform the one-use bare, shallow, no-lazy-fetch checkout:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-checkout.mjs" --session-handle <handle> --checkout-id <checkout-id>
```

Never run a second clone/fetch command or read its protected storage directly.
Inventory and read only through:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <source> --checkout-id <checkout-id> --list
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <source> --checkout-id <checkout-id> --path <safe-relative-path>
```

Use `git` without a credential selector when the reviewed source is public or
an existing credential helper suffices. A private checkout may use only the
user-selected `GLAB_TOKEN` or `GITLAB_TOKEN` selector with the `glab` transport;
never expose its value. TLS verification stays enabled. If and only if the
exact HTTPS Git source cannot otherwise be read, record the user's explicit
one-source, one-operation risk acknowledgement in the staged document; the
helper may apply an invocation-scoped override and never a global one.
