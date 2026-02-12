set -a
source .env
set +a

REPO_URL='https://api.github.com/repos/clusterflick/data-transformed/releases'
CURL_HEADERS=(-sS -L -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
if [ -n "${PAT:-}" ]; then
    CURL_HEADERS+=(-H "Authorization: token $PAT")
fi

RELEASES=$(curl "${CURL_HEADERS[@]}" "$REPO_URL?per_page=2")

CURRENT_TAG=$(echo "$RELEASES" | jq -r '.[0].tag_name')
PREVIOUS_TAG=$(echo "$RELEASES" | jq -r '.[1].tag_name')

echo "Current:  $CURRENT_TAG"
echo "Previous: $PREVIOUS_TAG"

for TAG in "$CURRENT_TAG" "$PREVIOUS_TAG"; do
    if [ "$TAG" = "$CURRENT_TAG" ]; then LABEL="current"; else LABEL="previous"; fi
    DIR="./transformed-data/$LABEL"
    mkdir -p "$DIR"

    RELEASE=$(curl "${CURL_HEADERS[@]}" "$REPO_URL/tags/$TAG")

    echo ""
    echo "Downloading $LABEL release ($TAG)..."
    for f in $(echo "$RELEASE" | grep browser_download | cut -d\" -f4); do
        echo "  Getting $f ..."
        wget "$f" --quiet -P "$DIR/"
    done
done

echo ""
echo "Done. Run the comparison with:"
echo "  npm run compare:releases -- ./transformed-data/current ./transformed-data/previous $CURRENT_TAG $PREVIOUS_TAG"
