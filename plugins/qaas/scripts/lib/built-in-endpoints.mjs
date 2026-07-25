import { sha256 } from "./canonical-json.mjs";

// Distribution-build contract: replace only these centrally reviewed values
// when producing an organization-specific air-gapped bundle.
export const BUILT_IN_QAAS_DOCS_URL = "https://docs.qaas.online/";

const ENDPOINTS = Object.freeze({
  docs: BUILT_IN_QAAS_DOCS_URL,
});

export function builtInEndpoint(name) {
  const value = ENDPOINTS[name];
  if (!value) throw new Error(`Unknown built-in QaaS endpoint: ${name}`);
  const url = new URL(value);
  return Object.freeze({
    kind: "distribution-built-in",
    name,
    url: url.toString(),
    protocol: url.protocol,
    origin: url.origin,
    pathname: url.pathname,
    urlDigest: sha256(url.toString()),
  });
}
