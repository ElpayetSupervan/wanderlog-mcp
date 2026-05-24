#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { WanderlogError } from "./errors.js";
import { buildServer } from "./server.js";
import type { Tier } from "./server.js";

function parseTier(): Tier {
  const arg = process.argv.find((a) => a.startsWith("--tier="));
  if (arg) {
    const val = arg.split("=")[1];
    if (val === "1" || val === "2") return Number(val) as Tier;
  }
  const idx = process.argv.indexOf("--tier");
  if (idx >= 0 && process.argv[idx + 1]) {
    const val = process.argv[idx + 1];
    if (val === "1" || val === "2") return Number(val) as Tier;
  }
  const env = process.env.WANDERLOG_TIER;
  if (env === "1" || env === "2") return Number(env) as Tier;
  return undefined;
}

async function main() {
  let ctx;
  try {
    ctx = createContext();
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : (err as Error).message;
    process.stderr.write(`[wanderdog] startup failed: ${msg}\n`);
    process.exit(1);
  }

  try {
    const user = await ctx.rest.getUser();
    ctx.userId = user.id;
    ctx.authenticated = true;
    process.stderr.write(
      `[wanderdog] authenticated as ${user.username} (${user.id})\n`,
    );
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : (err as Error).message;
    process.stderr.write(
      `[wanderdog] auth probe failed: ${msg}\n` +
        `[wanderdog] server will start but all tools will require valid credentials\n`,
    );
  }

  const tier = parseTier();
  const server = buildServer(ctx, { tier });
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string) => {
    process.stderr.write(`[wanderdog] ${signal} received, shutting down\n`);
    ctx.pool.closeAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  process.stderr.write("[wanderdog] ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[wanderdog] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
