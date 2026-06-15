import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./config-input";

describe("configuration input", () => {
  it("accepts JSON objects", () => {
    expect(parseJsonObject('{"permissions":{"deny":[]}}', "settings.json")).toEqual({
      permissions: { deny: [] }
    });
  });

  it("rejects malformed JSON with the file name", () => {
    expect(() => parseJsonObject("{", ".mcp.json")).toThrow(
      ".mcp.json 不是有效 JSON"
    );
  });

  it("rejects non-object roots", () => {
    expect(() => parseJsonObject("[]", "settings.json")).toThrow(
      "settings.json 的根节点必须是 JSON 对象"
    );
  });
});
