import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { listExpenses } from "./list-expenses.js";
import { removeExpense } from "./remove-expense.js";
import { updateExpense } from "./update-expense.js";

export const expensesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to operate on."),
  action: z
    .enum(["list", "remove", "update"])
    .describe("Action: 'list' (view expenses with orphan detection), 'remove' (delete by id/description/place), 'update' (modify amount/place/category)."),
  expense_id: z.number().optional().describe("Target expense by stable ID (from a previous list action)."),
  description: z.string().optional().describe("Match expense by description substring (case-insensitive)."),
  place_ref: z.string().optional().describe("For remove: delete ALL expenses of this place. For update: move expense to this place."),
  day: z.string().optional().describe("Filter by day ('day 2', 'May 4', ISO date)."),
  amount: z.number().optional().describe("For remove: filter. For update: new amount."),
  category: z.string().optional().describe("Filter or new category (food, lodging, sightseeing, etc)."),
  currency: z.string().min(3).max(3).optional().describe("For update: new ISO 4217 currency code."),
  include_orphans: z.boolean().optional().describe("For list: include expenses linked to deleted places (default true)."),
  response_format: z.enum(["concise", "detailed"]).optional().describe("For list: output format (default concise)."),
};

export const expensesDescription = `
Manage expenses in a Wanderlog trip. Three actions:

LIST: Shows all expenses with filters (day, place, category). Detects orphans (expenses linked
to deleted places). Returns stable IDs for targeting with remove/update.

REMOVE: Delete expense(s) by expense_id, description match, or place_ref (bulk delete all
expenses of a pin — useful after remove_place). If ambiguous, returns candidates without deleting.

UPDATE: Modify an expense's amount, category, currency, or move it to a different place via
place_ref. Target by expense_id or description.
`.trim();

type Args = {
  trip_key: string;
  action: "list" | "remove" | "update";
  expense_id?: number;
  description?: string;
  place_ref?: string;
  day?: string;
  amount?: number;
  category?: string;
  currency?: string;
  include_orphans?: boolean;
  response_format?: "concise" | "detailed";
};

export async function expenses(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  switch (args.action) {
    case "list":
      return listExpenses(ctx, {
        trip_key: args.trip_key,
        day: args.day,
        place_ref: args.place_ref,
        category: args.category,
        include_orphans: args.include_orphans,
        response_format: args.response_format,
      });

    case "remove":
      return removeExpense(ctx, {
        trip_key: args.trip_key,
        expense_id: args.expense_id,
        description: args.description,
        place_ref: args.place_ref,
        day: args.day,
        amount: args.amount,
        category: args.category,
      });

    case "update":
      return updateExpense(ctx, {
        trip_key: args.trip_key,
        expense_id: args.expense_id,
        description: args.description,
        new_amount: args.amount,
        new_description: undefined,
        new_category: args.category as any,
        new_place_ref: args.place_ref,
        new_currency: args.currency,
        new_date: args.day,
      });

    default:
      return {
        content: [{ type: "text", text: "Unknown action. Use 'list', 'remove', or 'update'." }],
        isError: true,
      };
  }
}
