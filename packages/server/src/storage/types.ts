import type { PatchOp, Tx } from "@tether/protocol";

export interface PushTxn {
  // Creates the client row on first use, then locks it. Concurrent pushes from one client serialize here.
  lockClient(
    clientId: string,
    userId: string,
  ): Promise<{ userId: string; lastMutationId: number }>;
  setLastMutationId(clientId: string, id: number): Promise<void>;
  // Writers are serialized by a row lock, so versions become visible in commit order.
  nextVersion(): Promise<number>;
  // Runs fn against a Tx stamped with `version`. A throw undoes fn's writes and rethrows.
  attempt(version: number, fn: (tx: Tx) => Promise<void>): Promise<void>;
}

export interface PullTxn {
  head(clientId: string): Promise<{
    userId?: string; // unset when the client never pushed
    lastMutationId: number;
    version: number;
    minRetainedVersion: number;
  }>;
  snapshot(): Promise<PatchOp[]>;
  changesSince(cookie: number): Promise<PatchOp[]>;
}

export interface ServerStorage {
  transact<T>(fn: (t: PushTxn) => Promise<T>): Promise<T>;
  read<T>(fn: (t: PullTxn) => Promise<T>): Promise<T>;
  compactLog(retainVersions: number): Promise<void>;
}
