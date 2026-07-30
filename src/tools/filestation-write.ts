import { z } from "zod";
import { defineTool, humanBytes, isoTime, pathParam } from "../tool.js";
import type { ToolContext } from "../tool.js";

/**
 * Copy, move, delete, compress and extract all run as DSM background tasks.
 * Every one of them is polled here rather than returning a task id, because a
 * bare task id is useless to a model that cannot reliably decide to poll it.
 */
async function awaitBackgroundTask(
  ctx: ToolContext,
  api: string,
  taskId: string,
  timeoutSeconds: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const status = await ctx.client.request<Record<string, unknown>>(
      api,
      "status",
      { taskid: taskId },
    );
    if (status.finished === true) return status;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return {
    finished: false,
    note: `The operation is still running on the NAS after ${timeoutSeconds}s. It will continue in the background; check File Station or raise timeoutSeconds.`,
  };
}

export const fileStationWriteTools = [
  defineTool({
    name: "create_folder",
    title: "Create a folder",
    description:
      "Creates one or more folders on the NAS. Parent folders can be created automatically. Safe to call when the folder may already exist by setting failIfExists to false.",
    idempotent: true,
    schema: z.object({
      parentPath: z
        .string()
        .describe("Existing folder to create inside, e.g. /Documents"),
      names: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Folder names to create inside parentPath"),
      createParents: z.boolean().default(true),
      failIfExists: z.boolean().default(false),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("create_folder");
      const parent = ctx.policy.assertPathAllowed(args.parentPath);
      // Validate each resulting path too, so names cannot smuggle a traversal.
      for (const name of args.names) {
        ctx.policy.assertPathAllowed(`${parent}/${name}`);
      }

      const data = await ctx.client.request<{ folders: unknown[] }>(
        "SYNO.FileStation.CreateFolder",
        "create",
        {
          folder_path: pathParam([parent]),
          name: pathParam(args.names),
          force_parent: args.createParents,
        },
      );
      return {
        parent,
        created: args.names.map((name) => `${parent}/${name}`),
        result: data.folders,
      };
    },
  }),

  defineTool({
    name: "write_file",
    title: "Create or overwrite a file",
    description:
      "Uploads text or base64 content to a file on the NAS. Use this to save notes, reports, exports or generated documents. Set overwrite to false to avoid replacing an existing file.",
    schema: z.object({
      path: z
        .string()
        .describe("Full destination file path, e.g. /Documents/report.md"),
      content: z.string(),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      overwrite: z.boolean().default(false),
      createParents: z.boolean().default(true),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("write_file");
      const path = ctx.policy.assertPathAllowed(args.path);

      const lastSlash = path.lastIndexOf("/");
      const folder = lastSlash > 0 ? path.slice(0, lastSlash) : "/";
      const filename = path.slice(lastSlash + 1);
      if (!filename) {
        throw new Error(`"${args.path}" does not end in a file name.`);
      }

      const bytes =
        args.encoding === "base64"
          ? new Uint8Array(Buffer.from(args.content, "base64"))
          : new Uint8Array(Buffer.from(args.content, "utf-8"));

      await ctx.client.requestUpload(
        "SYNO.FileStation.Upload",
        "upload",
        {
          path: folder,
          create_parents: args.createParents,
          overwrite: args.overwrite ? "overwrite" : "skip",
        },
        {
          filename,
          bytes,
          contentType:
            args.encoding === "utf-8"
              ? "text/plain; charset=utf-8"
              : "application/octet-stream",
        },
      );

      return {
        path,
        bytesWritten: bytes.length,
        size: humanBytes(bytes.length),
        overwrote: args.overwrite,
      };
    },
  }),

  defineTool({
    name: "rename_file",
    title: "Rename a file or folder",
    description:
      "Renames a file or folder in place without moving it. To relocate an item, use move_files instead.",
    schema: z.object({
      path: z.string(),
      newName: z
        .string()
        .min(1)
        .describe("New name only, not a full path"),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("rename_file");
      const path = ctx.policy.assertPathAllowed(args.path);
      if (args.newName.includes("/")) {
        throw new Error(
          "newName must be a bare name without slashes. Use move_files to relocate an item.",
        );
      }

      const data = await ctx.client.request<{ files: unknown[] }>(
        "SYNO.FileStation.Rename",
        "rename",
        { path: pathParam([path]), name: pathParam([args.newName]) },
      );
      return { renamed: path, to: args.newName, result: data.files };
    },
  }),

  defineTool({
    name: "move_files",
    title: "Move files or folders",
    description:
      "Moves files or folders to another folder on the NAS. Both the sources and the destination must be inside the allowed paths. Waits for the transfer to finish.",
    schema: z.object({
      sourcePaths: z.array(z.string()).min(1).max(100),
      destinationFolder: z.string(),
      overwrite: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(2).max(300).default(60),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("move_files");
      const sources = ctx.policy.assertPathsAllowed(args.sourcePaths);
      const destination = ctx.policy.assertPathAllowed(args.destinationFolder);

      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.CopyMove",
        "start",
        {
          path: pathParam(sources),
          dest_folder_path: destination,
          overwrite: args.overwrite,
          remove_src: true,
        },
      );
      const status = await awaitBackgroundTask(
        ctx,
        "SYNO.FileStation.CopyMove",
        started.taskid,
        args.timeoutSeconds,
      );
      return { moved: sources, destination, status };
    },
  }),

  defineTool({
    name: "copy_files",
    title: "Copy files or folders",
    description:
      "Copies files or folders to another folder on the NAS, leaving the originals in place. Waits for the copy to finish.",
    schema: z.object({
      sourcePaths: z.array(z.string()).min(1).max(100),
      destinationFolder: z.string(),
      overwrite: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(2).max(300).default(60),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("copy_files");
      const sources = ctx.policy.assertPathsAllowed(args.sourcePaths);
      const destination = ctx.policy.assertPathAllowed(args.destinationFolder);

      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.CopyMove",
        "start",
        {
          path: pathParam(sources),
          dest_folder_path: destination,
          overwrite: args.overwrite,
          remove_src: false,
        },
      );
      const status = await awaitBackgroundTask(
        ctx,
        "SYNO.FileStation.CopyMove",
        started.taskid,
        args.timeoutSeconds,
      );
      return { copied: sources, destination, status };
    },
  }),

  defineTool({
    name: "delete_files",
    title: "Delete files or folders",
    description:
      "Permanently deletes files or folders from the NAS. This does not use a recycle bin unless DSM is configured for one, so it is usually irreversible. Requires SYNOLOGY_ALLOW_DELETE=true.",
    destructive: true,
    schema: z.object({
      paths: z.array(z.string()).min(1).max(100),
      timeoutSeconds: z.number().int().min(2).max(300).default(60),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertDeletable("delete_files");
      const paths = ctx.policy.assertPathsAllowed(args.paths);

      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.Delete",
        "start",
        { path: pathParam(paths), recursive: true },
      );
      const status = await awaitBackgroundTask(
        ctx,
        "SYNO.FileStation.Delete",
        started.taskid,
        args.timeoutSeconds,
      );
      return { deleted: paths, status };
    },
  }),

  defineTool({
    name: "compress_files",
    title: "Create an archive",
    description:
      "Compresses files or folders into a ZIP or 7z archive on the NAS, optionally password protected. Useful for bundling many files before sharing them.",
    schema: z.object({
      paths: z.array(z.string()).min(1).max(100),
      destinationArchive: z
        .string()
        .describe("Full path of the archive to create, e.g. /Documents/bundle.zip"),
      format: z.enum(["zip", "7z"]).default("zip"),
      compressionLevel: z
        .enum(["moderate", "store", "fastest", "best"])
        .default("moderate"),
      password: z.string().optional(),
      timeoutSeconds: z.number().int().min(2).max(600).default(120),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("compress_files");
      const paths = ctx.policy.assertPathsAllowed(args.paths);
      const destination = ctx.policy.assertPathAllowed(args.destinationArchive);

      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.Compress",
        "start",
        {
          path: pathParam(paths),
          dest_file_path: destination,
          format: args.format,
          level: args.compressionLevel,
          password: args.password,
        },
      );
      const status = await awaitBackgroundTask(
        ctx,
        "SYNO.FileStation.Compress",
        started.taskid,
        args.timeoutSeconds,
      );
      return { archive: destination, sources: paths, status };
    },
  }),

  defineTool({
    name: "extract_archive",
    title: "Extract an archive",
    description:
      "Extracts a ZIP, 7z, RAR, TAR or GZ archive already stored on the NAS into a destination folder. Supports password protected archives.",
    schema: z.object({
      archivePath: z.string(),
      destinationFolder: z.string(),
      password: z.string().optional(),
      overwrite: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(2).max(600).default(120),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("extract_archive");
      const archive = ctx.policy.assertPathAllowed(args.archivePath);
      const destination = ctx.policy.assertPathAllowed(args.destinationFolder);

      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.Extract",
        "start",
        {
          file_path: archive,
          dest_folder_path: destination,
          password: args.password,
          overwrite: args.overwrite,
        },
      );
      const status = await awaitBackgroundTask(
        ctx,
        "SYNO.FileStation.Extract",
        started.taskid,
        args.timeoutSeconds,
      );
      return { archive, destination, status };
    },
  }),

  defineTool({
    name: "list_archive_contents",
    title: "Inspect an archive",
    description:
      "Lists the files inside an archive on the NAS without extracting it, so you can check what it contains first.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      archivePath: z.string(),
      password: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: async (ctx, args) => {
      const archive = ctx.policy.assertPathAllowed(args.archivePath);
      const data = await ctx.client.request<{
        items: unknown[];
        total: number;
      }>("SYNO.FileStation.Extract", "list", {
        file_path: archive,
        password: args.password,
        offset: 0,
        limit: args.limit,
      });
      return { archive, total: data.total, items: data.items };
    },
  }),

  defineTool({
    name: "create_sharing_link",
    title: "Create a public sharing link",
    description:
      "Creates a DSM sharing link for a file or folder so it can be handed to someone outside the NAS, or used to transfer a file too large to read inline. Supports an expiry date and a password.",
    schema: z.object({
      paths: z.array(z.string()).min(1).max(50),
      expiresAt: z
        .string()
        .optional()
        .describe("ISO date when the link stops working, e.g. 2026-12-31"),
      password: z.string().optional(),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("create_sharing_link");
      const paths = ctx.policy.assertPathsAllowed(args.paths);

      const data = await ctx.client.request<{ links: unknown[] }>(
        "SYNO.FileStation.Sharing",
        "create",
        {
          path: pathParam(paths),
          password: args.password,
          date_expired: args.expiresAt
            ? new Date(args.expiresAt).toISOString().slice(0, 10)
            : undefined,
        },
      );
      return {
        links: data.links,
        note: "The link only works if DSM is reachable from wherever it is opened.",
      };
    },
  }),

  defineTool({
    name: "list_sharing_links",
    title: "List sharing links",
    description:
      "Lists the DSM sharing links owned by the configured account, including their targets and expiry, so stale public links can be found and revoked.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{
        links: Array<Record<string, unknown>>;
        total: number;
      }>("SYNO.FileStation.Sharing", "list", {
        offset: args.offset,
        limit: args.limit,
      });
      return {
        total: data.total,
        links: (data.links ?? []).map((link) => ({
          ...link,
          expires: isoTime(Number(link.date_expired) || undefined),
        })),
      };
    },
  }),

  defineTool({
    name: "delete_sharing_link",
    title: "Revoke sharing links",
    description:
      "Revokes DSM sharing links by id, immediately cutting off public access. Get the ids from list_sharing_links.",
    destructive: true,
    schema: z.object({
      linkIds: z.array(z.string()).min(1).max(50),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("delete_sharing_link");
      await ctx.client.request("SYNO.FileStation.Sharing", "delete", {
        id: args.linkIds.join(","),
      });
      return { revoked: args.linkIds };
    },
  }),
];
