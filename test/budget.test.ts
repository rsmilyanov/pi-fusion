import assert from "node:assert/strict";
import test from "node:test";
import { budgetConfig, budgetProblems, Ledger } from "../extensions/budget.ts";

test("budgetConfig reads one threshold, a list, and drops what is not a positive number", () => {
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "5" }), { warnUsd: [5] });
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: " 0.5 , 2 ,10 " }), { warnUsd: [0.5, 2, 10] });
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "3,two,-1,0,,NaN,Infinity,1" }), { warnUsd: [1, 3] }, "only finite amounts over zero count");
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "2,1,2,1" }), { warnUsd: [1, 2] }, "duplicates drop and the list sorts ascending");
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "" }), { warnUsd: [] });
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "   " }), { warnUsd: [] });
	assert.deepEqual(budgetConfig({}), { warnUsd: [] }, "unset variables leave no thresholds and no limit");
});

test("budgetConfig takes one positive limit and ignores anything else", () => {
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_LIMIT_USD: " 12.5 " }), { warnUsd: [], limitUsd: 12.5 });
	for (const limit of ["", "  ", "abc", "0", "-3", "NaN", "Infinity", "1,2"]) {
		assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_LIMIT_USD: limit }), { warnUsd: [] }, `${JSON.stringify(limit)} names no limit`);
	}
	assert.deepEqual(budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "1", PI_FUSION_BUDGET_LIMIT_USD: "4" }), { warnUsd: [1], limitUsd: 4 });
});

test("budgetProblems names a variable that is set and says nothing a control can use", () => {
	assert.deepEqual(budgetProblems({ PI_FUSION_BUDGET_LIMIT_USD: "1,000" }), ['PI_FUSION_BUDGET_LIMIT_USD=1,000 is not a dollar amount; no limit is set']);
	for (const limit of ["$5", " 1e400 ", "-5", "0", "abc"]) {
		assert.equal(budgetProblems({ PI_FUSION_BUDGET_LIMIT_USD: limit }).length, 1, `${JSON.stringify(limit)} sets no limit and says so`);
	}
	assert.deepEqual(budgetProblems({ PI_FUSION_BUDGET_WARN_USD: "1,abc" }), ['PI_FUSION_BUDGET_WARN_USD=1,abc takes a dollar amount or a comma-separated list of them; "abc" names none and warns about nothing']);
	assert.deepEqual(budgetProblems({ PI_FUSION_BUDGET_WARN_USD: "1,000" }), ['PI_FUSION_BUDGET_WARN_USD=1,000 takes a dollar amount or a comma-separated list of them; "000" names none and warns about nothing']);
	assert.equal(budgetProblems({ PI_FUSION_BUDGET_WARN_USD: "x,y" })[0]?.includes('"x", "y" name none and warn about nothing'), true);
	assert.equal(budgetProblems({ PI_FUSION_BUDGET_WARN_USD: "1,2", PI_FUSION_BUDGET_LIMIT_USD: "$5" }).length, 1, "a list that reads whole leaves only the limit to report");
	assert.equal(budgetProblems({ PI_FUSION_BUDGET_WARN_USD: "x", PI_FUSION_BUDGET_LIMIT_USD: "y" }).length, 2, "each variable is reported on its own");
	for (const env of [{}, { PI_FUSION_BUDGET_WARN_USD: "" }, { PI_FUSION_BUDGET_WARN_USD: "  " }, { PI_FUSION_BUDGET_WARN_USD: "5," }, { PI_FUSION_BUDGET_LIMIT_USD: " 12.5 " }]) {
		assert.deepEqual(budgetProblems(env), [], `${JSON.stringify(env)} is nothing to report`);
	}
});

test("a ledger keeps the latest value of each field per call and sums over calls", () => {
	const ledger = new Ledger({ warnUsd: [] });
	ledger.update("call-1", { costUsd: 0.1, tokensIn: 100, tokensOut: 10, workflowTokens: 5 });
	ledger.update("call-1", { costUsd: 0.25, tokensIn: 300, tokensOut: 30, workflowTokens: 50 });
	assert.deepEqual(ledger.totals(), { costUsd: 0.25, tokensIn: 300, tokensOut: 30, workflowTokens: 50, calls: 1 }, "one call's running total replaces its earlier one");
	ledger.update("call-2", { costUsd: 0.25, tokensIn: 300, tokensOut: 30, workflowTokens: 50 });
	assert.deepEqual(ledger.totals(), { costUsd: 0.5, tokensIn: 600, tokensOut: 60, workflowTokens: 100, calls: 2 }, "two calls add up");
});

test("a ledger keeps a field a later update leaves out and ignores a value that is not a count", () => {
	const ledger = new Ledger({ warnUsd: [] });
	ledger.update("call-1", { costUsd: 0.4, tokensIn: 20, tokensOut: 2, workflowTokens: 7 });
	ledger.update("call-1", { tokensIn: 30 });
	assert.deepEqual(ledger.totals(), { costUsd: 0.4, tokensIn: 30, tokensOut: 2, workflowTokens: 7, calls: 1 }, "a missing field keeps the value it had");
	ledger.update("call-1", { costUsd: Number.NaN, tokensIn: Number.POSITIVE_INFINITY, tokensOut: -5 });
	assert.deepEqual(ledger.totals(), { costUsd: 0.4, tokensIn: 30, tokensOut: 2, workflowTokens: 7, calls: 1 }, "a non-finite or negative number changes nothing");
	ledger.update("call-2", {});
	assert.equal(ledger.totals().calls, 2, "a call with no counters yet is still a call");
});

test("nextWarning offers the lowest threshold the total reached and keeps it until markWarned takes it", () => {
	const ledger = new Ledger({ warnUsd: [1, 5, 10] });
	assert.equal(ledger.nextWarning(), undefined, "nothing is crossed at zero");
	ledger.update("call-1", { costUsd: 1 });
	assert.equal(ledger.nextWarning(), 1, "a threshold the total has reached is warned about");
	assert.equal(ledger.nextWarning(), 1, "a peek alone leaves it pending, so a warning that never reached the user comes back");
	ledger.markWarned(1);
	assert.equal(ledger.nextWarning(), undefined, "a marked threshold is never offered twice");
	ledger.update("call-1", { costUsd: 12 });
	assert.equal(ledger.nextWarning(), 5, "one jump past two thresholds offers the lower one first");
	ledger.markWarned(5);
	assert.equal(ledger.nextWarning(), 10);
	ledger.markWarned(10);
	assert.equal(ledger.nextWarning(), undefined);
	assert.equal(new Ledger({ warnUsd: [] }).nextWarning(), undefined, "with no thresholds there is nothing to warn about");
});

test("blocked holds at the limit and above and is undefined below it or without one", () => {
	const ledger = new Ledger({ warnUsd: [], limitUsd: 2 });
	ledger.update("call-1", { costUsd: 1.99 });
	assert.equal(ledger.blocked(), undefined, "under the limit nothing is blocked");
	ledger.update("call-1", { costUsd: 2 });
	assert.deepEqual(ledger.blocked(), { limitUsd: 2, costUsd: 2 }, "exactly at the limit blocks");
	ledger.update("call-2", { costUsd: 0.5 });
	assert.deepEqual(ledger.blocked(), { limitUsd: 2, costUsd: 2.5 }, "over the limit blocks");
	const free = new Ledger({ warnUsd: [1] });
	free.update("call-1", { costUsd: 1000 });
	assert.equal(free.blocked(), undefined, "without a limit no cost blocks");
});

test("a ledger reports the config it was built with, so the status line can name the thresholds", () => {
	const config = budgetConfig({ PI_FUSION_BUDGET_WARN_USD: "2,1", PI_FUSION_BUDGET_LIMIT_USD: "9" });
	assert.deepEqual(new Ledger(config).config, { warnUsd: [1, 2], limitUsd: 9 });
});
