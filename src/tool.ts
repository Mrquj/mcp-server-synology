import type { z } from "zod";
import type { DsmClient } from "./client.js";
import type { SecurityPolicy } from "./security.js";

export type ToolContext = {
  client: DsmClient;
  policy: SecurityPolicy;
};

/**
 * Schema and handler live together so a tool cannot drift from its contract,
 * and so the policy flags that gate it are visible at the definition site.
 */
export type ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  schema: S;
  /** Advertised to clients so they can auto-approve safe calls. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  handler: (ctx: ToolContext, args: z.infer<S>) => Promise<unknown>;
};

/** Preserves the argument type of each tool while allowing a mixed array. */
export function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

/** DSM returns bytes; humans read sizes. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** DSM timestamps are seconds since epoch, and 0 means "unset". */
export function isoTime(seconds?: number): string | undefined {
  if (!seconds) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** File Station wants a JSON array literal even for a single path. */
export function pathParam(paths: string[]): string {
  return JSON.stringify(paths);
}
