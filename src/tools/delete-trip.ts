import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";

export const deleteTripInputSchema = {
  trip_key: z.string().min(1).describe("The key of the trip to delete."),
  confirm: z
    .boolean()
    .describe(
      "Safety flag — must be true to proceed. The agent should confirm with the user before setting this to true.",
    ),
};

export const deleteTripDescription = `
Permanently deletes a Wanderlog trip. This action cannot be undone.

The 'confirm' parameter must be explicitly set to true. Before calling this tool, the agent
should confirm with the user that they actually want to delete the trip.
`.trim();

type Args = {
  trip_key: string;
  confirm: boolean;
};

export async function deleteTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.confirm) {
      return {
        content: [
          {
            type: "text",
            text: "Deletion aborted — set confirm: true to proceed. Make sure the user has confirmed they want to delete the trip.",
          },
        ],
        isError: true,
      };
    }

    const trip = await ctx.rest.getTrip(args.trip_key);
    const title = trip.title;

    await ctx.rest.deleteTrip(args.trip_key);
    ctx.tripCache.invalidate(args.trip_key);

    return {
      content: [{ type: "text", text: `Deleted trip "${title}" (${args.trip_key}).` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
