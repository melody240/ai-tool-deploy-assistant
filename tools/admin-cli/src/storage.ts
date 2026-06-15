import { createReadStream } from "node:fs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AdminConfig } from "./config.js";

export class ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: NonNullable<AdminConfig["storage"]>) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  async uploadFile(
    localPath: string,
    objectKey: string,
    options: {
      contentType?: string;
      cacheControl?: string;
    } = {}
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: createReadStream(localPath),
        ContentType: options.contentType ?? "application/octet-stream",
        CacheControl: options.cacheControl
      })
    );
    return `${this.config.publicBaseUrl}/${encodeObjectKey(objectKey)}`;
  }

  async uploadJson(value: unknown, objectKey: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: `${JSON.stringify(value, null, 2)}\n`,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-cache"
      })
    );
    return `${this.config.publicBaseUrl}/${encodeObjectKey(objectKey)}`;
  }
}

function encodeObjectKey(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
