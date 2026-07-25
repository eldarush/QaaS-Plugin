import { createHash, timingSafeEqual } from "node:crypto";

function assertJsonValue(value, path, seen) {
  if (value === null) return;

  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }
    return;
  }
  if (type !== "object") {
    throw new TypeError(`Non-JSON value at ${path}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`Cyclic value at ${path}`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Sparse array at ${path}[${index}]`);
      }
      assertJsonValue(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function serialize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`)
    .join(",")}}`;
}

/**
 * Produces a stable JSON representation with lexicographically sorted object
 * keys. Inputs are deliberately restricted to the JSON data model.
 */
export function canonicalJson(value) {
  assertJsonValue(value, "$", new Set());
  return serialize(value);
}

export function sha256(value) {
  const input =
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : canonicalJson(value);
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalDigest(value, omittedKeys = ["digest", "signature"]) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    return sha256(value);
  }
  const copy = Object.fromEntries(
    Object.entries(value).filter(([key]) => !omittedKeys.includes(key)),
  );
  return sha256(copy);
}

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function safeEqualHex(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^[a-f0-9]+$/iu.test(left) ||
    !/^[a-f0-9]+$/iu.test(right) ||
    left.length !== right.length ||
    left.length % 2 !== 0
  ) {
    return false;
  }
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

