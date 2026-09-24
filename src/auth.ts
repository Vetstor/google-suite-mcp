import { google } from "googleapis";
import type { sheets_v4, drive_v3, docs_v1, slides_v1 } from "googleapis";
import { readFileSync } from "fs";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
];

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

// Lazy singletons
let _auth: InstanceType<typeof google.auth.JWT> | null = null;
let _sheets: sheets_v4.Sheets | null = null;
let _drive: drive_v3.Drive | null = null;
let _docs: docs_v1.Docs | null = null;
let _slides: slides_v1.Slides | null = null;

export function loadServiceAccountKey(): ServiceAccountKey {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!keyFile && !keyRaw) {
    throw new Error(
      "Auth error: set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to JSON) " +
        "or GOOGLE_SERVICE_ACCOUNT_KEY (raw JSON string or base64-encoded JSON)."
    );
  }

  if (keyFile) {
    const raw = readFileSync(keyFile, "utf8");
    return JSON.parse(raw) as ServiceAccountKey;
  }

  // keyRaw: try direct JSON first, then base64
  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(keyRaw!) as ServiceAccountKey;
  } catch {
    try {
      const decoded = Buffer.from(keyRaw!, "base64").toString("utf8");
      parsed = JSON.parse(decoded) as ServiceAccountKey;
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON or base64-encoded JSON."
      );
    }
  }
  return parsed;
}

export function getAuth(): InstanceType<typeof google.auth.JWT> {
  if (_auth) return _auth;

  const key = loadServiceAccountKey();
  const impersonate = process.env.GOOGLE_IMPERSONATE_USER;

  _auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: impersonate || undefined,
  });

  return _auth;
}

export function getSheetsClient(): sheets_v4.Sheets {
  if (_sheets) return _sheets;
  const auth = getAuth();
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

export function getDriveClient(): drive_v3.Drive {
  if (_drive) return _drive;
  const auth = getAuth();
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

export function getDocsClient(): docs_v1.Docs {
  if (_docs) return _docs;
  const auth = getAuth();
  _docs = google.docs({ version: "v1", auth });
  return _docs;
}

export function getSlidesClient(): slides_v1.Slides {
  if (_slides) return _slides;
  const auth = getAuth();
  _slides = google.slides({ version: "v1", auth });
  return _slides;
}

export function getServiceAccountEmail(): string {
  const key = loadServiceAccountKey();
  return key.client_email;
}
