import { describe, expect, it } from "@effect/vitest";
import { ToolResult, isRetryableUpstreamFailure, isToolFile, isToolResult } from "./tool-result";

describe("ToolResult", () => {
  it("ok wraps a value", () => {
    const r = ToolResult.ok({ count: 3 });
    expect(r).toEqual({ ok: true, data: { count: 3 } });
    expect(isToolResult(r)).toBe(true);
  });

  it("fail wraps a ToolError", () => {
    const r = ToolResult.fail({
      code: "upstream_http_error",
      status: 404,
      message: "Not found",
      details: { id: "x" },
    });
    expect(r).toEqual({
      ok: false,
      error: {
        code: "upstream_http_error",
        status: 404,
        message: "Not found",
        details: { id: "x" },
      },
    });
    expect(isToolResult(r)).toBe(true);
  });

  it("isToolResult rejects unrelated shapes", () => {
    expect(isToolResult(null)).toBe(false);
    expect(isToolResult({})).toBe(false);
    expect(isToolResult({ ok: true })).toBe(false);
    expect(isToolResult({ ok: false })).toBe(false);
    expect(isToolResult({ ok: false, error: {} })).toBe(false);
    expect(isToolResult({ ok: false, error: { code: 1, message: "x" } })).toBe(false);
    expect(isToolResult({ ok: "yes", data: 1 })).toBe(false);
  });

  it("isToolResult accepts both branches of the union", () => {
    expect(isToolResult({ ok: true, data: 1 })).toBe(true);
    expect(isToolResult({ ok: true, data: null })).toBe(true);
    expect(
      isToolResult({
        ok: false,
        error: { code: "x", message: "y" },
      }),
    ).toBe(true);
  });
});

describe("isRetryableUpstreamFailure", () => {
  it.each([
    {
      name: "408 is retryable for a non-idempotent operation",
      input: { status: 408, idempotent: false },
      expected: true,
    },
    {
      name: "425 is retryable for a non-idempotent operation",
      input: { status: 425, idempotent: false },
      expected: true,
    },
    {
      name: "429 is retryable for a non-idempotent operation",
      input: { status: 429, idempotent: false },
      expected: true,
    },
    {
      name: "503 is retryable for a non-idempotent operation",
      input: { status: 503, idempotent: false },
      expected: true,
    },
    {
      name: "500 is retryable for an idempotent operation",
      input: { status: 500, idempotent: true },
      expected: true,
    },
    {
      name: "502 is retryable for an idempotent operation",
      input: { status: 502, idempotent: true },
      expected: true,
    },
    {
      name: "504 is retryable for an idempotent operation",
      input: { status: 504, idempotent: true },
      expected: true,
    },
    {
      name: "500 is not retryable for a non-idempotent operation",
      input: { status: 500, idempotent: false },
      expected: false,
    },
    {
      name: "404 is not retryable for an idempotent operation",
      input: { status: 404, idempotent: true },
      expected: false,
    },
    {
      name: "401 is not retryable for an idempotent operation",
      input: { status: 401, idempotent: true },
      expected: false,
    },
    {
      name: "a timeout is retryable for an idempotent operation",
      input: { timedOut: true, idempotent: true },
      expected: true,
    },
    {
      name: "a timeout is not retryable for a non-idempotent operation",
      input: { timedOut: true, idempotent: false },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isRetryableUpstreamFailure(input)).toBe(expected);
  });
});

describe("ToolFile", () => {
  it("accepts a base64 file value", () => {
    const file = {
      _tag: "ToolFile",
      name: "photo.png",
      mimeType: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgo=",
      byteLength: 8,
    };

    expect(file).toEqual({
      _tag: "ToolFile",
      name: "photo.png",
      mimeType: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgo=",
      byteLength: 8,
    });
    expect(isToolFile(file)).toBe(true);
  });

  it("rejects unrelated shapes", () => {
    expect(isToolFile(null)).toBe(false);
    expect(isToolFile({ data: "abc" })).toBe(false);
    expect(
      isToolFile({
        _tag: "ToolFile",
        mimeType: "image/png",
        encoding: "utf8",
        data: "abc",
        byteLength: 3,
      }),
    ).toBe(false);
  });
});
