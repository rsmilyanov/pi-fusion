/** Types for the pure half of the manual Codex qualification harness, so `test/codex-harness.test.ts` can import it. */

export declare const EXIT: Readonly<{ pass: 0; failure: 1; none: 2 }>;

export interface HarnessCase {
	id: string;
	model: boolean;
	fake: boolean;
	needs?: string;
	title: string;
}
export declare const CASES: readonly HarnessCase[];
export declare const GROUPS: Readonly<Record<string, string[]>>;

export interface HarnessArgs {
	run: boolean;
	fake: boolean;
	list: boolean;
	help: boolean;
	keep: boolean;
	unknown: string[];
	problems: string[];
	case?: string;
	model?: string;
	effort?: string;
}
export declare function isToken(value: unknown): boolean;
export declare function parseArgs(args: string[]): HarnessArgs;
export declare function selectCases(spec: string | undefined): { cases: HarnessCase[]; error?: undefined } | { error: string; cases?: undefined };
export declare const WARNING: string;
export declare const USAGE: string;

export declare function canonicalPath(file: string): string;

/** The role fields the backend's thread/start body is composed from. */
export interface BodyRole {
	model?: string;
	provider?: string;
	sandboxMode: string;
	approvalPolicy: string;
	contract: string;
}
export declare function composeInstructions(role: BodyRole, read: (name: string) => string): string;
export declare function threadParams(role: BodyRole, instructions: string): { model?: string; modelProvider?: string; sandbox: string; approvalPolicy: string; developerInstructions: string };
export type Status = "pass" | "fail" | "skip" | "unproven";
export declare function caseStatus(primary: Status[], guards: Status[]): Status;
export declare function forcedExitNotice(root: string): string;
export declare function exitCode(statuses: Status[]): 0 | 1 | 2;

export declare function fileDigest(file: string): string;
export declare function versionFromUserAgent(userAgent: string | undefined): string | undefined;

export declare const USAGE_FIELDS: readonly string[];
/** A counter as reported: a count, or why it is not one. */
export type ReportedCount = number | "null" | "absent" | "invalid";
export type Counters = Record<string, ReportedCount>;
export interface UsageCounters {
	total: Counters;
	last: Counters;
	modelContextWindow: ReportedCount;
}
export declare function reportedCount(holder: unknown, key: string): ReportedCount;
export declare function usageCounters(params: unknown): UsageCounters;
export declare function describeCounters(breakdown: Counters): string;
export declare function usageProblem(updates: UsageCounters[]): string | undefined;
export interface Additivity {
	previous: ReportedCount;
	current: ReportedCount;
	sumOfLasts: number | "unknown";
	holds: "yes" | "no" | "unknown";
}
export declare function additivity(previousTotal: Counters, currentTotal: Counters, lasts: Counters[]): Record<string, Additivity>;
export declare function cacheWriteObservation(updates: UsageCounters[]): string;

export declare const CORE_FIELDS: readonly string[];
export interface CoreDelta {
	baseline: number;
	current: number;
	delta: number | "unknown";
	holds: boolean;
}
export declare function coreDelta(baseline: Readonly<Record<string, unknown>> | undefined, current: Readonly<Record<string, unknown>>): Record<string, CoreDelta>;
export declare function publishedUsageProblems(run: { tokensIn: number; tokensOut: number; cacheRead: number }, delta: Record<string, CoreDelta>): string[];
export declare function contextProblem(run: { contextTokens?: number; contextWindow?: number }, lastInput: number | undefined, window: number | null | undefined): string | undefined;
export interface SteerCall {
	threadId: string;
	turnId: string;
	outcome: string;
}
export interface SteerCounts {
	pushed: number;
	accepted: number;
	rejected: number;
	unconfirmed: number;
	unsent: number;
	dropped: number;
}
export declare function steerProof(input: { pushed: boolean; queued: boolean; calls: SteerCall[]; turn: { threadId: string; turnId: string } | undefined; report: SteerCounts | undefined }): { status: Status; why: string };

export interface QuestionCounters {
	questions: number;
	refusedQuestions: number;
	duplicateServerRequests: number;
}
export declare function questionProof(input: { callbacks: number; counters: QuestionCounters | undefined; echoed: boolean }): { status: Status; why: string };
