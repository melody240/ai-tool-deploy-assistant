import { describe, expect, it } from "vitest";
import { validateAdminApiUrl } from "./api-client.js";

describe("administrator API URL", () => {
  it("allows HTTPS and localhost SSH tunnels", () => {
    expect(validateAdminApiUrl("https://license.example.test").protocol).toBe(
      "https:"
    );
    expect(validateAdminApiUrl("http://127.0.0.1:8080").hostname).toBe(
      "127.0.0.1"
    );
  });

  it("rejects plaintext remote administrator endpoints", () => {
    expect(() =>
      validateAdminApiUrl("http://203.0.113.10:8080")
    ).toThrow("must use HTTPS");
  });
});
