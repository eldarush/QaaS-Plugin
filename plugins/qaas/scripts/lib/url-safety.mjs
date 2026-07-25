import { secretFindings } from "./redact.mjs";

const CREDENTIAL_QUERY_KEY =
  /(?:token|secret|password|passwd|api[-_]?key|signature|credential|auth|cookie|private[-_]?key)/iu;
const HIGH_ENTROPY_QUERY_VALUE =
  /^(?=.{24,256}$)(?=.*[A-Za-z]|\d)(?:[A-Fa-f0-9]{24,}|[A-Za-z0-9._~+/=-]{24,})$/u;

export function assertCredentialFreeQueryParameters(url, label = "URL") {
  if (!(url instanceof URL)) {
    throw new Error(`${label} must be a parsed URL`);
  }
  for (const [key, value] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      throw new Error(`${label} may not carry credential query parameters`);
    }
    if (
      secretFindings(value).length > 0 ||
      HIGH_ENTROPY_QUERY_VALUE.test(value)
    ) {
      throw new Error(`${label} contains a secret-like query value`);
    }
  }
}
