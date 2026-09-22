/** What one claude call has used, as the child reports it: every field is that call's running total, never a delta. */
export interface CallUsage {
	costUsd?: number;
	tokensIn?: number;
	tokensOut?: number;
	workflowTokens?: number;
}

/** What every claude call of this Pi session has used together, and how many calls that is. */
export interface UsageTotals {
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	workflowTokens: number;
	calls: number;
}

export interface BudgetConfig {
	/** The estimated session cost, in dollars, at which the user is warned; ascending, each amount once. */
	warnUsd: number[];
	/** The estimated session cost, in dollars, at which no new run starts. */
	limitUsd?: number;
}

const FIELDS = ["costUsd", "tokensIn", "tokensOut", "workflowTokens"] as const;

/** The dollar amount a variable names, or undefined when it names nothing a budget can use. */
function amount(text: string | undefined): number | undefined {
	const value = Number((text ?? "").trim());
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads the budget variables. An entry that names nothing usable is left out, and nothing here throws. */
export function budgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
	const warn = (env.PI_FUSION_BUDGET_WARN_USD ?? "")
		.split(",")
		.map(amount)
		.filter((value): value is number => value !== undefined);
	const limitUsd = amount(env.PI_FUSION_BUDGET_LIMIT_USD);
	return { warnUsd: [...new Set(warn)].sort((left, right) => left - right), ...(limitUsd === undefined ? {} : { limitUsd }) };
}

/**
 * Every budget variable that is set and names no amount a control can use, one message each. A limit written with a
 * thousands separator turns the limit off, and nothing else would say so.
 */
export function budgetProblems(env: NodeJS.ProcessEnv = process.env): string[] {
	const problems: string[] = [];
	const warn = (env.PI_FUSION_BUDGET_WARN_USD ?? "").trim();
	const unusable = warn
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "" && amount(part) === undefined);
	if (unusable.length) {
		const named = unusable.map((part) => JSON.stringify(part)).join(", ");
		problems.push(`PI_FUSION_BUDGET_WARN_USD=${warn} takes a dollar amount or a comma-separated list of them; ${named} ${unusable.length === 1 ? "names none and warns" : "name none and warn"} about nothing`);
	}
	const limit = (env.PI_FUSION_BUDGET_LIMIT_USD ?? "").trim();
	if (limit !== "" && amount(limit) === undefined) problems.push(`PI_FUSION_BUDGET_LIMIT_USD=${limit} is not a dollar amount; no limit is set`);
	return problems;
}

/** What this Pi session's claude calls have used, kept per call id, with the warning and limit checks over the total. */
export class Ledger {
	readonly config: BudgetConfig;
	private readonly calls = new Map<string, CallUsage>();
	private readonly warned = new Set<number>();

	constructor(config: BudgetConfig) {
		this.config = config;
	}

	/** A field carries the call's own running total, so the latest value replaces the earlier one instead of adding to it. */
	update(callId: string, usage: CallUsage): void {
		const call = this.calls.get(callId) ?? {};
		for (const field of FIELDS) {
			const value = usage[field];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) call[field] = value;
		}
		this.calls.set(callId, call);
	}

	totals(): UsageTotals {
		const totals: UsageTotals = { costUsd: 0, tokensIn: 0, tokensOut: 0, workflowTokens: 0, calls: this.calls.size };
		for (const call of this.calls.values()) {
			for (const field of FIELDS) totals[field] += call[field] ?? 0;
		}
		return totals;
	}

	/** The lowest warn threshold the total has reached that is not marked warned yet, or undefined when none is left. */
	nextWarning(): number | undefined {
		const { costUsd } = this.totals();
		return this.config.warnUsd.find((threshold) => costUsd >= threshold && !this.warned.has(threshold));
	}

	/** Takes a threshold out of nextWarning() for good; call it once the warning has reached the user, never before. */
	markWarned(threshold: number): void {
		this.warned.add(threshold);
	}

	/** Set once the total is at or over the limit, which stops new and continued calls and never an active run. */
	blocked(): { limitUsd: number; costUsd: number } | undefined {
		const { limitUsd } = this.config;
		if (limitUsd === undefined) return undefined;
		const { costUsd } = this.totals();
		return costUsd >= limitUsd ? { limitUsd, costUsd } : undefined;
	}
}
