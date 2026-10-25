// Finds public GitHub repositories that build on Clusterflick's code or
// releases, and opens an issue here for each one nobody has looked at yet.
//
// Usage: node scripts/find-data-reusers.js
//
// Env:
//   SEARCH_TOKEN - a personal token; GitHub's code search refuses Actions'
//                  own token for repositories outside this one
//   ISSUES_TOKEN - needs `issues: write` on ISSUES_REPO. Unset, the run only
//                  reports what it found and opens nothing
//   ISSUES_REPO  - where the issues go (default $GITHUB_REPOSITORY, else
//                  clusterflick/data-analysed)
//
// A repository is new when it is neither in data/known-data-reusers.json (the
// ones found by hand before this existed) nor already the subject of an issue
// here, open or closed. So closing an issue is how a find is acknowledged, and
// the list never has to be kept up to date.
//
// What this can't see, so a quiet week is not proof of no new reusers: code
// outside GitHub or in private repositories, branches other than a repo's
// default (code search only indexes those), forks (skipped unless they have
// more stars than their parent), and anyone reading clusterflick.com/datasets/
// without committing the address anywhere.
//
// Code search drops punctuation, so a search for `clusterflick/data-matched`
// also turns up files that merely mention both words. A file counts only when
// one of the fragments GitHub returns contains the address itself; the rest
// are counted in the summary as loose matches, so a change in how search
// behaves shows up there rather than as silence.
//
// Uses only the built-in fetch (Node 18+); no npm deps, so the workflow can run
// this without an `npm install` step.

const fs = require("fs");
const path = require("path");

const SEARCH_TOKEN = process.env.SEARCH_TOKEN;
const ISSUES_TOKEN = process.env.ISSUES_TOKEN;
const ISSUES_REPO =
  process.env.ISSUES_REPO ||
  process.env.GITHUB_REPOSITORY ||
  "clusterflick/data-analysed";

const OWN_ORG = "clusterflick";
const ISSUE_TITLE_PREFIX = "Data reuser: ";
const KNOWN_FILE = path.join(
  __dirname,
  "..",
  "data",
  "known-data-reusers.json",
);

// Every address a reuser has been seen to put in its code. The scripts repo is
// here because WhatsPlaying clones it for the venue records.
const NEEDLES = [
  "clusterflick/data-transformed",
  "clusterflick/data-combined",
  "clusterflick/data-matched",
  "clusterflick/data-calendar",
  "clusterflick.com/datasets",
  "clusterflick/scripts",
];

// Code search allows 10 requests a minute; one every 7s stays under it.
const SEARCH_INTERVAL_MS = 7000;
const PER_PAGE = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, token, description, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.text-match+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clusterflick-data-analysed",
      ...options.headers,
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} ${res.statusText} for ${description}: ${await res.text()}`,
    );
  }

  return res.json();
}

async function searchCode(needle) {
  const items = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      q: `"${needle}"`,
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const body = await request(
      `https://api.github.com/search/code?${query}`,
      SEARCH_TOKEN,
      `code search for ${needle} (page ${page})`,
    );
    // Results are capped, and a partial list would read as a quiet week.
    if (body.incomplete_results) {
      throw new Error(`Code search for ${needle} returned incomplete results`);
    }
    items.push(...body.items);
    await sleep(SEARCH_INTERVAL_MS);
    if (items.length >= body.total_count || body.items.length < PER_PAGE) {
      return items;
    }
  }
}

function containsNeedle(item, needle) {
  return (item.text_matches || []).some((match) =>
    match.fragment.toLowerCase().includes(needle.toLowerCase()),
  );
}

// Repository full name -> { needle -> [file urls] }
async function findReusers() {
  const reusers = new Map();
  let loose = 0;

  for (const needle of NEEDLES) {
    const items = await searchCode(needle);
    for (const item of items) {
      const repo = item.repository;
      if (repo.owner.login.toLowerCase() === OWN_ORG) continue;
      if (!containsNeedle(item, needle)) {
        loose++;
        continue;
      }
      const files = reusers.get(repo.full_name) || {};
      files[needle] = [...(files[needle] || []), item.html_url];
      reusers.set(repo.full_name, files);
    }
    console.log(`${needle}: ${items.length} file(s)`);
  }

  return { reusers, loose };
}

async function fetchReportedRepos() {
  const reported = new Set();
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      state: "all",
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const issues = await request(
      `https://api.github.com/repos/${ISSUES_REPO}/issues?${query}`,
      ISSUES_TOKEN,
      `${ISSUES_REPO} issues (page ${page})`,
    );
    for (const issue of issues) {
      if (issue.title.startsWith(ISSUE_TITLE_PREFIX)) {
        reported.add(
          issue.title.slice(ISSUE_TITLE_PREFIX.length).trim().toLowerCase(),
        );
      }
    }
    if (issues.length < PER_PAGE) return reported;
  }
}

function issueBody(repo, files) {
  const lines = [
    `https://github.com/${repo} refers to Clusterflick in its code:`,
    "",
  ];
  for (const [needle, urls] of Object.entries(files)) {
    lines.push(`- \`${needle}\``);
    for (const url of urls) lines.push(`  - ${url}`);
  }
  lines.push(
    "",
    "Worth a look: which files it reads, which venues it uses, whether it credits Clusterflick, and whether it has a site to link from the About page.",
    "",
    "Close this once it has been looked at - a closed issue keeps the repository from being reported again.",
  );
  return lines.join("\n");
}

async function openIssue(repo, files) {
  const issue = await request(
    `https://api.github.com/repos/${ISSUES_REPO}/issues`,
    ISSUES_TOKEN,
    `opening an issue for ${repo}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${ISSUE_TITLE_PREFIX}${repo}`,
        body: issueBody(repo, files),
      }),
    },
  );
  return issue.html_url;
}

function summarise(lines) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

async function main() {
  if (!SEARCH_TOKEN) {
    throw new Error(
      "SEARCH_TOKEN is required: code search needs a personal token",
    );
  }

  const known = new Set(
    Object.keys(JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"))).map((repo) =>
      repo.toLowerCase(),
    ),
  );
  const { reusers, loose } = await findReusers();
  const reported = ISSUES_TOKEN ? await fetchReportedRepos() : new Set();

  const found = [...reusers.keys()].sort((a, b) => a.localeCompare(b));
  const fresh = found.filter(
    (repo) =>
      !known.has(repo.toLowerCase()) && !reported.has(repo.toLowerCase()),
  );

  const lines = [
    "## Data reusers",
    "",
    `${found.length} repositories refer to Clusterflick; ${fresh.length} new. ${loose} loose match(es) skipped.`,
    "",
  ];
  for (const repo of found) {
    const status = fresh.includes(repo) ? "**new**" : "known";
    lines.push(`- ${status}: [${repo}](https://github.com/${repo})`);
  }

  for (const repo of fresh) {
    if (!ISSUES_TOKEN) continue;
    const url = await openIssue(repo, reusers.get(repo));
    lines.push("", `Opened ${url}`);
  }
  if (fresh.length > 0 && !ISSUES_TOKEN) {
    lines.push("", "ISSUES_TOKEN is unset, so no issues were opened.");
  }

  summarise(lines);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
