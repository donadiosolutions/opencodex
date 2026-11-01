import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { restoreMuseToolNamesInJson } from "../../src/responses/muse-tool-name-alias";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const META_PROVIDER = {
  adapter: "openai-responses",
  baseUrl: "https://api.meta.ai/v1",
  apiKey: "test-key",
} as unknown as OcxProviderConfig;

const META_PATH_PROVIDER = {
  ...META_PROVIDER,
  baseUrl: "https://api.meta.ai",
  responsesPath: "/v1/responses",
} as unknown as OcxProviderConfig;

const XAI_PROVIDER = {
  adapter: "openai-responses",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "test-key",
} as unknown as OcxProviderConfig;

const HF = "mcp__plugin_huggingface-skills_huggingface-skills__";
const AE = "mcp__plugin_android-emulator_android-emulator__";
const MD = "mcp__plugin_microsoft-docs_microsoft-docs__";

/** Issue #4410: 20 of 93 ZCode MCP names exceed Meta Muse's 64-char wire limit. */
const LONG_ISSUE_NAMES = [
  HF + "hub_repo_search",
  HF + "hub_repo_details",
  AE + "android_install_app",
  AE + "android_uninstall_app",
  AE + "android_launch_app",
  AE + "android_list_devices",
  AE + "android_take_screenshot",
  AE + "android_dump_hierarchy",
  AE + "android_press_keyevent",
  AE + "android_start_emulator",
  AE + "android_stop_emulator",
  AE + "android_open_url_scheme",
  AE + "android_get_activity",
  AE + "android_wait_for_idle",
  AE + "android_grant_permission",
  AE + "android_revoke_permission",
  AE + "android_clear_app_data",
  AE + "android_list_packages",
  MD + "microsoft_docs_get_page_content",
  MD + "microsoft_learn_search_results",
];

const SHORT_CATALOG_NAMES = [
  "bash", "grep", "read_file", "write_file", "web_search", "exec",
  ...Array.from({ length: 67 }, (_, i) => "tool_" + String(i + 1).padStart(2, "0")),
];

function issue4410Catalog(): string[] {
  return [...LONG_ISSUE_NAMES, ...SHORT_CATALOG_NAMES];
}

function hashedName(original: string): string {
  const cleaned = original.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = cleaned.slice(0, 55) || "tool";
  const suffix = createHash("sha256").update(original).digest("hex").slice(0, 8);
  return base + "_" + suffix;
}

function functionTool(name: string): Record<string, unknown> {
  return { type: "function", name, parameters: { type: "object", properties: {} } };
}

function buildForProvider(
  provider: OcxProviderConfig,
  modelId: string,
  rawBody: Record<string, unknown>,
  providerName?: string,
) {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId,
    context: { messages: [] },
    stream: false,
    options: {},
    _rawBody: { model: modelId, input: "ping", ...rawBody },
  }, { headers: new Headers(), providerName });
  return {
    body: JSON.parse(request.body) as Record<string, unknown>,
    aliases: request.convertedMuseToolNameAliases,
  };
}

describe("#4410 Meta Muse 64-char tool-name aliasing", () => {
  test("the issue catalog contains 93 names with 20 over the limit", () => {
    const names = issue4410Catalog();
    expect(names).toHaveLength(93);
    expect(new Set(names).size).toBe(93);
    expect(LONG_ISSUE_NAMES).toHaveLength(20);
    expect(LONG_ISSUE_NAMES.every(name => name.length > 64)).toBe(true);
    expect(LONG_ISSUE_NAMES[0]).toBe("mcp__plugin_huggingface-skills_huggingface-skills__hub_repo_search");
    expect(LONG_ISSUE_NAMES[0]!.length).toBe(66);
    expect(SHORT_CATALOG_NAMES.every(name => name.length <= 64)).toBe(true);
  });

  test("api.meta.ai outbound body sends only <=64-char names for the 93-tool catalog, including default muse-spark-1.3", () => {
    const names = issue4410Catalog();
    const { body, aliases } = buildForProvider(META_PROVIDER, "muse-spark-1.3", {
      tools: names.map(functionTool),
    });
    const sent = (body.tools as Array<{ name: string }>).map(tool => tool.name);
    expect(sent).toHaveLength(93);
    expect(sent.every(name => name.length <= 64)).toBe(true);
    expect(sent.every(name => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    for (const original of LONG_ISSUE_NAMES) {
      const wire = hashedName(original);
      expect(sent).toContain(wire);
      expect(sent).not.toContain(original);
      expect(aliases?.get(wire)).toBe(original);
    }
    for (const original of SHORT_CATALOG_NAMES) {
      expect(sent).toContain(original);
    }
    expect(aliases?.size).toBe(20);
  });

  test("history function_call is aliased while auto tool_choice remains unchanged", () => {
    const longName = LONG_ISSUE_NAMES[0]!;
    const wire = hashedName(longName);
    const { body, aliases } = buildForProvider(META_PROVIDER, "muse-spark-1.3-contributor", {
      tools: [functionTool(longName), functionTool("read_file")],
      input: [
        { type: "function_call", name: longName, call_id: "c1", arguments: "{\"q\":\"hub\"}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tool_choice: "auto",
    });
    expect((body.tools as Array<{ name: string }>)[0]!.name).toBe(wire);
    expect((body.input as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function_call",
      name: wire,
      arguments: "{\"q\":\"hub\"}",
    });
    expect(body.tool_choice).toBe("auto");
    expect(aliases?.get(wire)).toBe(longName);
  });

  test("split Meta baseUrl and responsesPath still aliases because the host is api.meta.ai", () => {
    const longName = LONG_ISSUE_NAMES[2]!;
    const { body } = buildForProvider(META_PATH_PROVIDER, "muse-spark-1.3", {
      tools: [functionTool(longName)],
    });
    expect((body.tools as Array<{ name: string }>)[0]!.name).toBe(hashedName(longName));
  });

  test("a non-meta Responses provider keeps names verbatim", () => {
    const names = issue4410Catalog();
    const { body, aliases } = buildForProvider(XAI_PROVIDER, "grok-4.6", {
      tools: names.map(functionTool),
      tool_choice: { type: "function", name: LONG_ISSUE_NAMES[0] },
    });
    const sent = (body.tools as Array<{ name: string }>).map(tool => tool.name);
    expect(sent).toEqual(names);
    expect((body.tool_choice as { name: string }).name).toBe(LONG_ISSUE_NAMES[0]);
    expect(aliases).toBeUndefined();
  });
});


describe("Muse Code update_plan wire alias", () => {
  const original = "update_plan";
  const wire = hashedName(original);
  const args = '{"plan":[{"step":"update_plan","status":"completed"}]}';

  test("aliases declarations and replay, preserving caller data and restoring JSON/SSE identities", () => {
    const raw = {
      tools: [functionTool(original), functionTool("write_stdin"), functionTool("update_planner")],
      input: [
        { type: "function_call", name: original, call_id: "plan_call", arguments: args },
        { type: "function_call_output", call_id: "plan_call", output: "update_plan completed" },
        { role: "user", content: "Use update_plan" },
      ],
      tool_choice: "auto",
    };
    const before = JSON.stringify(raw);
    const { body, aliases } = buildForProvider(META_PROVIDER, "muse-wonder-full-1.0", raw, "meta-muse");
    expect(JSON.stringify(raw)).toBe(before);
    expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual([wire, "write_stdin", "update_planner"]);
    expect(body.input).toEqual([
      { type: "function_call", name: wire, call_id: "plan_call", arguments: args },
      { type: "function_call_output", call_id: "plan_call", output: "update_plan completed" },
      { role: "user", content: "Use update_plan" },
    ]);
    expect(aliases?.get(wire)).toBe(original);
    const call = { type: "function_call", name: wire, call_id: "plan_call", arguments: args };
    for (const payload of [
      { output: [call] },
      { type: "response.output_item.added", item: call },
      { type: "response.output_item.done", item: call },
      { type: "response.function_call_arguments.done", name: wire, arguments: args },
      { type: "response.function_call_arguments.delta", name: wire, delta: args },
      { type: "response.completed", response: { output: [call] } },
    ]) {
      const restored = restoreMuseToolNamesInJson(JSON.stringify(payload), aliases!);
      expect(restored).not.toContain('"name":"' + wire + '"');
      expect(restored).toContain('"name":"update_plan"');
      expect(restored).toContain(JSON.stringify(args));
    }
  });

  test("does not steal the identity of a declared alias-shaped tool", () => {
    for (const names of [[original, wire], [wire, original]]) {
      const { body, aliases } = buildForProvider(META_PROVIDER, "muse-spark-1.3", {
        tools: names.map(functionTool),
      }, "meta-muse");
      const sent = (body.tools as Array<{ name: string }>).map(tool => tool.name);
      expect(new Set(sent).size).toBe(2);
      expect(sent).toContain(wire);
      expect(sent).not.toContain(original);
      expect(aliases?.has(wire)).toBe(false);
      expect([...aliases!.values()]).toEqual([original]);
    }
  });

  test("aliases the normalized functions namespace from current additional_tools", () => {
    const { body, aliases } = buildForProvider(META_PROVIDER, "muse-spark-1.3", {
      input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [functionTool(original)] }] }],
    }, "meta-muse");
    expect((body.tools as Array<{ name: string }>)[0]!.name).toBe(wire);
    expect(aliases?.get(wire)).toBe(original);
  });


  test("aliases promoted tool-search declarations while preserving result data", () => {
    const { body, aliases } = buildForProvider(META_PROVIDER, "muse-spark-1.3", {
      input: [{ type: "tool_search_output", call_id: "search_plan", status: "completed", execution: "client",
        tools: [{ type: "namespace", name: "functions", tools: [functionTool(original)] }] }],
    }, "meta-muse");
    expect((body.tools as Array<{ name: string }>)[0]!.name).toBe(wire);
    const result = (body.input as Array<{ type: string; output: string }>)[0]!;
    expect(result.type).toBe("function_call_output");
    expect(JSON.parse(result.output).tools[0].name).toBe(original);
    expect(aliases?.get(wire)).toBe(original);
  });

  test("leaves other providers and a repointed Muse provider unchanged", () => {
    for (const [provider, name] of [
      [META_PROVIDER, "meta-model"], [META_PROVIDER, "custom-meta"],
      [XAI_PROVIDER, "xai"], [XAI_PROVIDER, "meta-muse"],
    ] as const) {
      const { body, aliases } = buildForProvider(provider, "muse-wonder-full-1.0", {
        tools: [functionTool(original)],
      }, name);
      expect((body.tools as Array<{ name: string }>)[0]!.name).toBe(original);
      expect(aliases?.size ?? 0).toBe(0);
    }
  });
});
