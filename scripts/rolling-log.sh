#!/usr/bin/env bash
# Reads and writes a log that lives as a release asset and is appended to in
# place - venue-health's day log and llm-usage's month log.
#
#   scripts/rolling-log.sh locate  <tag> <asset>          (writes step outputs)
#   scripts/rolling-log.sh publish <tag> <asset> <file>
#
# Needs GH_TOKEN with `contents: write` for publish, and GITHUB_REPOSITORY.
#
# Why not `ncipollo/release-action` with `replacesArtifacts`: it deletes the
# existing asset and then uploads its replacement, so an upload that fails in
# between leaves the release with no log at all. On 12 Oct that upload got a 500
# at 13:00Z, the 14:00Z cycle found no asset, took it for the day's first cycle
# and started over - fifteen cycles gone. Here the replacement is uploaded under
# a staging name first and only renamed into place once it is there, so a failed
# upload costs this cycle, never the ones before it.
#
# A run can still die between deleting the old asset and renaming the new one.
# That leaves only the staged copy, which already holds every earlier cycle plus
# that run's, so `locate` picks it up rather than starting the log again.

set -euo pipefail

command=${1:?usage: rolling-log.sh <locate|publish> <tag> <asset> [file]}
tag=${2:?missing tag}
asset=${3:?missing asset name}

stem=${asset%.*}
ext=${asset##*.}
# `<stem>.staged-<run id>.<ext>`: the run id makes concurrent or leftover copies
# distinct, and sorts them so the newest staged copy is the longest log.
staged_glob="${stem}.staged-"
staged_name="${stem}.staged-${GITHUB_RUN_ID:-local}.${ext}"

output() {
  echo "$1" >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

release_assets() {
  gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
    --jq '.assets[] | [.id, .name] | @tsv'
}

locate() {
  # "Absent" has to be established, not inferred from a failed request: on
  # 23 Sep a transient 404 fetching an asset that existed read as "first
  # cycle". Only a release that is genuinely missing starts a new log; any
  # other error fails the job and leaves the log as it was.
  local assets
  if ! assets=$(release_assets 2> "${RUNNER_TEMP:-/tmp}/gh-error"); then
    if grep -q "HTTP 404" "${RUNNER_TEMP:-/tmp}/gh-error"; then
      echo "No release $tag yet - starting the log"
      output "exists=false"
      return
    fi
    cat "${RUNNER_TEMP:-/tmp}/gh-error" >&2
    exit 1
  fi

  if cut -f2 <<< "$assets" | grep -qxF "$asset"; then
    output "exists=true"
    output "name=$asset"
    return
  fi

  local recovered
  recovered=$(cut -f2 <<< "$assets" | grep -F "$staged_glob" | grep -E "\.${ext}\$" | sort -V | tail -n 1 || true)
  if [ -n "$recovered" ]; then
    echo "::warning::Release $tag has no $asset but has $recovered from a publish that did not finish - continuing from it"
    output "exists=true"
    output "name=$recovered"
    return
  fi

  # A release with no log at all only happens when the very first publish
  # created the release and then failed to upload - nothing earlier to lose.
  echo "::warning::Release $tag has no $asset - starting the log"
  output "exists=false"
}

asset_id() {
  release_assets | awk -F '\t' -v name="$1" '$2 == name { print $1 }'
}

publish() {
  local file=${4:?missing file}
  local dir
  dir=$(mktemp -d)
  cp "$file" "$dir/$staged_name"

  # A staged copy of this run's own name is only left by an earlier attempt of
  # this same run; it is stale, and would make the upload below collide.
  local id
  for id in $(asset_id "$staged_name"); do
    gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$id"
  done

  # Fails the job with the old log untouched - a lost cycle, not a lost log.
  gh release upload "$tag" "$dir/$staged_name" --repo "$GITHUB_REPOSITORY"

  local new_id
  new_id=$(asset_id "$staged_name")
  if [ -z "$new_id" ]; then
    echo "Uploaded $staged_name but the release does not list it" >&2
    exit 1
  fi

  for id in $(asset_id "$asset"); do
    gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$id"
  done
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/releases/assets/$new_id" \
    -f name="$asset" > /dev/null

  # Leftovers from earlier runs that uploaded but never renamed. Either this
  # run continued from one of them, or the log it would have replaced was still
  # in place and this run continued from that - at most the leftover's own
  # cycle, which its run already failed on, is not in what was just published.
  local name
  while IFS=$'\t' read -r id name; do
    case "$name" in
      "$staged_glob"*".$ext")
        echo "Removing leftover $name"
        gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$id"
        ;;
    esac
  done < <(release_assets)

  echo "Published $asset to $tag"
}

case "$command" in
  locate) locate ;;
  publish) publish "$@" ;;
  *)
    echo "Unknown command: $command" >&2
    exit 1
    ;;
esac
