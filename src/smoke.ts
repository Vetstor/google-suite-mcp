import "dotenv/config";
import { getServiceAccountEmail, getDriveClient } from "./auth.js";

async function main() {
  try {
    const email = getServiceAccountEmail();
    console.log("Service account email:", email);

    console.log("\nCalling Drive files.list (pageSize=5)...");
    const drive = getDriveClient();
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      pageSize: 5,
      fields: "files(id,name,modifiedTime)",
    });

    const files = res.data.files ?? [];
    if (files.length === 0) {
      console.log("No spreadsheets found (or none shared with this SA).");
    } else {
      console.log(`Found ${files.length} spreadsheet(s):`);
      for (const f of files) {
        console.log(` - ${f.name} (${f.id})`);
      }
    }
  } catch (err) {
    console.error("Smoke test failed:", (err as Error).message);
    process.exit(1);
  }
}

await main();
