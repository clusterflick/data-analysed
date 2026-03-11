require("dotenv").config();

const https = require("https");

const REPOS = ["data-retrieved", "data-transformed", "data-combined"];

const PAT = process.env.PAT;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "clusterflick-data-analysed",
        ...(PAT ? { Authorization: `token ${PAT}` } : {}),
      },
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response from ${url}: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTag(tag) {
  const match = tag.match(/^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})$/);
  if (!match) return tag;
  const [, y, m, d, hh, mm] = match;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${tag}  (${d} ${months[parseInt(m, 10) - 1]} ${y} ${hh}:${mm})`;
}

async function getLatestRelease(repo) {
  const url = `https://api.github.com/repos/clusterflick/${repo}/releases/latest`;
  const release = await fetchJson(url);

  if (release.message) {
    throw new Error(`GitHub API error for ${repo}: ${release.message}`);
  }

  const assets = (release.assets || []).map((a) => ({
    name: a.name,
    size: a.size,
  }));

  const totalSize = assets.reduce((sum, a) => sum + a.size, 0);

  return { tag: release.tag_name, assets, totalSize };
}

async function main() {
  const results = await Promise.all(
    REPOS.map(async (repo) => {
      try {
        const data = await getLatestRelease(repo);
        return { repo, ...data };
      } catch (e) {
        return { repo, error: e.message };
      }
    })
  );

  const maxRepoLen = Math.max(...REPOS.map((r) => r.length));

  for (const result of results) {
    const label = result.repo.padEnd(maxRepoLen);

    if (result.error) {
      console.log(`${label}  ERROR: ${result.error}`);
      continue;
    }

    console.log(`${label}  ${formatTag(result.tag)}`);
    console.log(`${"".padEnd(maxRepoLen)}  Total: ${formatSize(result.totalSize)} across ${result.assets.length} asset(s)`);

    for (const asset of result.assets) {
      console.log(`${"".padEnd(maxRepoLen)}    - ${asset.name}: ${formatSize(asset.size)}`);
    }

    console.log();
  }
}

main();
