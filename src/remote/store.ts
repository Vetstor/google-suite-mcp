import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * All timestamps are epoch milliseconds. Records whose `expiresAt` is in the
 * past MUST be treated as absent by the store (and may be physically deleted by
 * a Firestore TTL policy on the `expiresAt` field).
 */

export interface PendingAuth {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface AuthCodeRecord {
  codeHash: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  sub: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface AccessTokenRecord {
  tokenHash: string;
  sub: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  sub: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface UserRecord {
  sub: string;
  email: string;
  refreshTokenEnc: string;
  updatedAt: number;
}

export interface Store {
  // OAuth clients (dynamic client registration)
  createClient(client: OAuthClientInformationFull): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;

  // Pending authorizations (bridge between /authorize and Google callback)
  createPendingAuth(p: PendingAuth): Promise<void>;
  takePendingAuth(id: string): Promise<PendingAuth | undefined>;

  // Our authorization codes
  createAuthCode(a: AuthCodeRecord): Promise<void>;
  getAuthCode(codeHash: string): Promise<AuthCodeRecord | undefined>;
  deleteAuthCode(codeHash: string): Promise<void>;

  // Access & refresh tokens (only hashes stored)
  createAccessToken(t: AccessTokenRecord): Promise<void>;
  getAccessToken(tokenHash: string): Promise<AccessTokenRecord | undefined>;
  deleteAccessToken(tokenHash: string): Promise<void>;

  createRefreshToken(t: RefreshTokenRecord): Promise<void>;
  takeRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  deleteRefreshToken(tokenHash: string): Promise<void>;

  // Users (Google identity + encrypted refresh token)
  upsertUser(u: UserRecord): Promise<void>;
  getUser(sub: string): Promise<UserRecord | undefined>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (local dev / tests)
// ---------------------------------------------------------------------------

function fresh<T extends { expiresAt: number }>(rec: T | undefined): T | undefined {
  if (!rec) return undefined;
  if (rec.expiresAt <= Date.now()) return undefined;
  return rec;
}

export class MemoryStore implements Store {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, PendingAuth>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();
  private users = new Map<string, UserRecord>();

  async createClient(client: OAuthClientInformationFull): Promise<void> {
    this.clients.set(client.client_id, client);
  }
  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  async createPendingAuth(p: PendingAuth): Promise<void> {
    this.pending.set(p.id, p);
  }
  async takePendingAuth(id: string) {
    const rec = fresh(this.pending.get(id));
    this.pending.delete(id);
    return rec;
  }

  async createAuthCode(a: AuthCodeRecord): Promise<void> {
    this.authCodes.set(a.codeHash, a);
  }
  async getAuthCode(codeHash: string) {
    return fresh(this.authCodes.get(codeHash));
  }
  async deleteAuthCode(codeHash: string): Promise<void> {
    this.authCodes.delete(codeHash);
  }

  async createAccessToken(t: AccessTokenRecord): Promise<void> {
    this.accessTokens.set(t.tokenHash, t);
  }
  async getAccessToken(tokenHash: string) {
    return fresh(this.accessTokens.get(tokenHash));
  }
  async deleteAccessToken(tokenHash: string): Promise<void> {
    this.accessTokens.delete(tokenHash);
  }

  async createRefreshToken(t: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(t.tokenHash, t);
  }
  async takeRefreshToken(tokenHash: string) {
    const rec = fresh(this.refreshTokens.get(tokenHash));
    this.refreshTokens.delete(tokenHash);
    return rec;
  }
  async deleteRefreshToken(tokenHash: string): Promise<void> {
    this.refreshTokens.delete(tokenHash);
  }

  async upsertUser(u: UserRecord): Promise<void> {
    this.users.set(u.sub, u);
  }
  async getUser(sub: string) {
    return this.users.get(sub);
  }
}

// ---------------------------------------------------------------------------
// Firestore implementation
// ---------------------------------------------------------------------------

/**
 * Lazily imported so `STORE=memory` (and tests) never need the Firestore SDK
 * or Application Default Credentials.
 */
export async function createFirestoreStore(database: string): Promise<Store> {
  const { Firestore, Timestamp } = await import("@google-cloud/firestore");
  const db = new Firestore({ databaseId: database });

  const CLIENTS = "clients";
  const PENDING = "pendingAuth";
  const AUTH_CODES = "authCodes";
  const ACCESS = "accessTokens";
  const REFRESH = "refreshTokens";
  const USERS = "users";

  // Convert our numeric expiresAt into a Firestore Timestamp so a TTL policy
  // can be enabled on the field; everything else is stored verbatim.
  const toDoc = <T extends { expiresAt?: number }>(rec: T) => {
    const out: Record<string, unknown> = { ...rec };
    if (typeof rec.expiresAt === "number") {
      out.expiresAt = Timestamp.fromMillis(rec.expiresAt);
    }
    return out;
  };
  const fromDoc = <T extends { expiresAt?: number }>(
    data: Record<string, unknown> | undefined
  ): T | undefined => {
    if (!data) return undefined;
    const out = { ...data } as Record<string, unknown>;
    const ts = data.expiresAt as { toMillis?: () => number } | undefined;
    if (ts && typeof ts.toMillis === "function") {
      out.expiresAt = ts.toMillis();
    }
    const rec = out as T;
    if (typeof rec.expiresAt === "number" && rec.expiresAt <= Date.now()) {
      return undefined;
    }
    return rec;
  };

  return {
    async createClient(client) {
      await db.collection(CLIENTS).doc(client.client_id).set(client);
    },
    async getClient(clientId) {
      const snap = await db.collection(CLIENTS).doc(clientId).get();
      return snap.exists
        ? (snap.data() as OAuthClientInformationFull)
        : undefined;
    },

    async createPendingAuth(p) {
      await db.collection(PENDING).doc(p.id).set(toDoc(p));
    },
    async takePendingAuth(id) {
      const ref = db.collection(PENDING).doc(id);
      const snap = await ref.get();
      await ref.delete();
      return fromDoc<PendingAuth>(snap.data());
    },

    async createAuthCode(a) {
      await db.collection(AUTH_CODES).doc(a.codeHash).set(toDoc(a));
    },
    async getAuthCode(codeHash) {
      const snap = await db.collection(AUTH_CODES).doc(codeHash).get();
      return fromDoc<AuthCodeRecord>(snap.data());
    },
    async deleteAuthCode(codeHash) {
      await db.collection(AUTH_CODES).doc(codeHash).delete();
    },

    async createAccessToken(t) {
      await db.collection(ACCESS).doc(t.tokenHash).set(toDoc(t));
    },
    async getAccessToken(tokenHash) {
      const snap = await db.collection(ACCESS).doc(tokenHash).get();
      return fromDoc<AccessTokenRecord>(snap.data());
    },
    async deleteAccessToken(tokenHash) {
      await db.collection(ACCESS).doc(tokenHash).delete();
    },

    async createRefreshToken(t) {
      await db.collection(REFRESH).doc(t.tokenHash).set(toDoc(t));
    },
    async takeRefreshToken(tokenHash) {
      const ref = db.collection(REFRESH).doc(tokenHash);
      const snap = await ref.get();
      await ref.delete();
      return fromDoc<RefreshTokenRecord>(snap.data());
    },
    async deleteRefreshToken(tokenHash) {
      await db.collection(REFRESH).doc(tokenHash).delete();
    },

    async upsertUser(u) {
      await db.collection(USERS).doc(u.sub).set(u, { merge: true });
    },
    async getUser(sub) {
      const snap = await db.collection(USERS).doc(sub).get();
      return snap.exists ? (snap.data() as UserRecord) : undefined;
    },
  };
}

/** Build the configured store. */
export async function createStore(opts: {
  store: "firestore" | "memory";
  firestoreDatabase: string;
}): Promise<Store> {
  if (opts.store === "memory") return new MemoryStore();
  return createFirestoreStore(opts.firestoreDatabase);
}
