import { z } from "zod";
import { defineTool, isoTime } from "../tool.js";

/**
 * Synology Photos (DSM 7). Every API exists in two namespaces: SYNO.Foto.* for
 * the signed-in user's personal space and SYNO.FotoTeam.* for the shared team
 * space. The `space` argument selects between them instead of doubling the
 * number of tools.
 */
function ns(space: "personal" | "shared", suffix: string): string {
  return `${space === "shared" ? "SYNO.FotoTeam" : "SYNO.Foto"}.${suffix}`;
}

const spaceArg = z
  .enum(["personal", "shared"])
  .default("personal")
  .describe("personal = your own photo space, shared = the team space");

function summarizeItem(item: any) {
  return {
    id: item.id,
    filename: item.filename,
    type: item.type,
    taken: isoTime(item.time),
    folderId: item.folder_id,
    width: item.additional?.resolution?.width,
    height: item.additional?.resolution?.height,
    address: item.additional?.address
      ? [
          item.additional.address.city,
          item.additional.address.state,
          item.additional.address.country,
        ]
          .filter(Boolean)
          .join(", ")
      : undefined,
    tags: item.additional?.tag?.map((tag: any) => tag.name),
  };
}

const ITEM_ADDITIONAL = '["resolution","orientation","thumbnail","address","tag","exif"]';

export const photoTools = [
  defineTool({
    name: "list_photo_albums",
    title: "List photo albums",
    description:
      "Lists albums in Synology Photos, including their item counts and cover. Requires the Synology Photos package.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      space: spaceArg,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ list: any[] }>(
        ns(args.space, "Browse.Album"),
        "list",
        {
          offset: args.offset,
          limit: args.limit,
          sort_by: "create_time",
          sort_direction: "desc",
        },
      );
      return {
        albums: (data.list ?? []).map((album: any) => ({
          id: album.id,
          name: album.name,
          itemCount: album.item_count,
          created: isoTime(album.create_time),
          type: album.type,
        })),
      };
    },
  }),

  defineTool({
    name: "list_photos",
    title: "List photos",
    description:
      "Lists photos and videos, optionally restricted to one album or folder. Returns capture time, resolution, location and tags for each item.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      space: spaceArg,
      albumId: z.number().int().optional(),
      folderId: z.number().int().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      sortBy: z
        .enum(["filename", "filesize", "takentime", "create_time"])
        .default("takentime"),
      sortDirection: z.enum(["asc", "desc"]).default("desc"),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ list: any[] }>(
        ns(args.space, "Browse.Item"),
        "list",
        {
          album_id: args.albumId,
          folder_id: args.folderId,
          offset: args.offset,
          limit: args.limit,
          sort_by: args.sortBy,
          sort_direction: args.sortDirection,
          additional: ITEM_ADDITIONAL,
        },
      );
      return {
        returned: (data.list ?? []).length,
        photos: (data.list ?? []).map(summarizeItem),
      };
    },
  }),

  defineTool({
    name: "list_photo_folders",
    title: "List photo folders",
    description:
      "Lists the folder tree inside Synology Photos. Pass the id of a folder to descend into it; omit it to list the top level.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      space: spaceArg,
      folderId: z.number().int().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ list: any[] }>(
        ns(args.space, "Browse.Folder"),
        "list",
        {
          id: args.folderId,
          offset: args.offset,
          limit: args.limit,
          sort_by: "filename",
          sort_direction: "asc",
        },
      );
      return {
        folders: (data.list ?? []).map((folder: any) => ({
          id: folder.id,
          name: folder.name,
          itemCount: folder.item_count,
          parentId: folder.parent,
        })),
      };
    },
  }),

  defineTool({
    name: "search_photos",
    title: "Search photos",
    description:
      "Searches Synology Photos by free text. Synology indexes filenames, tags, recognized people, places and detected subjects, so queries like 'beach', 'passport' or a person's name work.",
    readOnly: true,
    schema: z.object({
      space: spaceArg,
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ list: any[] }>(
        ns(args.space, "Search.Search"),
        "list_item",
        {
          keyword: args.query,
          offset: 0,
          limit: args.limit,
          additional: ITEM_ADDITIONAL,
        },
      );
      return {
        query: args.query,
        returned: (data.list ?? []).length,
        photos: (data.list ?? []).map(summarizeItem),
      };
    },
  }),
];
