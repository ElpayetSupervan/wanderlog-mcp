import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { submitOp } from "./shared.js";

export const updateTripPrivacyInputSchema = {
  trip_key: z.string().min(1).describe("The trip to update."),
  privacy: z
    .enum(["private", "friends", "public"])
    .describe("New privacy level: 'private' (only you), 'friends' (shared with collaborators), 'public' (anyone with link)."),
};

export const updateTripPrivacyDescription = `
Changes the privacy/visibility of a Wanderlog trip.

- private: only you can see it
- friends: visible to collaborators
- public: anyone with the link can view
`.trim();

type Args = {
  trip_key: string;
  privacy: "private" | "friends" | "public";
};

export async function updateTripPrivacy(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const oldPrivacy = trip.privacy;

    if (oldPrivacy === args.privacy) {
      return {
        content: [{ type: "text", text: `"${trip.title}" is already ${args.privacy}. No change.` }],
      };
    }

    const ops: Json0Op[] = [
      { p: ["privacy"], od: oldPrivacy, oi: args.privacy },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Changed privacy of "${trip.title}" from ${oldPrivacy} to ${args.privacy}.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
