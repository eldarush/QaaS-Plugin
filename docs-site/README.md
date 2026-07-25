# QaaS Plugin docs site

A dependency-free, hash-routed documentation site for QaaS Plugin. Visible
guidance stays evergreen; the configured release version remains non-visible
build and health metadata. The source and every runtime asset live here.

## Build and test

A Node.js runtime with the ES module, filesystem, and built-in web APIs used by
the scripts is the only requirement. No package installation or network access
is needed.

```powershell
npm run check
```

The deployable GitHub Pages artifact is `dist/`. It contains:

```text
dist/
├── .nojekyll
├── index.html
├── catalog/
│   ├── catalog.css
│   ├── index.html
│   └── <focused-topic>.html
└── assets/
    ├── app.js
    ├── site.css
    └── demo/
        ├── evidence-capture.png
        └── workflow-capture.png
```

All asset references are relative and all documentation routes use URL
fragments, so the same artifact works at a domain root or any repository
subpath.

The main surface follows the operating-system color preference by default. Its
keyboard-accessible theme control cycles through Auto, Light, and Dark and
stores only that local preference. The compact catalog remains script-free and
follows the operating-system preference.

`src/assets/demo/` contains two reviewed, privacy-safe PNGs captured from the
actual Windows terminal running the controlled Codex proxy with scripted
operator input and a synthetic fixture. They are not customer content or live
Claude Code/QaaS runtime evidence. Replacements require the same privacy review,
literal-terminal provenance, and offline-only resource contract.

`catalog/` is a separate bounded index for machines that need focused plugin
documentation. Its index and every topic page are at most 16 KiB, and every
anchor stays relative and beneath the catalog path. It is explicitly QaaS
Plugin documentation—not the changing external QaaS platform or API
documentation identified by Helm or WikiAll configuration.

## Local preview

Build first, then start the built-in server:

```powershell
npm run build
npm run serve
```

The server listens on `0.0.0.0:8080` by default and exposes a JSON health check
at `/healthz`. Set `HOST` or `PORT` to change the listener.

## Configuration

Defaults live in `site.config.json`. An untracked `site.config.local.json`
overrides them for local builds. `QAAS_DOCS_CONFIG` can instead identify one
complete JSON configuration file.

Environment variables have final precedence:

| Variable | Purpose |
| --- | --- |
| `QAAS_PLUGIN_REPOSITORY_URL` | The sole external anchor in the rendered site |
| `QAAS_PLUGIN_VERSION` | Compact operator build metadata |
| `QAAS_DOCS_HELM_URL` | Injected metadata for an external QaaS Helm documentation source |
| `QAAS_DOCS_WIKIALL_URL` | Injected metadata for an external QaaS WikiAll documentation source |
| `QAAS_DOCS_TITLE` | Site title |
| `QAAS_DOCS_DESCRIPTION` | Metadata description |
| `QAAS_DOCS_OUTPUT_DIR` | Build output below `docs-site/` |

`QAAS_DOCS_REPOSITORY_URL` and `QAAS_DOCS_VERSION` remain supported as
docs-specific aliases. Repository URLs must use HTTPS and all URL inputs reject
embedded credentials and fragments.

The container server resolves the same variables at startup and renders the HTML
in memory. It does not rewrite the image filesystem. Helm and WikiAll values
identify separate QaaS platform/API documentation sources; this plugin
documentation UI records them only as configuration metadata. Browser code
never turns them into links or network requests.

The catalog stylesheet is a local external asset so both the container's strict
Content Security Policy and GitHub Pages render the same design without
allowing inline style.

## Container

Build with this directory as the context:

```powershell
docker build -t qaas-plugin-docs:local .
docker run --read-only --tmpfs /tmp --cap-drop=ALL -p 8080:8080 qaas-plugin-docs:local
```

The image runs as the upstream unprivileged `node` user, listens on port 8080,
includes an image health check, and needs no writable filesystem or external
runtime resource.
