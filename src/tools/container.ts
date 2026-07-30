import { z } from "zod";
import { defineTool, humanBytes } from "../tool.js";

/**
 * Container Manager (Docker) on DSM 7. These APIs are only present when the
 * package is installed, so every tool here fails with a clear "API does not
 * exist" message rather than a crash when it is not.
 */
export const containerTools = [
  defineTool({
    name: "list_containers",
    title: "List Docker containers",
    description:
      "Lists the Docker containers managed by Container Manager on the NAS, with their image, state, CPU and memory usage. Requires the Container Manager package.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{
        containers: any[];
        total: number;
      }>("SYNO.Docker.Container", "list", {
        offset: args.offset,
        limit: args.limit,
ѕ        type: "all",
      });

      return {
        total: data.total,
        containers: (data.containers ?? []).map((container: any) => ({
          name: container.name,
          image: container.image,
          status: container.status,
          running: container.enable_service ?? container.status === "running",
          cpuPercent: container.cpu,
          memoryUsed: humanBytes(Number(container.memory ?? 0)),
          memoryPercent: container.memory_percent,
        })),
      };
    },
  }),

  defineTool({
    name: "get_container_details",
    title: "Get container details",
    description:
      "Returns the full configuration of one Docker container: image, ports, volume mounts, environment, network and restart policy.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      name: z.string().describe("Container name as shown by list_containers"),
    }),
    handler: async (ctx, args) => {
      return ctx.client.request("SYNO.Docker.Container", "get", {
        name: args.name,
      });
    },
  }),

  defineTool({
    name: "control_container",
    title: "Start, stop or restart a container",
    description:
      "Starts, stops or restarts a Docker container on the NAS. Stopping a container takes whatever it serves offline. Requires SYNOLOGY_ALLOW_SYSTEM_CONTROL=true.",
    destructive: true,
    schema: z.object({
      name: z.string(),
      action: z.enum(["start", "stop", "restart"]),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertSystemControl(`control_container(${args.action})`);
      await ctx.client.request(
        "SYNO.Docker.Container",
        args.action,
        { name: args.name },
        { method: "POST" },
      );
      return { container: args.name, action: args.action, ok: true };
    },
  }),

  defineTool({
    name: "list_container_images",
    title: "List Docker images",
    description:
      "Lists the Docker images stored on the NAS with their tags and size. Useful for checking what is taking up space in Container Manager.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ images: any[]; total: number }>(
        "SYNO.Docker.Image",
        "list",
        { offset: args.offset, limit: args.limit, show_dsm: false },
      );
      return {
        total: data.total,
        images: (data.images ?? []).map((image: any) => ({
          repository: image.repository,
          tags: image.tags,
          size: humanBytes(Number(image.virtual_size ?? image.size ?? 0)),
          created: image.created,
        })),
      };
    },
  }),
];
