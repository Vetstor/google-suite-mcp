import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFirestoreStore } from "../src/remote/store.js";

const fake = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  transactions: 0,
  transactionReads: 0,
  transactionDeletes: 0,
}));

vi.mock("@google-cloud/firestore", () => ({
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  Firestore: class {
    collection(name: string) {
      return {
        doc: (id: string) => {
          const key = `${name}/${id}`;
          return {
            key,
            set: async (data: Record<string, unknown>) => { fake.docs.set(key, data); },
            get: async () => ({ exists: fake.docs.has(key), data: () => fake.docs.get(key) }),
            delete: async () => { fake.docs.delete(key); },
          };
        },
      };
    }

    async runTransaction<T>(fn: (tx: {
      get: (ref: { key: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      delete: (ref: { key: string }) => void;
    }) => Promise<T>): Promise<T> {
      fake.transactions++;
      return fn({
        get: async (ref) => {
          fake.transactionReads++;
          const data = fake.docs.get(ref.key);
          return { exists: data !== undefined, data: () => data };
        },
        delete: (ref) => {
          fake.transactionDeletes++;
          fake.docs.delete(ref.key);
        },
      });
    }
  },
}));

beforeEach(() => {
  fake.docs.clear();
  fake.transactions = 0;
  fake.transactionReads = 0;
  fake.transactionDeletes = 0;
});

describe("Firestore single-use credentials", () => {
  it("consumes auth codes and refresh tokens inside transactions", async () => {
    const store = await createFirestoreStore("test");
    const expiresAt = Date.now() + 60_000;
    await store.createAuthCode({
      codeHash: "code", clientId: "client", codeChallenge: "challenge",
      redirectUri: "https://example.com/callback", sub: "user", scopes: ["sheets"],
      resource: "https://example.com/mcp", expiresAt,
    });
    await store.createRefreshToken({
      tokenHash: "refresh", clientId: "client", sub: "user", scopes: ["sheets"],
      resource: "https://example.com/mcp", expiresAt,
    });

    expect(await store.takeAuthCode("code")).toMatchObject({ codeHash: "code" });
    expect(await store.takeAuthCode("code")).toBeUndefined();
    expect(await store.takeRefreshToken("refresh")).toMatchObject({ tokenHash: "refresh" });
    expect(await store.takeRefreshToken("refresh")).toBeUndefined();
    expect(fake.transactions).toBe(4);
    expect(fake.transactionReads).toBe(4);
    expect(fake.transactionDeletes).toBe(2);
  });

  it("rejects expired records while removing them atomically", async () => {
    const store = await createFirestoreStore("test");
    await store.createAuthCode({
      codeHash: "expired", clientId: "client", codeChallenge: "challenge",
      redirectUri: "https://example.com/callback", sub: "user", scopes: ["sheets"],
      expiresAt: Date.now() - 1000,
    });
    expect(await store.takeAuthCode("expired")).toBeUndefined();
    expect(fake.transactions).toBe(1);
    expect(fake.transactionDeletes).toBe(1);
    expect(fake.docs.has("authCodes/expired")).toBe(false);
  });
});
