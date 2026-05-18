import { describe, expect, it, vi } from "vitest";
import * as appAuth from "../src/github/appAuth.js";
import { buildGithubTools } from "../src/agent/githubTools.js";

type FnMap = Partial<{
	pullsGet: ReturnType<typeof vi.fn>;
	pullsList: ReturnType<typeof vi.fn>;
	pullsListFiles: ReturnType<typeof vi.fn>;
	pullsListReviews: ReturnType<typeof vi.fn>;
	pullsCreateReview: ReturnType<typeof vi.fn>;
	reposGetContent: ReturnType<typeof vi.fn>;
	reposListCommits: ReturnType<typeof vi.fn>;
	reposGetCommit: ReturnType<typeof vi.fn>;
	reposGet: ReturnType<typeof vi.fn>;
	reposListBranches: ReturnType<typeof vi.fn>;
	searchCode: ReturnType<typeof vi.fn>;
	issuesCreateComment: ReturnType<typeof vi.fn>;
	graphql: ReturnType<typeof vi.fn>;
}>;

function makeOctokitStub(fns: FnMap = {}) {
	return {
		rest: {
			pulls: {
				get: fns.pullsGet ?? vi.fn(),
				list: fns.pullsList ?? vi.fn(),
				listFiles: fns.pullsListFiles ?? vi.fn(),
				listReviews: fns.pullsListReviews ?? vi.fn(),
				createReview: fns.pullsCreateReview ?? vi.fn(),
			},
			repos: {
				getContent: fns.reposGetContent ?? vi.fn(),
				listCommits: fns.reposListCommits ?? vi.fn(),
				getCommit: fns.reposGetCommit ?? vi.fn(),
				get: fns.reposGet ?? vi.fn(),
				listBranches: fns.reposListBranches ?? vi.fn(),
			},
			search: { code: fns.searchCode ?? vi.fn() },
			issues: { createComment: fns.issuesCreateComment ?? vi.fn() },
		},
		graphql: fns.graphql ?? vi.fn(),
	} as unknown as ReturnType<typeof appAuth.installationOctokit>;
}

function buildWithStub(stub: ReturnType<typeof makeOctokitStub>) {
	vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);
	return buildGithubTools("tok");
}

describe("buildGithubTools — surface", () => {
	it("exposes exactly 13 tools", () => {
		const { piTools } = buildWithStub(makeOctokitStub());
		expect(piTools).toHaveLength(13);
		expect(piTools.map((t) => t.name).sort()).toEqual(
			[
				"addPullRequestComment",
				"createPullRequestReview",
				"getBlame",
				"getCommit",
				"getFileContent",
				"getPullRequest",
				"getRepository",
				"listBranches",
				"listCommits",
				"listPullRequestFiles",
				"listPullRequestReviews",
				"listPullRequests",
				"searchCode",
			].sort(),
		);
	});

	it.each([
		["getPullRequest", ["owner", "repo", "pullNumber"]],
		["listPullRequests", ["owner", "repo"]],
		["listPullRequestFiles", ["owner", "repo", "pullNumber"]],
		["listPullRequestReviews", ["owner", "repo", "pullNumber"]],
		["getFileContent", ["owner", "repo", "path"]],
		["listCommits", ["owner", "repo"]],
		["getCommit", ["owner", "repo", "ref"]],
		["getBlame", ["owner", "repo", "path"]],
		["getRepository", ["owner", "repo"]],
		["listBranches", ["owner", "repo"]],
		["searchCode", ["query"]],
		["addPullRequestComment", ["owner", "repo", "pullNumber", "body"]],
		["createPullRequestReview", ["owner", "repo", "pullNumber", "event", "body"]],
	])("%s parameters declare object type and required fields", (name, required) => {
		const { piTools } = buildWithStub(makeOctokitStub());
		const tool = piTools.find((t) => t.name === name)!;
		const params = tool.parameters as { type: string; required?: string[]; properties: Record<string, unknown> };
		expect(params.type).toBe("object");
		for (const field of required) {
			expect(params.required).toContain(field);
			expect(params.properties).toHaveProperty(field);
		}
	});
});

describe("buildGithubTools — happy paths", () => {
	it("getPullRequest maps Octokit response to authorLogin and changedFiles", async () => {
		const pullsGet = vi.fn().mockResolvedValue({
			data: {
				number: 3,
				title: "t",
				body: "b",
				state: "open",
				html_url: "u",
				user: { login: "octocat" },
				head: { ref: "feature" },
				base: { ref: "main" },
				draft: false,
				merged: false,
				mergeable: true,
				additions: 1,
				deletions: 2,
				changed_files: 3,
				created_at: "2024-01-01",
				updated_at: "2024-01-02",
				merged_at: null,
			},
		});
		const { executors } = buildWithStub(makeOctokitStub({ pullsGet }));

		const out = await executors.getPullRequest({ owner: "o", repo: "r", pullNumber: 3 });

		expect(pullsGet).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 3 });
		expect(out).toMatchObject({ number: 3, authorLogin: "octocat", changedFiles: 3, branch: "feature", base: "main" });
	});

	it("listPullRequests defaults state=open and perPage=30, returns authorLogin", async () => {
		const pullsList = vi.fn().mockResolvedValue({
			data: [
				{
					number: 1,
					title: "t",
					state: "open",
					html_url: "u",
					user: { login: "octocat" },
					head: { ref: "x" },
					base: { ref: "main" },
					draft: false,
					created_at: "a",
					updated_at: "b",
				},
			],
		});
		const { executors } = buildWithStub(makeOctokitStub({ pullsList }));

		const out = (await executors.listPullRequests({ owner: "o", repo: "r" })) as Array<{ authorLogin: string }>;

		expect(pullsList).toHaveBeenCalledWith({ owner: "o", repo: "r", state: "open", per_page: 30 });
		expect(out[0]).toMatchObject({ authorLogin: "octocat" });
	});

	it("listPullRequestFiles forwards paging and returns patch", async () => {
		const pullsListFiles = vi.fn().mockResolvedValue({
			data: [
				{ filename: "f.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@..." },
			],
		});
		const { executors } = buildWithStub(makeOctokitStub({ pullsListFiles }));

		const out = (await executors.listPullRequestFiles({
			owner: "o",
			repo: "r",
			pullNumber: 3,
		})) as Array<{ patch: string }>;

		expect(pullsListFiles).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 3, per_page: 30, page: 1 });
		expect(out[0].patch).toBe("@@...");
	});

	it("listPullRequestReviews returns authorLogin instead of bare author", async () => {
		const pullsListReviews = vi.fn().mockResolvedValue({
			data: [{ id: 1, state: "COMMENTED", body: "b", user: { login: "octocat" }, html_url: "u", submitted_at: "t" }],
		});
		const { executors } = buildWithStub(makeOctokitStub({ pullsListReviews }));

		const out = (await executors.listPullRequestReviews({
			owner: "o",
			repo: "r",
			pullNumber: 3,
		})) as Array<{ authorLogin: string }>;

		expect(out[0].authorLogin).toBe("octocat");
	});

	it("listCommits uses authorName (git) and authorLogin (GitHub)", async () => {
		const reposListCommits = vi.fn().mockResolvedValue({
			data: [
				{
					sha: "abc",
					commit: { message: "m", author: { name: "Git Name", date: "2024-01-01" } },
					author: { login: "octocat" },
					html_url: "u",
				},
			],
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposListCommits }));

		const out = (await executors.listCommits({ owner: "o", repo: "r" })) as Array<{
			authorName: string;
			authorLogin: string;
		}>;

		expect(out[0]).toMatchObject({ authorName: "Git Name", authorLogin: "octocat" });
	});

	it("getCommit returns `changes` (not totalChanges) and mapped files", async () => {
		const reposGetCommit = vi.fn().mockResolvedValue({
			data: {
				sha: "abc",
				commit: { message: "m", author: { name: "Git Name", date: "d" } },
				author: { login: "octocat" },
				html_url: "u",
				stats: { additions: 1, deletions: 2, total: 3 },
				files: [{ filename: "f.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "p" }],
			},
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposGetCommit }));

		const out = (await executors.getCommit({ owner: "o", repo: "r", ref: "abc" })) as {
			changes: number;
			authorName: string;
			authorLogin: string;
			files: Array<{ patch: string }>;
		};

		expect(out.changes).toBe(3);
		expect(out.authorName).toBe("Git Name");
		expect(out.authorLogin).toBe("octocat");
		expect(out.files[0].patch).toBe("p");
		expect(out).not.toHaveProperty("totalChanges");
	});

	it("getRepository returns fullName + defaultBranch", async () => {
		const reposGet = vi.fn().mockResolvedValue({
			data: {
				name: "r",
				full_name: "o/r",
				description: "d",
				html_url: "u",
				default_branch: "main",
				stargazers_count: 1,
				forks_count: 2,
				open_issues_count: 3,
				language: "TypeScript",
				private: false,
				created_at: "a",
				updated_at: "b",
			},
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposGet }));

		const out = (await executors.getRepository({ owner: "o", repo: "r" })) as { fullName: string; defaultBranch: string };
		expect(out).toMatchObject({ fullName: "o/r", defaultBranch: "main" });
	});

	it("listBranches drops the `protected` field", async () => {
		const reposListBranches = vi.fn().mockResolvedValue({
			data: [{ name: "main", commit: { sha: "abc" }, protected: true }],
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposListBranches }));

		const out = (await executors.listBranches({ owner: "o", repo: "r" })) as Array<{ name: string; sha: string }>;
		expect(out).toEqual([{ name: "main", sha: "abc" }]);
		expect(out[0]).not.toHaveProperty("protected");
	});

	it("searchCode returns repositoryFullName instead of repository", async () => {
		const searchCode = vi.fn().mockResolvedValue({
			data: {
				total_count: 1,
				items: [
					{
						name: "f.ts",
						path: "src/f.ts",
						html_url: "u",
						repository: { full_name: "o/r" },
						sha: "abc",
					},
				],
			},
		});
		const { executors } = buildWithStub(makeOctokitStub({ searchCode }));

		const out = (await executors.searchCode({ query: "foo" })) as {
			totalCount: number;
			items: Array<{ repositoryFullName: string }>;
		};

		expect(searchCode).toHaveBeenCalledWith({ q: "foo", per_page: 10 });
		expect(out.items[0]).toMatchObject({ repositoryFullName: "o/r" });
		expect(out.items[0]).not.toHaveProperty("repository");
	});

	it("addPullRequestComment posts via issues.createComment and returns authorLogin", async () => {
		const issuesCreateComment = vi.fn().mockResolvedValue({
			data: { id: 99, html_url: "u", body: "hi", user: { login: "octocat" }, created_at: "t" },
		});
		const { executors } = buildWithStub(makeOctokitStub({ issuesCreateComment }));

		const out = (await executors.addPullRequestComment({
			owner: "o",
			repo: "r",
			pullNumber: 3,
			body: "hi",
		})) as { authorLogin: string; id: number };

		expect(issuesCreateComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 3, body: "hi" });
		expect(out).toMatchObject({ id: 99, authorLogin: "octocat" });
	});
});

describe("getFileContent — three branches", () => {
	it("file branch: base64-decodes content and returns sha + size", async () => {
		const reposGetContent = vi.fn().mockResolvedValue({
			data: {
				type: "file",
				path: "src/f.ts",
				sha: "abc",
				size: 42,
				content: Buffer.from("hello world").toString("base64"),
			},
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposGetContent }));

		const out = (await executors.getFileContent({ owner: "o", repo: "r", path: "src/f.ts" })) as {
			type: string;
			content: string;
		};

		expect(out).toMatchObject({ type: "file", path: "src/f.ts", sha: "abc", size: 42, content: "hello world" });
	});

	it("directory branch: returns entries[]", async () => {
		const reposGetContent = vi.fn().mockResolvedValue({
			data: [
				{ name: "f.ts", type: "file", path: "src/f.ts" },
				{ name: "sub", type: "dir", path: "src/sub" },
			],
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposGetContent }));

		const out = (await executors.getFileContent({ owner: "o", repo: "r", path: "src" })) as {
			type: string;
			entries: Array<{ name: string }>;
		};

		expect(out.type).toBe("directory");
		expect(out.entries.map((e) => e.name)).toEqual(["f.ts", "sub"]);
	});

	it("other branch (symlink): returns { type, path }", async () => {
		const reposGetContent = vi.fn().mockResolvedValue({
			data: { type: "symlink", path: "src/link" },
		});
		const { executors } = buildWithStub(makeOctokitStub({ reposGetContent }));

		const out = (await executors.getFileContent({ owner: "o", repo: "r", path: "src/link" })) as {
			type: string;
			path: string;
		};

		expect(out).toEqual({ type: "symlink", path: "src/link" });
	});
});

describe("getBlame — branches and error paths", () => {
	function blamePayload(ranges: Array<{ startingLine: number; endingLine: number; age?: number }>) {
		return {
			repository: {
				object: {
					oid: "tip",
					blame: {
						ranges: ranges.map((r) => ({
							startingLine: r.startingLine,
							endingLine: r.endingLine,
							age: r.age ?? 0,
							commit: {
								oid: "abc",
								abbreviatedOid: "abc",
								messageHeadline: "m",
								authoredDate: "d",
								url: "u",
								author: { name: "n", email: "e", user: { login: "octocat" } },
							},
						})),
					},
				},
			},
		};
	}

	it("no filter: returns all ranges", async () => {
		const graphql = vi.fn().mockResolvedValue(
			blamePayload([
				{ startingLine: 1, endingLine: 5 },
				{ startingLine: 6, endingLine: 10 },
			]),
		);
		const { executors } = buildWithStub(makeOctokitStub({ graphql }));

		const out = (await executors.getBlame({ owner: "o", repo: "r", path: "f.ts", ref: "abc" })) as {
			rangeCount: number;
			ranges: unknown[];
		};

		expect(out.rangeCount).toBe(2);
		expect(out.ranges).toHaveLength(2);
	});

	it("line filter keeps only the overlapping range", async () => {
		const graphql = vi.fn().mockResolvedValue(
			blamePayload([
				{ startingLine: 1, endingLine: 5 },
				{ startingLine: 6, endingLine: 10 },
			]),
		);
		const { executors } = buildWithStub(makeOctokitStub({ graphql }));

		const out = (await executors.getBlame({
			owner: "o",
			repo: "r",
			path: "f.ts",
			ref: "abc",
			line: 7,
		})) as { rangeCount: number; ranges: Array<{ startingLine: number; endingLine: number }> };

		expect(out.rangeCount).toBe(1);
		expect(out.ranges[0]).toMatchObject({ startingLine: 6, endingLine: 10 });
	});

	it("lineStart+lineEnd window keeps all overlapping ranges", async () => {
		const graphql = vi.fn().mockResolvedValue(
			blamePayload([
				{ startingLine: 1, endingLine: 5 },
				{ startingLine: 6, endingLine: 10 },
				{ startingLine: 11, endingLine: 15 },
			]),
		);
		const { executors } = buildWithStub(makeOctokitStub({ graphql }));

		const out = (await executors.getBlame({
			owner: "o",
			repo: "r",
			path: "f.ts",
			ref: "abc",
			lineStart: 4,
			lineEnd: 8,
		})) as { rangeCount: number };

		expect(out.rangeCount).toBe(2);
	});

	it("looks up default_branch when ref is omitted", async () => {
		const reposGet = vi.fn().mockResolvedValue({ data: { default_branch: "main" } });
		const graphql = vi.fn().mockResolvedValue(blamePayload([{ startingLine: 1, endingLine: 1 }]));
		const { executors } = buildWithStub(makeOctokitStub({ reposGet, graphql }));

		await executors.getBlame({ owner: "o", repo: "r", path: "f.ts" });

		expect(reposGet).toHaveBeenCalledWith({ owner: "o", repo: "r" });
		expect(graphql).toHaveBeenCalledWith(expect.any(String), {
			owner: "o",
			name: "r",
			expression: "main",
			path: "f.ts",
		});
	});

	it("throws when the repository is missing from the GraphQL response", async () => {
		const graphql = vi.fn().mockResolvedValue({ repository: null });
		const { executors } = buildWithStub(makeOctokitStub({ graphql }));

		await expect(
			executors.getBlame({ owner: "o", repo: "r", path: "f.ts", ref: "abc" }),
		).rejects.toThrow(/Repository not found: o\/r/);
	});

	it("throws when the ref does not resolve to a commit", async () => {
		const graphql = vi.fn().mockResolvedValue({ repository: { object: null } });
		const { executors } = buildWithStub(makeOctokitStub({ graphql }));

		await expect(
			executors.getBlame({ owner: "o", repo: "r", path: "f.ts", ref: "bogus" }),
		).rejects.toThrow(/did not resolve to a commit/);
	});
});

describe("createPullRequestReview — comments + event variants", () => {
	function mockedReview() {
		return vi.fn().mockResolvedValue({
			data: {
				id: 1,
				state: "COMMENTED",
				body: "b",
				html_url: "u",
				user: { login: "octocat" },
				submitted_at: "t",
			},
		});
	}

	it("forwards inline comments when provided", async () => {
		const pullsCreateReview = mockedReview();
		const { executors } = buildWithStub(makeOctokitStub({ pullsCreateReview }));

		await executors.createPullRequestReview({
			owner: "o",
			repo: "r",
			pullNumber: 3,
			event: "REQUEST_CHANGES",
			body: "fix",
			comments: [{ path: "f.ts", body: "nit", line: 5, side: "RIGHT" }],
		});

		expect(pullsCreateReview).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			pull_number: 3,
			body: "fix",
			event: "REQUEST_CHANGES",
			comments: [{ path: "f.ts", body: "nit", line: 5, side: "RIGHT" }],
		});
	});

	it("omits comments when not provided", async () => {
		const pullsCreateReview = mockedReview();
		const { executors } = buildWithStub(makeOctokitStub({ pullsCreateReview }));

		await executors.createPullRequestReview({
			owner: "o",
			repo: "r",
			pullNumber: 3,
			event: "COMMENT",
			body: "no actionable findings on changed lines",
		});

		expect(pullsCreateReview).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			pull_number: 3,
			body: "no actionable findings on changed lines",
			event: "COMMENT",
			comments: undefined,
		});
	});

	it("rejects calls without body (schema.parse throws before Octokit is hit)", async () => {
		const pullsCreateReview = mockedReview();
		const { executors } = buildWithStub(makeOctokitStub({ pullsCreateReview }));

		await expect(
			executors.createPullRequestReview({
				owner: "o",
				repo: "r",
				pullNumber: 3,
				event: "COMMENT",
			}),
		).rejects.toThrow();
		expect(pullsCreateReview).not.toHaveBeenCalled();
	});

	it.each(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const)("forwards event=%s", async (event) => {
		const pullsCreateReview = mockedReview();
		const { executors } = buildWithStub(makeOctokitStub({ pullsCreateReview }));

		await executors.createPullRequestReview({
			owner: "o",
			repo: "r",
			pullNumber: 3,
			event,
			body: "summary",
		});

		expect(pullsCreateReview).toHaveBeenCalledWith(expect.objectContaining({ event }));
	});
});
