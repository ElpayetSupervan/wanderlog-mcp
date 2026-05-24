import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { submitOp } from "./shared.js";

export const renameTripInputSchema = {
  trip_key: z.string().min(1).describe("The trip to rename."),
  title: z.string().min(1).describe("New title for the trip."),
};

export const renameTripDescription = `
Renames a Wanderlog trip by changing its title.
`.trim();

type Args = {
  trip_key: string;
  title: string;
};

export async function renameTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const oldTitle = trip.title;

    const ops: Json0Op[] = [
      { p: ["title"], od: oldTitle, oi: args.title },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Renamed trip "${oldTitle}" → "${args.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
