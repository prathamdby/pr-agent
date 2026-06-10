import { describe, expect, it, vi } from "vitest";
import { buildContext7Tools } from "../src/agent/context7Tools.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function txtResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/plain", ...init?.headers },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h;
}

describe("buildContext7Tools — surface", () => {
  it("exposes both tools", () => {
    const { piTools } = buildContext7Tools({ apiKey: "" });
    expect(piTools.map((t) => t.name).toSorted()).toEqual(["getLibraryDocs", "resolveLibraryId"]);
  });

  it("keeps static parameter schemas identical across builds", () => {
    const first = buildContext7Tools({ apiKey: "" });
    const second = buildContext7Tools({ apiKey: "ctx7sk-test" });

    for (let i = 0; i < first.piTools.length; i++) {
      expect(second.piTools[i]?.parameters).toBe(first.piTools[i]?.parameters);
    }
  });

  it("resolveLibraryId parameters declare object type and require libraryName", () => {
    const { piTools } = buildContext7Tools({ apiKey: "" });
    const tool = piTools.find((t) => t.name === "resolveLibraryId");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: {
        libraryName: { type: "string" },
        query: { type: "string" },
      },
    });
    expect((tool?.parameters as { required?: string[] }).required).toContain("libraryName");
  });

  it("getLibraryDocs parameters declare object type and require libraryId", () => {
    const { piTools } = buildContext7Tools({ apiKey: "" });
    const tool = piTools.find((t) => t.name === "getLibraryDocs");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: {
        libraryId: { type: "string" },
        topic: { type: "string" },
      },
    });
    expect((tool?.parameters as { required?: string[] }).required).toContain("libraryId");
  });
});

describe("buildContext7Tools — executors", () => {
  it("resolveLibraryId hits /v2/libs/search, defaults query to libraryName, omits Authorization when key is empty", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: "/facebook/react", title: "React" }] }),
      );

    try {
      const { executors } = buildContext7Tools({ apiKey: "" });
      const out = (await executors.resolveLibraryId({
        libraryName: "react",
      })) as string;

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      const u = new URL(String(url));
      expect(u.origin + u.pathname).toBe("https://context7.com/api/v2/libs/search");
      expect(u.searchParams.get("libraryName")).toBe("react");
      expect(u.searchParams.get("query")).toBe("react");
      expect(headersOf(init).Authorization).toBeUndefined();
      expect(out).toBe('{"results":[{"id":"/facebook/react","title":"React"}]}');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("getLibraryDocs sends type=txt, trims topic into query, and attaches Authorization when apiKey is set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(txtResponse("# React Hooks\nuseState is..."));

    try {
      const { executors } = buildContext7Tools({ apiKey: "ctx7sk-test" });
      const out = (await executors.getLibraryDocs({
        libraryId: "/facebook/react",
        topic: "  hooks  ",
      })) as string;

      const [url, init] = fetchSpy.mock.calls[0];
      const u = new URL(String(url));
      expect(u.pathname).toBe("/api/v2/context");
      expect(u.searchParams.get("libraryId")).toBe("/facebook/react");
      expect(u.searchParams.get("type")).toBe("txt");
      expect(u.searchParams.get("query")).toBe("hooks");
      expect(headersOf(init).Authorization).toBe("Bearer ctx7sk-test");
      expect(out).toContain("React Hooks");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("getLibraryDocs omits the query param when topic is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(txtResponse("anything"));

    try {
      const { executors } = buildContext7Tools({ apiKey: "" });
      await executors.getLibraryDocs({ libraryId: "/facebook/react" });
      const [url] = fetchSpy.mock.calls[0];
      expect(new URL(String(url)).searchParams.get("query")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("throws with status + body detail on non-2xx", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ error: "Invalid library" }, { status: 404, statusText: "Not Found" }),
      );

    try {
      const { executors } = buildContext7Tools({ apiKey: "" });
      await expect(executors.getLibraryDocs({ libraryId: "/no/such/lib" })).rejects.toThrow(
        /Context7 404.*Invalid library/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
