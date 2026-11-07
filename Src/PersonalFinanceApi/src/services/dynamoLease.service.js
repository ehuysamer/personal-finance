import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import HttpError from "../models/httpError.model.js";

export default class DynamoLeaseService {
  constructor({ tableName, region, client = DynamoDBDocumentClient.from(new DynamoDBClient({ region })), clock = () => Date.now() }) { this.tableName = tableName; this.client = client; this.clock = clock; }
  async put(lease, condition, values) {
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: { ...lease, expiresAtEpochSeconds: Math.ceil(lease.expiresAt / 1000) }, ConditionExpression: condition, ExpressionAttributeNames: { "#target": "target", "#token": "token" }, ExpressionAttributeValues: values }));
      return lease;
    } catch (error) { if (error.name === "ConditionalCheckFailedException") return null; throw error; }
  }
  async acquire(target, ttlMs = 30000) {
    const now = this.clock();
    const lease = await this.put({ target, token: randomUUID(), expiresAt: now + ttlMs }, "attribute_not_exists(#target) OR expiresAt < :now OR #token = :none", { ":now": now, ":none": "" });
    if (!lease) throw new HttpError(409, "ERR-JOB-RUNNING", "another job is running for this project");
    return lease;
  }
  async renew(lease, ttlMs = 30000) {
    const renewed = await this.put({ ...lease, expiresAt: this.clock() + ttlMs }, "#token = :token", { ":token": lease.token });
    if (!renewed) throw new HttpError(409, "ERR-JOB-LEASE", "the job's lease was lost");
    return renewed;
  }
  async release(lease) {
    try { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { target: lease.target }, ConditionExpression: "#token = :token", ExpressionAttributeNames: { "#token": "token" }, ExpressionAttributeValues: { ":token": lease.token } })); }
    catch (error) { if (error.name !== "ConditionalCheckFailedException") throw error; }
  }
}
