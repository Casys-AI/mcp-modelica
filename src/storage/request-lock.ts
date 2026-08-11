import { sha256 } from "../domain/hashing.ts";
import type { RequestLockPort } from "../domain/resumable-contracts.ts";
import { isOsLockHeld, OsLock } from "./os-lock.ts";

/** Filesystem/OS adapter for the resumable application's request-lock port. */
export class FileRequestLockPort implements RequestLockPort {
  constructor(private readonly directory: string) {}

  async acquire(requestId: string): Promise<OsLock | undefined> {
    return await OsLock.acquire(this.directory, await name(requestId));
  }

  async isHeld(requestId: string): Promise<boolean> {
    return await isOsLockHeld(this.directory, await name(requestId));
  }
}

async function name(requestId: string): Promise<string> {
  return `request-${await sha256(requestId)}`;
}
