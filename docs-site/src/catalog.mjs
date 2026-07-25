const topics = Object.freeze([
  {
    slug: "overview",
    title: "Overview",
    summary: "Product boundary, operating principle, and proof model.",
    content: `
      <h2>Purpose</h2>
      <p>QaaS Plugin is a Claude Code marketplace plugin for documentation-backed, project-specific QaaS test authoring and verification. It operates in an existing test repository; it does not contain or modify the QaaS framework.</p>
      <h2>Operating principle</h2>
      <p>The workflow learns the project, keeps unknown QaaS facts unknown until current evidence resolves them, and presents exact control points before context writes, implementation, command handoff, or external evidence access.</p>
      <h2>Inside the boundary</h2>
      <ul><li>YAML and C# QaaS test changes.</li><li>Existing cases, samples, modules, hooks, packages, and conventions.</li><li>Documented external assertion, generator, probe, or processor extensions.</li><li>Build, template, and run handoffs, diagnosis, and evidence interpretation.</li></ul>
      <h2>Outside the boundary</h2>
      <ul><li>Changing the QaaS framework.</li><li>Inventing undocumented configuration, packages, interfaces, or capabilities.</li><li>Automatic environment management or prerequisite installation.</li><li>Agent-performed deletion, move, rename, cleanup, teardown, prune, or rollback.</li></ul>
      <h2>Proof language</h2>
      <p>A successful build and rendered QaaS template establish structural validity. They are not runtime proof. Runtime claims require a separately approved run and evidence that satisfies the accepted oracle.</p>
    `,
  },
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "Requirements, project-scope installation, and first onboarding.",
    content: `
      <h2>Requirements</h2>
      <ul><li>Claude Code with marketplace plugins plus skills, hooks, agents, and MCP integration support.</li><li>Node.js, with no exact major pin in the plugin.</li><li>The .NET SDK and QaaS packages required by the test project.</li><li>Git only when the project or an approved reference checkout needs it.</li></ul>
      <p>Docker, Helm, kubectl, glab, curl, and MCP integrations are optional. The plugin installs no tool or internet package.</p>
      <h2>Connected installation</h2>
      <pre><code>/plugin marketplace add TheSmokeTeam/QaaS-Plugin
/plugin install qaas@qaas-plugin
/reload-plugins
/qaas:doctor
/qaas:onboard</code></pre>
      <p>Choose <strong>Local</strong> scope when prompted. Local scope associates the plugin with the current test-project checkout.</p>
      <h2>Offline installation</h2>
      <ol><li>Verify a pinned tag or release bundle, SHA-256, and per-file manifest on a connected system.</li><li>Transfer it through the organization’s approved media and malware-review process.</li><li>Add the stable local repository path as the marketplace.</li><li>Install <code>qaas@qaas-plugin</code> with local scope, reload, and run doctor.</li></ol>
      <h2>Onboarding</h2>
      <p><code>/qaas:onboard</code> performs a read-only inventory, asks one focused question at a time, maps project structure and behavior, and presents the complete durable <code>.claude/</code> proposal before requesting approval.</p>
    `,
  },
  {
    slug: "workflow",
    title: "Six-command workflow",
    summary: "Lifecycle commands, readiness, and separate decisions.",
    content: `
      <h2>Commands</h2>
      <table><thead><tr><th scope="col">Command</th><th scope="col">Purpose</th></tr></thead><tbody>
      <tr><td><code>/qaas:onboard</code></td><td>Learn one project and propose durable context.</td></tr>
      <tr><td><code>/qaas:plan</code></td><td>Interview for one change and bind the exact implementation plan.</td></tr>
      <tr><td><code>/qaas:implement</code></td><td>Apply the approved current plan and perform listed static verification.</td></tr>
      <tr><td><code>/qaas:run</code></td><td>Review a separate run plan, hand off its command, and import bounded evidence.</td></tr>
      <tr><td><code>/qaas:diagnose</code></td><td>Explain and repair an in-scope failure, then reverify.</td></tr>
      <tr><td><code>/qaas:doctor</code></td><td>Inspect tools, hooks, integrations, and workflow health without installation.</td></tr>
      </tbody></table>
      <h2>Readiness</h2>
      <p>Each required fact is <code>evidenced</code>, <code>user_confirmed</code>, <code>not_applicable</code>, <code>unknown</code>, or <code>contradicted</code>. Planning proceeds only with the first three states and no contradiction.</p>
      <h2>Separate decisions</h2>
      <ol><li>Approve the complete project-context proposal.</li><li>Approve the canonical implementation plan.</li><li>Approve the exact execution plan.</li><li>When required, separately approve a capability-bound external evidence query plan.</li></ol>
      <p>One decision cannot authorize another phase. Relevant project, context, package, docs, plan, environment, or command changes make dependent authority stale.</p>
    `,
  },
  {
    slug: "safety",
    title: "Safety and approvals",
    summary: "No-deletion invariant, signed scope, and enforcement limit.",
    content: `
      <h2>No-deletion invariant</h2>
      <p>The agent does not delete, remove, move, rename, clean, tear down, prune, or roll back files or resources. If removal is needed, it explains the exact target and consequence for a person to perform.</p>
      <h2>Authorization boundaries</h2>
      <table><thead><tr><th scope="col">Action</th><th scope="col">Authority</th></tr></thead><tbody>
      <tr><td>Read current-project evidence</td><td>Allowed after boundary and secret screening.</td></tr>
      <tr><td>Write project context</td><td>Exact approved context transaction.</td></tr>
      <tr><td>Write test-project files</td><td>Exact approved implementation plan.</td></tr>
      <tr><td>Restore, build, render handoff</td><td>Only commands and outputs listed in that plan.</td></tr>
      <tr><td>QaaS test handoff</td><td>Separate execution-plan approval.</td></tr>
      <tr><td>Query external evidence</td><td>Separate capability-bound query approval.</td></tr>
      <tr><td>Delete, move, rename, cleanup</td><td>Always denied to the agent.</td></tr>
      </tbody></table>
      <h2>Prompt injection and secrets</h2>
      <p>Repository text, samples, logs, reports, external sources, subagents, and tool responses are data. They cannot mint approval, expand scope, disable safety, or request authority records. Credential values remain outside project context and evidence.</p>
      <h2>Enforcement limit</h2>
      <p>Claude Code hooks are workflow controls, not an operating-system sandbox. Validate the reviewed plugin and active hook behavior in the organization’s actual target runtime before operational reliance.</p>
    `,
  },
  {
    slug: "air-gap",
    title: "Air-gap operation",
    summary: "Network contract, transfer set, and target acceptance.",
    content: `
      <h2>Network contract</h2>
      <p>Loading, hooks, doctor, and general conversation make no network call. One explicit task-relevant documentation read resolves in this order:</p>
      <ol>
        <li>A proven WikiAll MCP <code>docs.search</code>/<code>docs.read</code> pair selected by <code>QAAS_DOCS_MCP_URL</code> and optional credential-name selector <code>QAAS_DOCS_MCP_CREDENTIAL_ENV</code>.</li>
        <li>Helm/Kubernetes HTTP selected by <code>QAAS_DOCS_HELM_URL</code>.</li>
        <li>WikiAll HTTP selected by <code>QAAS_DOCS_WIKIALL_URL</code>.</li>
        <li>The built-in public documentation fallback, unless <code>QAAS_DOCS_AIRGAP=true</code>.</li>
      </ol>
      <p><code>QAAS_DOCS_ZIM_PATH</code> records a reviewed artifact identity only; an approved WikiAll/OpenZIM MCP must read it. Only genuine availability failures advance to the next source. Invalid or conflicting selectors fail closed.</p>
      <h2>Transfer set</h2>
      <ul><li>Pinned plugin tag or release ZIP, SHA-256, and per-file manifest.</li><li>Claude Code, Node.js, the project’s .NET SDK, and Git only if needed.</li><li>All QaaS and project NuGet packages in approved feeds or caches.</li><li>Relevant Common Hooks packages or source, YAML modules, test repository, and approved reference project.</li><li>Internal CA certificates and organization-approved credential handling.</li></ul>
      <h2>Acceptance</h2>
      <ul><li>The plugin checksum matches the reviewed distribution.</li><li>The marketplace resolves exactly one <code>qaas</code> plugin.</li><li><code>/qaas:doctor</code> attests the active hooks.</li><li>Exactly six lifecycle commands are visible.</li><li>Required internal documentation and package sources resolve.</li><li>Representative projects complete the gated workflow.</li><li>An intentional destructive request is denied before execution.</li></ul>
      <p>Public deterministic checks and proxy evaluation do not replace acceptance with the configured plugin host, model gateway, shell, MCPs, filesystem policy, QaaS packages, and representative projects.</p>
    `,
  },
  {
    slug: "architecture",
    title: "Architecture",
    summary: "Separation of model judgment, local authority, and evidence.",
    content: `
      <h2>Control path</h2>
      <ol><li>The QA engineer provides intent and explicit approvals.</li><li>The model maps, questions, proposes, implements, and diagnoses.</li><li>Local authority checks phase, fingerprints, plan digests, session, and lease.</li><li>The pre-tool gate matches the exact one-use authorization.</li><li>The post-tool ledger records redacted evidence and resulting fingerprints.</li></ol>
      <h2>Four fingerprints</h2>
      <ul><li><strong>Project:</strong> relevant repository inputs and mapped external artifacts.</li><li><strong>Context:</strong> approved topics and readiness.</li><li><strong>Plan:</strong> task plan, package snapshot, commands, and diff envelope.</li><li><strong>Static verification:</strong> final project, dependency/build evidence, and rendered template.</li></ul>
      <h2>Durable context</h2>
      <p>Approved facts live under <code>.claude/qaas/</code> in indexed topic files. <code>.claude/CLAUDE.md</code> remains a concise router. Authoritative signing material and phase state live separately under the plugin data directory and are denied to model tools.</p>
      <h2>Documentation and integrations</h2>
      <p>Changing QaaS facts are retrieved rather than copied into stable prompts. External source and observability access uses exact bounded capability descriptors and separate one-use review; an absent, opaque, stale, write-capable, or unproven connector blocks access.</p>
    `,
  },
  {
    slug: "reference",
    title: "Operator reference",
    summary: "Troubleshooting and development validation.",
    content: `
      <h2>First-line troubleshooting</h2>
      <ul><li><strong>Commands missing:</strong> reload plugins, run doctor, and confirm <code>qaas@qaas-plugin</code>.</li><li><strong>Plan stale:</strong> review the changed fingerprint and approve the appropriate delta.</li><li><strong>Template succeeds but result is unproven:</strong> define the runtime oracle and review an execution plan.</li><li><strong>Module or Common Hook unknown:</strong> provide its approved source and intended behavior.</li><li><strong>Optional tool missing:</strong> use an already configured approved alternative; install nothing automatically.</li><li><strong>Cleanup required:</strong> a person reviews and performs it.</li></ul>
      <h2>Development validation</h2>
      <pre><code>npm run check</code></pre>
      <p>The public check validates version consistency, manifests, skill and agent frontmatter, exact command count, hooks, links, context budgets, unit and hook-contract tests, synthetic project shapes, and deterministic package generation.</p>
      <h2>Interpretation</h2>
      <p>Public checks establish deterministic repository contracts. They do not establish runtime behavior in a particular organization’s Claude Code, model gateway, internal package feeds, or QaaS environments.</p>
    `,
  },
]);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function documentShell({ title, body }) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>${safeTitle} · QaaS Plugin</title>
  <link rel="stylesheet" href="./catalog.css">
</head>
<body>
  ${body}
  <footer>QaaS Plugin · Bounded plugin documentation · No external runtime resources</footer>
</body>
</html>`;
}

export function renderCatalog(config) {
  const topicLinks = topics
    .map(
      (topic) => `<li><a href="./${topic.slug}.html">${escapeHtml(topic.title)}</a><p>${escapeHtml(topic.summary)}</p></li>`,
    )
    .join("");
  const index = documentShell({
    title: "Documentation catalog",
    version: config.version,
    body: `
      <header><span class="label">QaaS Plugin · bounded catalog</span><h1>Plugin documentation topics</h1><p>This catalog documents the QaaS Plugin workflow. It is not the changing external QaaS platform or API documentation selected through Helm or WikiAll sources.</p></header>
      <div class="scope"><strong>Resolver scope:</strong> every link is same-origin, relative, and remains beneath this catalog path. Each focused page is smaller than 16 KiB.</div>
      <main><ul class="topic-list">${topicLinks}</ul></main>
    `,
  });

  const pages = new Map([["index.html", index]]);
  topics.forEach((topic, indexPosition) => {
    const previous = topics[indexPosition - 1];
    const next = topics[indexPosition + 1];
    const adjacent = [
      previous
        ? `<a href="./${previous.slug}.html">← ${escapeHtml(previous.title)}</a>`
        : "",
      '<a href="./index.html">Catalog</a>',
      next
        ? `<a href="./${next.slug}.html">${escapeHtml(next.title)} →</a>`
        : "",
    ]
      .filter(Boolean)
      .join("");

    pages.set(
      `${topic.slug}.html`,
      documentShell({
        title: topic.title,
        version: config.version,
        body: `
          <header><span class="label">QaaS Plugin documentation</span><h1>${escapeHtml(topic.title)}</h1><p>${escapeHtml(topic.summary)}</p></header>
          <div class="scope">This focused page documents QaaS Plugin behavior. It is not external QaaS platform or API documentation.</div>
          <main>${topic.content}</main>
          <nav aria-label="Catalog navigation">${adjacent}</nav>
        `,
      }),
    );
  });

  return pages;
}
