#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DsmClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { SERVER_NAME, createMcpServer, visibleTools } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new DsmClient(config.credentials);

  if (config.transport === "stdio") {
    const server = createMcpServer(client, config);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // stdout belongs to the protocol, so all logging goes to stderr.
    console.error(
      `[${SERVER_NAME}] stdio transport ready with ${visibleTools(config.policy).length} tools ` +
        `(readOnly=${config.policy.readOnly})`,
    );

    const shutdown = async (): Promise<void> => {
      await client.logout();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
    return;
  }

  await startHttpServer(client, config);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[${SERVER_NAME}] configuration error: ${error.message}`);
    process.exit(78); // EX_CONFIG
  }
  console.error(
    `[${SERVER_NAME}] failed to start:`,
    error instanceof Error ? error.stack ?? error.message : error,
  );
  process.exit(1);
});
