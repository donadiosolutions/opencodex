import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { stripInternalChatMessageTokenCount } from "../../src/adapters/openai-responses/request-strips";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

/** A custom Responses relay like Codex Web GPT (chatgpt-web) reached with forward or key auth. */
const CHATGPT_WEB_RELAY_KEY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "http://127.0.0.1:17841/v1",
  authMode: "key",
  apiKey: "secret-key",
  preserveResponsesInputItemIds: true,
  preserveResponsesMessageMetadata: true,
};

const ORDINARY_NONCANONICAL_KEY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://gateway.example/v1",
  authMode: "key",
  apiKey: "secret-key",
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

function sampleCodexClientBody() {
  return {
    model: "chatgpt-web/gpt-5.6-sol-instant",
    store: false,
    input: [
      {
        id: "msg_user_123",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly: WEB READY" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn_abc_456",
          conversation_id: "conv_xyz",
        },
      },
    ],
  };
}

test("ordinary noncanonical Responses destinations strip input IDs when store: false and strip private metadata", () => {
  const sent = sentBody(ORDINARY_NONCANONICAL_KEY, sampleCodexClientBody());
  expect(sent.input).toBeArray();
  const firstItem = (sent.input as Record<string, unknown>[])[0]!;
  expect(firstItem).not.toHaveProperty("id");
  expect(firstItem).not.toHaveProperty("internal_chat_message_metadata_passthrough");
  expect(firstItem.role).toBe("user");
});

test("opted-in provider preserves input IDs when store: false for launcher session replay (#6220)", () => {
  const sent = sentBody(CHATGPT_WEB_RELAY_KEY, sampleCodexClientBody());
  expect(sent.input).toBeArray();
  const firstItem = (sent.input as Record<string, unknown>[])[0]!;
  expect(firstItem.id).toBe("msg_user_123");
  expect(firstItem.internal_chat_message_metadata_passthrough).toEqual({
    turn_id: "turn_abc_456",
    conversation_id: "conv_xyz",
  });
  expect(firstItem.role).toBe("user");
});

test("opted-in provider preserveResponsesInputItemIds alone keeps input IDs while stripping metadata", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "http://127.0.0.1:17841/v1",
    authMode: "key",
    apiKey: "secret-key",
    preserveResponsesInputItemIds: true,
  };
  const sent = sentBody(provider, sampleCodexClientBody());
  const firstItem = (sent.input as Record<string, unknown>[])[0]!;
  expect(firstItem.id).toBe("msg_user_123");
  expect(firstItem).not.toHaveProperty("internal_chat_message_metadata_passthrough");
});

test("opted-in provider preserveResponsesMessageMetadata alone keeps metadata while stripping input IDs", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "http://127.0.0.1:17841/v1",
    authMode: "key",
    apiKey: "dummy-key",
    preserveResponsesMessageMetadata: true,
  };
  const sent = sentBody(provider, sampleCodexClientBody());
  const firstItem = (sent.input as Record<string, unknown>[])[0]!;
  expect(firstItem).not.toHaveProperty("id");
  expect(firstItem.internal_chat_message_metadata_passthrough).toEqual({
    turn_id: "turn_abc_456",
    conversation_id: "conv_xyz",
  });
});

test("opted-in preserveResponsesInputItemIds on xAI destination still repairs custom_tool_call IDs", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key",
    apiKey: "dummy-key",
    preserveResponsesInputItemIds: true,
  };
  const bodyWithCustomToolCall = {
    model: "grok-beta",
    store: false,
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_123",
        name: "test_tool",
        input: "{}",
      },
      {
        type: "message",
        role: "user",
        id: "msg_user_kept",
        content: "hello",
      },
    ],
  };
  for (const store of [false, true]) {
    for (const id of [undefined, "invalid-id"]) {
      const sent = sentBody(provider, { ...bodyWithCustomToolCall, store, input: [
        { ...bodyWithCustomToolCall.input[0], ...(id ? { id } : {}) }, bodyWithCustomToolCall.input[1],
      ] });
      const items = sent.input as Record<string, unknown>[];
      expect(items[0]!.type).toBe("custom_tool_call");
      expect(String(items[0]!.id)).toStartWith("ctc_");
      expect(items[1]!.id).toBe("msg_user_kept");
    }
  }
});

for (const authMode of ["forward", "key"] as const) {
  test(`OpenAI ${authMode} drops rejected token counts from HTTP and WS replay only`, () => {
    const provider: OcxProviderConfig = { adapter: "openai-responses", authMode,
      baseUrl: authMode === "forward" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
      preserveResponsesMessageMetadata: true };
    const raw = sampleCodexClientBody();
    const metadata = { turn_id: "turn_abc_456", content_token_count: 42, create_time: 123,
      content_item_kinds: ["user.text"], future_field: "preserved" };
    Object.assign(raw.input[0]!.internal_chat_message_metadata_passthrough, metadata);
    const before = structuredClone(raw);
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "gpt-6-luna", context: { messages: [] }, stream: true, options: {}, _rawBody: raw,
    }, { headers: new Headers({ authorization: "Bearer fixture" }) });
    try {
      const ws = prepareCodexWsRequest(request.url, { method: request.method, headers: request.headers, body: request.body });
      expect(ws).not.toBeNull();
      for (const body of [JSON.parse(request.body), JSON.parse(ws!.frameText), JSON.parse(ws!.httpInit.body as string)]) {
        expect(body.input[0].internal_chat_message_metadata_passthrough).toEqual({
          turn_id: "turn_abc_456", conversation_id: "conv_xyz", create_time: 123, content_item_kinds: ["user.text"], future_field: "preserved",
        });
      }
      expect(raw).toEqual(before);
    } finally { request.releaseBodyObservation?.(); }
  });
}

test("opted-in third-party replay retains its own token-count metadata", () => {
  const raw = sampleCodexClientBody();
  Object.assign(raw.input[0]!.internal_chat_message_metadata_passthrough, { content_token_count: 42 });
  const sent = sentBody(CHATGPT_WEB_RELAY_KEY, raw);
  expect((sent.input as Record<string, unknown>[])[0]!.internal_chat_message_metadata_passthrough)
    .toEqual(raw.input[0]!.internal_chat_message_metadata_passthrough);
});

test("token-count projection preserves clean and malformed metadata by reference", () => {
  for (const body of [null, {}, { input: "text" }, { input: [null, { internal_chat_message_metadata_passthrough: null },
    { internal_chat_message_metadata_passthrough: "opaque" }, { internal_chat_message_metadata_passthrough: { turn_id: "t" } }] }]) {
    expect(stripInternalChatMessageTokenCount(body)).toBe(body);
  }
});
