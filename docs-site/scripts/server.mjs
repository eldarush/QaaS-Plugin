import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectDirectory,
  renderTemplate,
  resolveConfig,
} from "./build.mjs";
import { renderCatalog } from "../src/catalog.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const templatePath = path.join(projectDirectory, "src", "index.template.html");
const distDirectory = path.join(projectDirectory, "dist");

const staticFiles = Object.freeze({
  "/assets/site.css": {
    path: path.join(distDirectory, "assets", "site.css"),
    type: "text/css; charset=utf-8",
  },
  "/assets/app.js": {
    path: path.join(distDirectory, "assets", "app.js"),
    type: "text/javascript; charset=utf-8",
  },
  "/assets/demo/workflow-capture.png": {
    path: path.join(
      distDirectory,
      "assets",
      "demo",
      "workflow-capture.png",
    ),
    type: "image/png",
  },
  "/assets/demo/evidence-capture.png": {
    path: path.join(
      distDirectory,
      "assets",
      "demo",
      "evidence-capture.png",
    ),
    type: "image/png",
  },
  "/catalog/catalog.css": {
    path: path.join(distDirectory, "catalog", "catalog.css"),
    type: "text/css; charset=utf-8",
  },
});

const securityHeaders = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function textResponse(response, statusCode, body, contentType, method) {
  const bytes = Buffer.from(body);
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Length": bytes.byteLength,
    "Content-Type": contentType,
  });

  if (method === "HEAD") {
    response.end();
  } else {
    response.end(bytes);
  }
}

function routeSuffix(pathname) {
  for (const candidate of Object.keys(staticFiles)) {
    if (pathname.endsWith(candidate)) {
      return candidate;
    }
  }
  return null;
}

function catalogFileName(pathname, availablePages) {
  const marker = "/catalog/";
  const markerIndex = pathname.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const remainder = pathname.slice(markerIndex + marker.length);
  const candidate = remainder === "" ? "index.html" : remainder;
  if (candidate.includes("/") || !availablePages.has(candidate)) {
    return null;
  }

  return candidate;
}

export async function startServer({
  env = process.env,
  host = env.HOST ?? "0.0.0.0",
  port = Number.parseInt(env.PORT ?? "8080", 10),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 through 65535.");
  }

  const [config, template] = await Promise.all([
    resolveConfig({ env, includeLocal: false }),
    readFile(templatePath, "utf8"),
  ]);
  const renderedIndex = renderTemplate(template, config);
  const renderedCatalog = renderCatalog(config);

  for (const asset of Object.values(staticFiles)) {
    const result = await stat(asset.path);
    if (!result.isFile()) {
      throw new Error(`Missing built asset: ${asset.path}`);
    }
  }

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (!["GET", "HEAD"].includes(method)) {
      response.setHeader("Allow", "GET, HEAD");
      textResponse(
        response,
        405,
        "Method not allowed\n",
        "text/plain; charset=utf-8",
        method,
      );
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      textResponse(
        response,
        400,
        "Bad request\n",
        "text/plain; charset=utf-8",
        method,
      );
      return;
    }

    if (pathname === "/healthz") {
      textResponse(
        response,
        200,
        `${JSON.stringify({ status: "ok", version: config.version })}\n`,
        "application/json; charset=utf-8",
        method,
      );
      return;
    }

    const catalogPage = catalogFileName(pathname, renderedCatalog);
    if (catalogPage) {
      textResponse(
        response,
        200,
        renderedCatalog.get(catalogPage),
        "text/html; charset=utf-8",
        method,
      );
      return;
    }

    const suffix = routeSuffix(pathname);
    if (suffix) {
      const asset = staticFiles[suffix];
      const result = await stat(asset.path);
      response.writeHead(200, {
        ...securityHeaders,
        "Cache-Control": "public, max-age=3600",
        "Content-Length": result.size,
        "Content-Type": asset.type,
      });

      if (method === "HEAD") {
        response.end();
      } else {
        createReadStream(asset.path).pipe(response);
      }
      return;
    }

    if (pathname.endsWith("/") || pathname.endsWith("/index.html")) {
      textResponse(
        response,
        200,
        renderedIndex,
        "text/html; charset=utf-8",
        method,
      );
      return;
    }

    textResponse(
      response,
      404,
      "Not found\n",
      "text/plain; charset=utf-8",
      method,
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const listeningPort =
    address && typeof address === "object" ? address.port : port;

  return Object.freeze({ config, host, port: listeningPort, server });
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

if (invokedDirectly) {
  try {
    const running = await startServer();
    console.log(
      `Serving ${running.config.title} ${running.config.version} on ${running.host}:${running.port}`,
    );

    const close = () => {
      running.server.close((error) => {
        process.exitCode = error ? 1 : 0;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
