const fs = require("fs");
const path = require("path");

const API_URL =
  "https://europe-west2-cinema-viewer1.cloudfunctions.net/api/getScreenings";

const VENUES = [
  "bfi-southbank",
  "rich-mix-shoreditch",
  "the-garden-cinema",
  "odeon-london-leicester-square",
  "odeon-london-west-end",
  "vue-london-west-end-leicester-square",
  "prince-charles-cinema-london",
  "curzon-soho",
  "odeon-london-haymarket",
  "cineworld-london-leicester-square",
  "picture-house-shaftesbury-avenue",
  "vue-london-piccadilly-circus",
  "the-nickel-london",
  "odeon-london-tottenham-court-road",
  "curzon-bloomsbury",
  "barbican-cinema",
  "regent-street-cinema",
  "curzon-victoria",
  "everyman-borough-yards",
  "curzon-mayfair",
  "everyman-broadgate",
  "vue-london-islington-angel-central",
  "everyman-baker-street",
  "everyman-kings-cross",
  "everyman-screen-on-the-green",
  "curzon-hoxton",
  "odeon-islington",
  "curzon-aldgate",
  "close-up-film-centre-shoreditch",
  "odeon-camden",
  "curzon-camden",
  "genesis-cinema-stepney-green",
  "everyman-chelsea",
  "everyman-maida-vale",
  "everyman-the-whiteley",
  "rio-cinema-dalston",
  "odeon-swiss-cottage",
  "odeon-holloway",
  "picture-house-brixton",
  "everyman-belsize-park",
  "picture-house-notting-hill",
  "picture-house-clapham",
  "peckhamplex",
  "picture-house-hackney",
  "vue-london-finchley-road-02-centre",
  "electric-cinema-notting-hill",
  "picture-house-finsbury-park",
  "vue-london-fulham-broadway",
  "cineworld-london-west-india-quay",
  "everyman-hampstead",
  "picture-house-east-dulwich",
  "the-castle-cinema-hackney",
  "everyman-canary-wharf",
  "vue-london-shepherds-bush",
  "vue-london-westfield-shepherds-bush",
  "electric-cinema-white-city",
  "the-lexi-cinema",
  "picture-house-crouch-end",
  "arthouse-cinema-crouch-end",
  "cineworld-london-wandsworth",
  "everyman-stratford-international",
  "picture-house-greenwich",
  "cineworld-london-the-o2-greenwich",
  "vue-london-westfield-stratford",
  "odeon-putney",
  "picture-house-west-norwood",
  "odeon-streatham",
  "everyman-muswell-hill",
  "phoenix-cinema-finchley",
  "odeon-greenwich",
  "cineworld-london-wood-green",
  "chiswick-cinema",
  "olympic-cinema-barnes",
  "forest-cinema-walthamstow",
];

async function main() {
  console.log(`Fetching screenings for ${VENUES.length} venues...`);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
      Accept: "*/*",
      "Accept-Language": "en-GB,en;q=0.9",
      Referer: "https://cinemaguide.co.uk/",
      "Content-Type": "application/json",
      Origin: "https://cinemaguide.co.uk",
    },
    body: JSON.stringify({
      venues: VENUES,
      page: "london",
      initial_view: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const output = {
    metadata: {
      fetchedAt: new Date().toISOString(),
      venueCount: VENUES.length,
    },
    data,
  };

  const outputDir = path.join(__dirname, "..", "cinemaguide-data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "cinemaguide-data.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Data saved to ${outputPath}`);
  console.log(`Response type: ${typeof data}`);
  if (Array.isArray(data)) {
    console.log(`Array with ${data.length} entries`);
    if (data.length > 0) {
      console.log(`First entry keys: ${Object.keys(data[0]).join(", ")}`);
    }
  } else if (data && typeof data === "object") {
    console.log(`Object keys: ${Object.keys(data).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
