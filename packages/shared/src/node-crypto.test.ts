import { describe, expect, it } from "vitest";
import {
  generateEd25519KeyPair,
  signJsonEnvelope,
  verifyJsonEnvelope
} from "./node-crypto.js";

describe("signed envelopes", () => {
  it("round-trips signed JSON bytes", () => {
    const keys = generateEd25519KeyPair();
    const envelope = signJsonEnvelope({ revision: 3 }, keys.privateKeyPem, "test");

    expect(verifyJsonEnvelope(envelope, keys.publicKeyPem)).toEqual(envelope);
  });

  it("rejects a modified payload", () => {
    const keys = generateEd25519KeyPair();
    const envelope = signJsonEnvelope({ revision: 3 }, keys.privateKeyPem, "test");
    const tampered = {
      ...envelope,
      payload: Buffer.from(JSON.stringify({ revision: 4 })).toString("base64")
    };

    expect(() => verifyJsonEnvelope(tampered, keys.publicKeyPem)).toThrow(
      "signature verification failed"
    );
  });
});
