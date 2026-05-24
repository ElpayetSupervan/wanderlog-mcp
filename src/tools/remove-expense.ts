import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { submitOp } from "./shared.js";

export const removeExpenseInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the expense."),
  description: z
    .string()
    .min(1)
    .describe("Substring to match against expense description (case-insensitive)."),
};

export const removeExpenseDescription = `
Removes an expense from a Wanderlog trip's budget by matching its description.

The match is case-insensitive. If multiple expenses match, a list is returned.
`.trim();

type Args = {
  trip_key: string;
  description: string;
};

type ExpenseEntry = {
  id: number;
  amount: { amount: number; currencyCode: string };
  category: string;
  description: string;
  date: string;
  blockId?: number;
};

export async function removeExpense(
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
        .map(
          (m, i) =>
            `  ${i + 1}. "${m.expense.description}" — ${m.expense.amount.currencyCode} ${m.expense.amount.amount} (${m.expense.date})`,
        )
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `"${args.description}" matches ${matches.length} expenses:\n${lines}\n\nUse a more specific description.`,
          },
        ],
        isError: true,
      };
    }

    const { index, expense } = matches[0]!;
    const ops: Json0Op[] = [
      { p: ["itinerary", "budget", "expenses", index], ld: expense },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [
        {
          type: "text",
          text: `Removed expense "${expense.description}" (${expense.amount.currencyCode} ${expense.amount.amount}) from "${trip.title}".`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
