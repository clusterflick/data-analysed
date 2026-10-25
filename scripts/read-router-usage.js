// Reads the 5G router's data counters - one reading for the bandwidth log.
//
// Usage: ROUTER_USERNAME='...' ROUTER_PASSWORD='...' node scripts/read-router-usage.js
//
// Writes `row` (the reading as JSON) and `tag` (the month's release) to
// $GITHUB_OUTPUT, and the row to stdout. Only reachable from the home network,
// so it runs on a self-hosted runner.
//
// The router keeps a running total for the month and nothing finer, so a
// reading is that total at an instant. Daily usage is the difference between
// readings, worked out where the log is read (manage.clusterflick.com) rather
// than here: a missed or late reading then costs resolution, not data, and the
// counter resetting - at the start of the router's month, or when it is
// restarted - is something the reader handles once instead of every writer.
//
// The login is the one data-retrieved's restart-router.mjs makes, which is
// where the reasoning for it lives:
//   LOGIN sends password = SHA256(SHA256(password) + LD), every SHA256 in
//   upper-case hex. Reading counters is a GET, so none of the AD signing a
//   POST needs.
//
// The repository and its logs are public. Nothing from the router is printed
// beyond the counters themselves.
//
// Uses only built-in modules (Node 18+); no npm deps, so the self-hosted job
// runs without an install step.

const { createHash } = require("crypto");
const fs = require("fs");

const ROUTER = "http://192.168.254.1";

// Read in one call. `traffic_clear_date` is the day of the month the router
// resets the totals on, and `wan_auto_clear_flow_data_switch` whether it does
// at all - kept on the row so a reset that lands on an unexpected day can be
// told apart from a restart.
const FIELDS = [
  "monthly_rx_bytes",
  "monthly_tx_bytes",
  "monthly_time",
  "traffic_clear_date",
  "wan_auto_clear_flow_data_switch",
];

const sha = (s) => createHash("sha256").update(s).digest("hex").toUpperCase();

// The page starts with an empty stok cookie and the router replaces it on login.
const cookies = new Map([["stok", '""']]);

async function request(path, init = {}) {
  const response = await fetch(`${ROUTER}${path}`, {
    ...init,
    headers: {
      Referer: `${ROUTER}/`,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Router answered ${path} with ${response.status}`);
  }
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return JSON.parse(await response.text());
}

function get(cmd) {
  const query = new URLSearchParams({
    isTest: "false",
    cmd,
    ...(cmd.includes(",") && { multi_data: "1" }),
    _: Date.now(),
  });
  return request(`/goform/goform_get_cmd_process?${query}`);
}

function post(fields) {
  return request("/goform/goform_set_cmd_process", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({ isTest: "false", ...fields }),
  });
}

// Logged out, the router answers every counter with an empty string rather
// than an error, and a row of zeroes would read as the month resetting. So a
// field has to be a number to be believed.
function counter(values, field) {
  const value = values[field];
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Router gave no number for ${field}`);
  }
  return Number(value);
}

// One release per London month, tagged like llm-usage-YYYYMM.
function tagFor(date) {
  const [year, month] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  })
    .format(date)
    .split("-");
  return `bandwidth-${year}${month}`;
}

async function main() {
  const { ROUTER_USERNAME: username, ROUTER_PASSWORD: plain } = process.env;
  if (!username || !plain) {
    throw new Error("ROUTER_USERNAME and ROUTER_PASSWORD must both be set");
  }

  const { LD: ld } = await get("LD");
  const login = await post({
    goformId: "LOGIN",
    username,
    password: sha(sha(plain) + ld.toUpperCase()),
  });
  if (login.result !== "0") {
    // The result code only - the rest of the answer is the router's to keep.
    throw new Error(`Login refused (result ${login.result})`);
  }

  const values = await get(FIELDS.join(","));
  // Taken after the counters are read, not before the login: the reading is of
  // the total at this instant, and the login can take seconds.
  const at = new Date();

  const row = {
    at: at.toISOString(),
    rx: counter(values, "monthly_rx_bytes"),
    tx: counter(values, "monthly_tx_bytes"),
    connectedSeconds: counter(values, "monthly_time"),
    // Informational, so a missing one is left off rather than failing the
    // reading.
    ...(/^\d+$/.test(values.traffic_clear_date ?? "") && {
      resetDay: Number(values.traffic_clear_date),
    }),
    ...(/^[01]$/.test(values.wan_auto_clear_flow_data_switch ?? "") && {
      autoReset: values.wan_auto_clear_flow_data_switch === "1",
    }),
  };

  const line = JSON.stringify(row);
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `row=${line}\ntag=${tagFor(at)}\n`,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { tagFor };
