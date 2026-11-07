import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const CANONICAL_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

/** A strict third-party Responses gateway: the Console Go shape reported in #4853. */
const THIRD_PARTY_KEY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://opencode.ai/zen/go/v1",
  authMode: "key",
  apiKey: "test-key",
};

/** A noncanonical gateway reached with forward auth, which receives no caller credentials. */
const THIRD_PARTY_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://gateway.example/v1",
  authMode: "forward",
};

/** The official OpenAI API under a key: OpenAI-operated, but not the ChatGPT Codex surface. */
const OPENAI_API_KEY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "key",
  apiKey: "test-key",
};

function sentBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>) {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: String(rawBody.model),
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
  }, { headers: new Headers({ authorization: "Bearer token" }) });
  return JSON.parse(request.body) as Record<string, unknown>;
}

function codexBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    access_programs: { cyber: "standard" },
    ...extra,
  };
}

test("a destination OpenCodex does not operate never receives access_programs", () => {
  // Codex 0.155 attaches the field from ChatGPT auth alone, so it rides along to whatever this
  // proxy routes to. A gateway that validates its top-level schema answers 400 and the turn dies.
  for (const provider of [THIRD_PARTY_KEY, THIRD_PARTY_FORWARD]) {
    expect(sentBody(provider, codexBody())).not.toHaveProperty("access_programs");
  }
});

test("only the canonical ChatGPT destination keeps access_programs", () => {
  // Access-program selection belongs to ChatGPT account auth. The public API
  // uses its own credentials and must not receive the caller's private selector.
  expect(sentBody(CANONICAL_FORWARD, codexBody()).access_programs).toEqual({ cyber: "standard" });
  expect(sentBody(OPENAI_API_KEY, codexBody())).not.toHaveProperty("access_programs");
});

test("stripping does not mutate the caller-owned raw body", () => {
  const rawBody = codexBody();
  sentBody(THIRD_PARTY_KEY, rawBody);
  expect(rawBody.access_programs).toEqual({ cyber: "standard" });
});

test("an unlisted top-level key is still forwarded", () => {
  // This is a table of observed private keys, not an unknown-parameter sanitizer. A key nobody has
  // traced to a client belongs to the caller, including the public parameters the same gateway
  // accepts, so removing it would silently drop something the caller meant.
  const sent = sentBody(THIRD_PARTY_KEY, codexBody({
    prompt_cache_key: "session-1",
    safety_identifier: "user-1",
    totally_made_up_param: 1,
  }));

  expect(sent).not.toHaveProperty("access_programs");
  expect(sent.prompt_cache_key).toBe("session-1");
  expect(sent.safety_identifier).toBe("user-1");
  expect(sent.totally_made_up_param).toBe(1);
});

test("the strip removes the key and nothing else", () => {
  const sent = sentBody(THIRD_PARTY_KEY, codexBody());

  expect(sent).not.toHaveProperty("access_programs");
  expect(sent.model).toBe("gpt-5.6-sol");
  expect(sent.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
});

test("routed agent requests omit OpenAI encrypted-output includes without mutating history", () => {
  const include = ["reasoning.encrypted_content", "output.encrypted_content", "web_search_call.action.sources"];
  const rawBody = codexBody({ include });
  for (const baseUrl of ["https://api.x.ai/v1", "https://api.meta.ai/v1", THIRD_PARTY_KEY.baseUrl]) {
    const sent = sentBody({ ...THIRD_PARTY_KEY, baseUrl }, rawBody);
    expect(sent.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
  }
  expect(rawBody.include).toBe(include);
  expect(include).toEqual(["reasoning.encrypted_content", "output.encrypted_content", "web_search_call.action.sources"]);
});

test("OpenAI destinations retain the encrypted-output include", () => {
  for (const provider of [CANONICAL_FORWARD, OPENAI_API_KEY]) {
    expect(sentBody(provider, codexBody({ include: ["output.encrypted_content"] })).include)
      .toEqual(["output.encrypted_content"]);
  }
});

test("routed requests omit an include list containing only encrypted output", () => {
  expect(sentBody(THIRD_PARTY_FORWARD, codexBody({ include: ["output.encrypted_content"] })))
    .not.toHaveProperty("include");
});
