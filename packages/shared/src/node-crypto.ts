import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import {
  signedEnvelopeSchema,
  type SignedEnvelope
} from "./index.js";

export interface GeneratedEd25519KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyRawBase64: string;
}

export function generateEd25519KeyPair(): GeneratedEd25519KeyPair {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({
    format: "pem",
    type: "pkcs8"
  }).toString();
  const publicKeyPem = pair.publicKey.export({
    format: "pem",
    type: "spki"
  }).toString();
  const publicKeyDer = pair.publicKey.export({
    format: "der",
    type: "spki"
  });

  return {
    privateKeyPem,
    publicKeyPem,
    publicKeyRawBase64: publicKeyDer.subarray(-32).toString("base64")
  };
}

export function signJsonEnvelope(
  value: unknown,
  privateKeyPem: string,
  keyId: string
): SignedEnvelope {
  const payloadBytes = Buffer.from(JSON.stringify(value), "utf8");
  const signature = sign(
    null,
    payloadBytes,
    createPrivateKey(privateKeyPem)
  );

  return {
    algorithm: "Ed25519",
    keyId,
    payload: payloadBytes.toString("base64"),
    signature: signature.toString("base64")
  };
}

export function verifyJsonEnvelope(
  value: unknown,
  publicKeyPem: string
): SignedEnvelope {
  const envelope = signedEnvelopeSchema.parse(value);
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  const valid = verify(
    null,
    payload,
    createPublicKey(publicKeyPem),
    signature
  );

  if (!valid) {
    throw new Error("Envelope signature verification failed");
  }

  return envelope;
}

