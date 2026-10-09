import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type {
  ClaimKind,
  DecodedResolveEvent,
  Outcome,
  RawIndexerEvent,
  Side,
} from "../types.js";

const EVENT_NAMES = new Set([
  "market_created",
  "staked",
  "market_resolved",
  "market_invalidated",
  "claimed",
]);

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/**
 * Decode a Resolve contract event from RPC getEvents payload.
 *
 * Soroban #[contractevent] typically encodes:
 * - topics[0] = event name Symbol (snake_case)
 * - topics[1..] = #[topic] fields
 * - value = Map or Vec of remaining data fields
 *
 * This decoder is intentionally resilient to Map vs Vec data and
 * string/number/bigint numeric variants.
 */
export function decodeResolveEvent(
  raw: RawIndexerEvent,
): DecodedResolveEvent | null {
  const topics = raw.topics.map(normalizeTopic);
  if (topics.length === 0) return null;

  const eventName = asSymbolName(topics[0]);
  if (!eventName || !EVENT_NAMES.has(eventName)) {
    return null;
  }

  const data = normalizeData(raw.value);

  switch (eventName) {
    case "market_created":
      return decodeMarketCreated(topics, data);
    case "staked":
      return decodeStaked(topics, data);
    case "market_resolved":
      return decodeMarketResolved(topics, data);
    case "market_invalidated":
      return decodeMarketInvalidated(topics, data);
    case "claimed":
      return decodeClaimed(topics, data);
    default:
      return null;
  }
}

function decodeMarketCreated(
  topics: unknown[],
  data: Record<string, unknown>,
): DecodedResolveEvent {
  const marketId = requireU64(topics[1], "market_id");
  const creator = requireAddress(topics[2], "creator");
  return {
    eventName: "market_created",
    marketId,
    creator,
    resolver: requireAddress(
      pick(data, ["resolver", "0"]),
      "resolver",
    ),
    token: requireAddress(pick(data, ["token", "1"]), "token"),
    closeAt: requireU64(pick(data, ["close_at", "2"]), "close_at"),
    resolutionTimeout: requireU64(
      pick(data, ["resolution_timeout", "3"]),
      "resolution_timeout",
    ),
  };
}

function decodeStaked(
  topics: unknown[],
  data: Record<string, unknown>,
): DecodedResolveEvent {
  return {
    eventName: "staked",
    marketId: requireU64(topics[1], "market_id"),
    user: requireAddress(topics[2], "user"),
    side: requireSide(pick(data, ["side", "0"])),
    amount: requireI128(pick(data, ["amount", "1"]), "amount"),
    yesPool: requireI128(pick(data, ["yes_pool", "2"]), "yes_pool"),
    noPool: requireI128(pick(data, ["no_pool", "3"]), "no_pool"),
  };
}

function decodeMarketResolved(
  topics: unknown[],
  data: Record<string, unknown>,
): DecodedResolveEvent {
  return {
    eventName: "market_resolved",
    marketId: requireU64(topics[1], "market_id"),
    resolver: requireAddress(topics[2], "resolver"),
    outcome: requireOutcome(pick(data, ["outcome", "0"])),
  };
}

function decodeMarketInvalidated(
  topics: unknown[],
  _data: Record<string, unknown>,
): DecodedResolveEvent {
  return {
    eventName: "market_invalidated",
    marketId: requireU64(topics[1], "market_id"),
    caller: requireAddress(topics[2], "caller"),
  };
}

function decodeClaimed(
  topics: unknown[],
  data: Record<string, unknown>,
): DecodedResolveEvent {
  return {
    eventName: "claimed",
    marketId: requireU64(topics[1], "market_id"),
    user: requireAddress(topics[2], "user"),
    amount: requireI128(pick(data, ["amount", "0"]), "amount"),
    kind: requireClaimKind(pick(data, ["kind", "1"])),
  };
}

function normalizeTopic(topic: unknown): unknown {
  if (topic == null) return topic;
  if (typeof topic === "string") {
    // RPC may return base64 XDR or already-native JSON
    try {
      const scv = xdr.ScVal.fromXDR(topic, "base64");
      return scValToNative(scv);
    } catch {
      return topic;
    }
  }
  if (typeof topic === "object" && topic !== null && "toXDR" in topic) {
    try {
      return scValToNative(topic as xdr.ScVal);
    } catch {
      return topic;
    }
  }
  // Already native / JSON-decoded
  if (isScValLike(topic)) {
    try {
      return scValToNative(topic as xdr.ScVal);
    } catch {
      /* fall through */
    }
  }
  return topic;
}

function normalizeData(value: unknown): Record<string, unknown> {
  if (value == null) return {};

  let native: unknown = value;
  if (typeof value === "string") {
    try {
      native = scValToNative(xdr.ScVal.fromXDR(value, "base64"));
    } catch {
      try {
        native = JSON.parse(value);
      } catch {
        return {};
      }
    }
  } else if (isScValLike(value)) {
    try {
      native = scValToNative(value as xdr.ScVal);
    } catch {
      /* keep */
    }
  }

  if (Array.isArray(native)) {
    const out: Record<string, unknown> = {};
    native.forEach((v, i) => {
      out[String(i)] = v;
    });
    return out;
  }

  if (native && typeof native === "object") {
    // Map may arrive as Map instance or plain object / entries
    if (native instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of native.entries()) {
        out[String(k)] = v;
      }
      return out;
    }
    return { ...(native as Record<string, unknown>) };
  }

  return { "0": native };
}

function pick(
  data: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const k of keys) {
    if (k in data && data[k] !== undefined) return data[k];
  }
  // Case-insensitive / snake vs camel
  const lower = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const k of keys) {
    if (k.toLowerCase() in lower) return lower[k.toLowerCase()];
  }
  return undefined;
}

function asSymbolName(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "sym" in (v as object)) {
    return String((v as { sym: unknown }).sym);
  }
  return null;
}

function requireU64(v: unknown, field: string): bigint {
  if (v === undefined || v === null) {
    throw new DecodeError(`missing ${field}`);
  }
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new DecodeError(`invalid ${field}: ${String(v)}`);
}

function requireI128(v: unknown, field: string): bigint {
  return requireU64(v, field);
}

function requireAddress(v: unknown, field: string): string {
  if (v === undefined || v === null) {
    throw new DecodeError(`missing ${field}`);
  }
  if (typeof v === "string") {
    // Already strkey or contract address string
    return v;
  }
  if (v instanceof Address) {
    return v.toString();
  }
  // stellar-sdk scValToNative may return Address-like
  if (v && typeof v === "object" && "toString" in v) {
    const s = String(v);
    if (s.startsWith("G") || s.startsWith("C")) return s;
  }
  throw new DecodeError(`invalid ${field}: ${String(v)}`);
}

function requireSide(v: unknown): Side {
  const n = enumToNumber(v);
  if (n === 0 || v === "Yes" || v === "yes") return "yes";
  if (n === 1 || v === "No" || v === "no") return "no";
  throw new DecodeError(`invalid side: ${String(v)}`);
}

function requireOutcome(v: unknown): Outcome {
  const n = enumToNumber(v);
  if (n === 0 || v === "Yes" || v === "yes") return "yes";
  if (n === 1 || v === "No" || v === "no") return "no";
  if (n === 2 || v === "Invalid" || v === "invalid") return "invalid";
  throw new DecodeError(`invalid outcome: ${String(v)}`);
}

function requireClaimKind(v: unknown): ClaimKind {
  const n = enumToNumber(v);
  if (n === 0 || v === "Payout" || v === "payout") return "payout";
  if (n === 1 || v === "Refund" || v === "refund") return "refund";
  throw new DecodeError(`invalid claim kind: ${String(v)}`);
}

function enumToNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    if (/^-?\d+$/.test(v)) return Number(v);
    const label = v.toLowerCase();
    if (label === "yes" || label === "payout") return 0;
    if (label === "no" || label === "refund") return 1;
    if (label === "invalid") return 2;
  }
  // Soroban contract enums are commonly decoded from ScVal as a one-item
  // vector, for example ["Yes"] or ["Payout"].
  if (Array.isArray(v) && v.length === 1) {
    return enumToNumber(v[0]);
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Enum object forms: { tag: "Yes" } or { Yes: void } or { _enum: ... }
    if ("tag" in obj && typeof obj.tag === "string") {
      const tag = obj.tag.toLowerCase();
      if (tag === "yes" || tag === "payout") return 0;
      if (tag === "no" || tag === "refund") return 1;
      if (tag === "invalid") return 2;
    }
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const k = keys[0]!.toLowerCase();
      if (k === "yes" || k === "payout") return 0;
      if (k === "no" || k === "refund") return 1;
      if (k === "invalid") return 2;
    }
  }
  return null;
}

function isScValLike(v: unknown): boolean {
  return Boolean(
    v &&
      typeof v === "object" &&
      ("_switch" in (v as object) || "switch" in (v as object)),
  );
}

/** Build a synthetic raw event for unit tests (native JS payloads). */
export function syntheticRawEvent(
  topics: unknown[],
  value: unknown,
  meta?: Partial<Pick<RawIndexerEvent, "txHash" | "eventIndex" | "ledger">>,
): RawIndexerEvent {
  return {
    txHash: meta?.txHash ?? "0".repeat(64),
    eventIndex: meta?.eventIndex ?? 0,
    ledger: meta?.ledger ?? 1,
    topics,
    value,
  };
}
