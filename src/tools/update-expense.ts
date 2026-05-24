import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const updateExpenseInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the expense."),
  description: z
    .string()
    .min(1)
    .describe("Substring to match the expense description (case-insensitive)."),
  new_amount: z.number().positive().optional().describe("New amount."),
  new_description: z.string().min(1).optional().describe("New description text."),
  new_category: z
    .enum([
      "food", "drinks", "groceries", "publicTransit", "carRental", "gas",
      "flights", "lodging", "sightseeing", "activities", "shopping", "other",
    ])
    .optional()
    .describe("New category."),
  new_place_ref: z
    .string()
    .optional()
    .describe("Move expense to a different place (natural-language reference)."),
  new_currency: z.string().min(3).max(3).optional().describe("New ISO 4217 currency code."),
};

export const updateExpenseDescription = `
Updates an existing expense in a Wanderlog trip. Match by description substring, then modify
amount, description, category, currency, or re-link to a different place.

If multiple expenses match, returns a list — use a more specific description.
`.trim();

type Args = {
  trip_key: string;
  description: string;
  new_amount?: number;
  new_description?: string;
  new_category?: string;
  new_place_ref?: string;
  new_currency?: string;
};

type ExpenseEntry = {
  id: number;
  amount: { amount: number; currencyCode: string };
  category: string;
  description: string;
  date: string;
  blockId?: number;
  associatedDate?: string;
};

export async function updateExpense(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const budget = (trip.itinerary as Record<string, unknown>).budget as
      | Record<string, unknown>
      | undefined;
    const expenses = (budget?.expenses as ExpenseEntry[] | undefined) ?? [];

    const lowerQuery = args.description.toLowerCase();
    const matches: { index: number; expense: ExpenseEntry }[] = [];
    for (let i = 0; i < expenses.length; i++) {
      if (expenses[i]!.description.toLowerCase().includes(lowerQuery)) {
        matches.push({ index: i, expense: expenses[i]! });
      }
    }

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Expense", args.description);
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. "${m.expense.description}" — ${m.expense.amount.currencyCode} ${m.expense.amount.amount}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `"${args.description}" matches ${matches.length} expenses:\n${lines}\n\nUse a more specific description.` }],
        isError: true,
      };
    }

    const { index, expense } = matches[0]!;
    const basePath = ["itinerary", "budget", "expenses", index];
    const ops: Json0Op[] = [];
    const changes: string[] = [];

    if (args.new_amount !== undefined) {
      ops.push({ p: [...basePath, "amount", "amount"], od: expense.amount.amount, oi: args.new_amount });
      changes.push(`amount → ${args.new_amount}`);
    }

    if (args.new_currency) {
      ops.push({ p: [...basePath, "amount", "currencyCode"], od: expense.amount.currencyCode, oi: args.new_currency.toUpperCase() });
      changes.push(`currency → ${args.new_currency.toUpperCase()}`);
    }

    if (args.new_description) {
      ops.push({ p: [...basePath, "description"], od: expense.description, oi: args.new_description });
      changes.push(`description → "${args.new_description}"`);
    }

    if (args.new_category) {
      ops.push({ p: [...basePath, "category"], od: expense.category, oi: args.new_category });
      changes.push(`category → ${args.new_category}`);
    }

    if (args.new_place_ref) {
      const result = resolvePlaceRef(trip, args.new_place_ref);
      if (result.kind === "none") {
        return {
          content: [{ type: "text", text: `No place matching "${args.new_place_ref}" found.` }],
          isError: true,
        };
      }
      if (result.kind === "ambiguous") {
        const lines = result.candidates.map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
          return `  ${i + 1}. ${name}`;
        }).join("\n");
        return {
          content: [{ type: "text", text: `Multiple places match "${args.new_place_ref}":\n${lines}` }],
          isError: true,
        };
      }
      const newBlockId = result.match.block.id;
      const newDate = result.match.section.date;
      if (expense.blockId !== undefined) {
        ops.push({ p: [...basePath, "blockId"], od: expense.blockId, oi: newBlockId });
      } else {
        ops.push({ p: [...basePath, "blockId"], oi: newBlockId });
      }
      if (newDate) {
        if (expense.associatedDate !== undefined) {
          ops.push({ p: [...basePath, "associatedDate"], od: expense.associatedDate, oi: newDate });
        } else {
          ops.push({ p: [...basePath, "associatedDate"], oi: newDate });
        }
      }
      const placeName = isPlaceBlock(result.match.block) ? result.match.block.place.name : `block #${newBlockId}`;
      changes.push(`place → ${placeName}`);
    }

    if (ops.length === 0) {
      return {
        content: [{ type: "text", text: "No changes specified." }],
        isError: true,
      };
    }

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Updated expense "${expense.description}": ${changes.join(", ")}.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
