import { randomUUID } from "node:crypto";
import HttpError from "../models/httpError.model.js";

// One running job per project: a lease per target that expires, so a crashed worker cannot hold it for ever.
export class MemoryLeaseService {
  constructor(clock = () => Date.now()) { this.clock = clock; this.leases = new Map(); }
  async acquire(target, ttlMs = 30000) {
    const current = this.leases.get(target);
    if (current && current.expiresAt > this.clock()) throw new HttpError(409, "ERR-JOB-RUNNING", "another job is running for this project");
    const lease = { target, token: randomUUID(), expiresAt: this.clock() + ttlMs };
    this.leases.set(target, lease);
    return lease;
  }
  async renew(lease, ttlMs = 30000) {
    const current = this.leases.get(lease.target);
    if (current?.token !== lease.token) throw new HttpError(409, "ERR-JOB-LEASE", "the job's lease was lost");
    current.expiresAt = this.clock() + ttlMs;
    return { ...lease, expiresAt: current.expiresAt };
  }
  async release(lease) {
    if (this.leases.get(lease.target)?.token === lease.token) this.leases.delete(lease.target);
  }
}
