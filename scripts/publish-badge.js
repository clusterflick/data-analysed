// Publishes a badge JSON file (written by common/badge.js into output/) to the
// shared gist that the README shields.io endpoint badges read from.
//
// Usage:   node scripts/publish-badge.js <filename>
// Example: node scripts/publish-badge.js compare-accessible-screenings.json
//
// <filename> is used both as the local file under output/ and as the target
// file name within the gist (they're kept identical on purpose).
//
// Env:
//   GIST_ID     — the gist to update
//   GIST_TOKEN  — a classic PAT with `gist` scope (personal, not the org PAT:
//                 gists are always user-owned, so this can't be an org token)
//
// Uses only the built-in fetch (Node 18+); no npm deps, and no dependency on the
// `gh` CLI being installed on the (self-hosted) runner.

const fs = require("fs");
const path = require("path");

const filename = process.argv[2];
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;

async function main() {
  if (!filename) {
    throw new Error("Usage: publish-badge.js <filename>");
  }
  if (!GIST_ID) throw new Error("GIST_ID is not set");
  if (!GIST_TOKEN) throw new Error("GIST_TOKEN is not set");

  const localPath = path.join(__dirname, "..", "output", filename);
  if (!fs.existsSync(localPath)) {
    throw new Error(`Badge file not found: ${localPath}`);
  }
  const content = fs.readFileSync(localPath, "utf8");

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clusterflick-data-analysed",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: { [filename]: { content } } }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Gist update failed: ${res.status} ${res.statusText} — ${body}`,
    );
  }

  console.log(`Published ${filename} to gist ${GIST_ID}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
