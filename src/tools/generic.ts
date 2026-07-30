import { z } from "zod";
import { defineTool } from "../tool.js";

/**
 * DSM exposes several hundred APIs and Synology only documents a fraction of
 * them. Curated tools cover the common ground; these two make the rest
 * reachable without shipping a tool per API.
 *
 * The bridge is not a privilege escalation: every call still runs as the
 * configured DSM account and is subject to its permissions. It is gated behind
 * SYNOLOGY_ALLOW_GENERIC_API only because it bypasses the path allowlist and
 * the read-only checks that the curated tools apply.
 */
export const genericTools = [
  defineTool({
    name: "list_dsm_apis",
    title: "Discover available DSM APIs",
    description:
      "Lists the DSM WebAPI endpoints this NAS exposes, with their supported version range. Use this to discover capabilities that have no dedicated tool, then call them with call_dsm_api. Filter with a query such as 'Certificate', 'Backup', 'Drive' or 'SurveillanceStation'.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the API name"),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: async (ctx, args) => {
      const info = await ctx.client.getApiInfo();
      const needle = args.query?.toLowerCase();

      const matches = Object.entries(info)
        .filter(([name]) => !needle || name.toLowerCase().includes(needle))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, args.limit)
        .map(([name, descriptor]) => ({
          api: name,
          minVersion: descriptor.minVersion,
          maxVersion: descriptor.maxVersion,
        }));

      return {
        totalAvailable: Object.keys(info).length,
        returned: matches.length,
        apis: matches,
        note: ctx.policy.allowGenericApi
          ? "Call any of these with call_dsm_api."
          : "call_dsm_api is currently disabled, so these are informational only. Set SYNOLOGY_ALLOW_GENERIC_API=true to invoke them.",
      };
    },
  }),

  defineTool({
    name: "call_dsm_api",
    title: "Call any DSM WebAPI method",
    description:
      "Invokes an arbitrary DSM WebAPI method. This is the escape hatch for Synology features that have no dedicated tool, such as Surveillance Station, Hyper Backup, certificates, users, firewall or Synology Drive. Discover the API name with list_dsm_apis first. The call runs as the configured DSM account and inherits its permissions. Disabled unless SYNOLOGY_ALLOW_GENERIC_API=true.",
    schema: z.object({
      api: z
        .string()
        .min(1)
        .describe("Full API name, e.g. SYNO.Core.Certificate.CRT"),
      method: z.string().min(1).describe("Method name, e.g. list"),
      version: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Omit to use the highest version this DSM supports"),
      parameters: z
        .record(z.unknown())
        .default({})
        .describe(
          "Method parameters. Arrays and objects are JSON-encoded automatically, as DSM expects.",
        ),
      httpMethod: z.enum(["GET", "POST"]).optional(),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertGenericApi(args.api);

      // The read-only switch is the operator's strongest signal of intent, so
      // it still applies here even though the path allowlist cannot.
      const looksMutating =
        /^(create|add|set|edit|update|delete|remove|start|stop|restart|reboot|shutdown|upload|write|clear|reset|apply|enable|disable|install|uninstall|upgrade)/i.test(
          args.method,
        );
      if (looksMutating) {
        ctx.policy.assertWritable(`call_dsm_api(${args.api}.${args.method})`);
      }

      const data = await ctx.client.request(
        args.api,
        args.method,
        args.parameters as Record<string, unknown>,
        { version: args.version, method: args.httpMethod },
      );

      return { api: args.api, method: args.method, data };
    },
  }),
];
