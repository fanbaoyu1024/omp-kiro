import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "bun:test";
import { KiroManagementHttpError } from "../src/shared.ts";
import {
	fetchKiroUsage,
	formatKiroUsage,
	type KiroUsageSnapshot,
} from "../src/usage.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function usageResponse(breakdown: Record<string, unknown>): Record<string, unknown> {
	return {
		subscriptionInfo: { subscriptionTitle: "Kiro Pro" },
		nextDateReset: "top-level-reset",
		usageBreakdownList: [breakdown],
	};
}

const creditBreakdown: Record<string, unknown> = {
	resourceType: "CREDIT",
	displayName: "Credits",
	currentUsage: 327,
	usageLimit: 1000,
	currentUsageWithPrecision: 327.46,
	usageLimitWithPrecision: 1000,
	nextDateReset: "breakdown-reset",
};

describe("Kiro usage limits", () => {
	it("fetches the credit breakdown for the provided profile with the editor query", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return jsonResponse(usageResponse({ ...creditBreakdown }));
		};

		const snapshot = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "eu-central-1" },
			"profile-fixture",
			fetchMock,
		);

		expect(requests).toHaveLength(1);
		const url = new URL(requests[0]!.url);
		expect(url.hostname).toBe("management.eu-central-1.kiro.dev");
		expect(url.pathname).toBe("/getUsageLimits");
		expect(url.searchParams.get("origin")).toBe("AI_EDITOR");
		expect(url.searchParams.get("resourceType")).toBe("AGENTIC_REQUEST");
		expect(url.searchParams.get("profileArn")).toBe("profile-fixture");
		expect(requests[0]?.init?.method).toBe("GET");
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
			"Bearer access-fixture",
		);

		expect(snapshot.usedCredits).toBe(327.46);
		expect(snapshot.totalCredits).toBe(1000);
		expect(snapshot.remainingCredits).toBeCloseTo(672.54, 10);
		expect(snapshot.percentUsed).toBeCloseTo(32.746, 10);
		expect(snapshot.nextReset).toBe("breakdown-reset");
		expect(snapshot.subscriptionTitle).toBe("Kiro Pro");
	});

	it("resolves a profile before fetching usage when none is provided", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "resolved-profile" }] });
			}
			return jsonResponse(usageResponse({ ...creditBreakdown }));
		};

		const snapshot = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "eu-central-1" },
			undefined,
			fetchMock,
		);

		expect(requests).toHaveLength(2);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.url).toContain("profileArn=resolved-profile");
		expect(snapshot.usedCredits).toBe(327.46);
	});

	it("falls back to integer usage fields and the top-level reset date", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse(
				usageResponse({
					resourceType: "CREDIT",
					currentUsage: 327,
					usageLimit: 1000,
				}),
			);

		const snapshot = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "us-east-1" },
			"profile-fixture",
			fetchMock,
		);

		expect(snapshot.usedCredits).toBe(327);
		expect(snapshot.totalCredits).toBe(1000);
		expect(snapshot.remainingCredits).toBe(673);
		expect(snapshot.percentUsed).toBe(32.7);
		expect(snapshot.nextReset).toBe("top-level-reset");
		expect(snapshot.subscriptionTitle).toBe("Kiro Pro");
	});

	it("formats the service's Unix reset timestamp as a calendar date", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({
				nextDateReset: 1_788_220_800,
				usageBreakdownList: [
					{
						resourceType: "CREDIT",
						currentUsageWithPrecision: 366.29,
						usageLimitWithPrecision: 1000,
						nextDateReset: 1_788_220_800,
					},
				],
			});

		const snapshot = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "us-east-1" },
			"profile-fixture",
			fetchMock,
		);

		expect(snapshot.nextReset).toBe("2026-09-01");
	});

	it("keeps a zero limit safe and clamps remaining credits at zero", async () => {
		const zeroFetch: FetchImpl = async () =>
			jsonResponse(
				usageResponse({
					resourceType: "CREDIT",
					currentUsageWithPrecision: 0,
					usageLimitWithPrecision: 0,
				}),
			);
		const zero = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "us-east-1" },
			"profile-fixture",
			zeroFetch,
		);
		expect(zero.remainingCredits).toBe(0);
		expect(zero.percentUsed).toBe(0);

		const overFetch: FetchImpl = async () =>
			jsonResponse(
				usageResponse({
					resourceType: "CREDIT",
					currentUsageWithPrecision: 1050,
					usageLimitWithPrecision: 1000,
				}),
			);
		const over = await fetchKiroUsage(
			{ accessToken: "access-fixture", region: "us-east-1" },
			"profile-fixture",
			overFetch,
		);
		expect(over.remainingCredits).toBe(0);
		expect(over.percentUsed).toBe(105);
	});

	it("rejects a response whose breakdown list has no credit entry", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse(
				usageResponse({
					resourceType: "AGENTIC_REQUEST",
					currentUsage: 1,
					usageLimit: 2,
				}),
			);

		await expect(
			fetchKiroUsage(
				{ accessToken: "access-fixture", region: "us-east-1" },
				"profile-fixture",
				fetchMock,
			),
		).rejects.toThrow("no credit breakdown");
	});

	it("rejects a response without a usage breakdown list", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({ subscriptionInfo: { subscriptionTitle: "Kiro Pro" } });

		await expect(
			fetchKiroUsage(
				{ accessToken: "access-fixture", region: "us-east-1" },
				"profile-fixture",
				fetchMock,
			),
		).rejects.toThrow("no credit breakdown");
	});

	it("rejects a credit entry without usable usage numbers", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse(
				usageResponse({
					resourceType: "CREDIT",
					currentUsageWithPrecision: "n/a",
					usageLimitWithPrecision: null,
				}),
			);

		await expect(
			fetchKiroUsage(
				{ accessToken: "access-fixture", region: "us-east-1" },
				"profile-fixture",
				fetchMock,
			),
		).rejects.toThrow("invalid credit breakdown");
	});

	it("surfaces HTTP failures without leaking the access token", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({}, 403);
		let error: unknown;
		try {
			await fetchKiroUsage(
				{ accessToken: "top-secret-token", region: "us-east-1" },
				"profile-fixture",
				fetchMock,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(KiroManagementHttpError);
		expect((error as KiroManagementHttpError).status).toBe(403);
		expect((error as Error).message).not.toContain("top-secret-token");
		expect((error as Error).message).not.toContain("profile-fixture");
	});
});

describe("formatKiroUsage", () => {
	it("renders a stable multi-line summary with two-decimal numbers", () => {
		const snapshot: KiroUsageSnapshot = {
			usedCredits: 327.46,
			totalCredits: 1000,
			remainingCredits: 672.54,
			percentUsed: 32.746,
			nextReset: "2026-09-01",
			subscriptionTitle: "Kiro Pro",
		};
		expect(formatKiroUsage(snapshot)).toBe(
			[
				"Kiro Pro",
				"Used 327.46 of 1000 credits (32.75%)",
				"Remaining 672.54 credits",
				"Resets 2026-09-01",
			].join("\n"),
		);
	});

	it("strips floating-point tails and omits optional lines", () => {
		const snapshot: KiroUsageSnapshot = {
			usedCredits: 0.30000000000000004,
			totalCredits: 10,
			remainingCredits: 9.7,
			percentUsed: 3.0000000000000004,
		};
		expect(formatKiroUsage(snapshot)).toBe(
			[
				"Kiro credits",
				"Used 0.3 of 10 credits (3%)",
				"Remaining 9.7 credits",
			].join("\n"),
		);
	});
});
