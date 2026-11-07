import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import HttpError from "../models/httpError.model.js";

async function toBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default class S3ObjectStore {
  constructor({ bucket, region, client = new S3Client({ region }) }) { this.bucket = bucket; this.client = client; }
  async put(key, body, options = {}) {
    try {
      const response = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: options.contentType, Tagging: Object.entries(options.tags || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") || undefined, IfMatch: options.ifMatch, IfNoneMatch: options.ifNoneMatch ? "*" : undefined }));
      return { etag: response.ETag?.replaceAll('"', ""), version: response.VersionId };
    } catch (error) { throw new HttpError(error.$metadata?.httpStatusCode === 412 ? 409 : 502, "ERR-S3-WRITE", "S3 write failed"); }
  }
  async get(key) {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: await toBuffer(response.Body), etag: response.ETag?.replaceAll('"', ""), version: response.VersionId, contentType: response.ContentType };
    } catch (error) { if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) throw new HttpError(404, "ERR-OBJECT-NOT-FOUND", "object was not found"); throw new HttpError(502, "ERR-S3-READ", "S3 read failed"); }
  }
  async exists(key) { try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; } catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; } }
  async list(prefix = "") { const keys = []; let token; do { const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })); keys.push(...(response.Contents || []).map((entry) => entry.Key)); token = response.NextContinuationToken; } while (token); return keys.sort(); }
  // One level only: the "/" delimiter returns sub-folders as CommonPrefixes instead of every key below them.
  async listChildren(prefix = "") {
    const folders = [];
    const objects = [];
    let token;
    do {
      const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }));
      folders.push(...(response.CommonPrefixes || []).map((entry) => entry.Prefix.slice(prefix.length, -1)));
      objects.push(...(response.Contents || []).map((entry) => entry.Key));
      token = response.NextContinuationToken;
    } while (token);
    return { folders: folders.sort(), objects: objects.sort() };
  }
  async delete(key) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}
