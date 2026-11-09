#!/usr/bin/env bash
# Reads and writes a log that lives as a release asset and is appended to in
# place - venue-health's day log and llm-usage's month log.
#
#   scripts/rolling-log.sh locate         <tag> <asset>   (writes step outputs)
#   scripts/rolling-log.sh download       <tag> <name> <file>
#   scripts/rolling-log.sh ensure-release <tag>           (body from $NOTES)
#   scripts/rolling-log.sh publish        <tag> <asset> <file>
#
# Needs GH_TOKEN with `contents: write` for ensure-release and publish, and
# GITHUB_REPOSITORY.
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
# Only ensure-release takes no asset; the others check for one.
asset=${3:-}

stem=${asset%.*}
ext=${asset##*.}
# `<stem>.staged-<run id>.<ext>`: the run id makes concurrent or leftover copies
# distinct, and sorts them so the newest staged copy is the longest log.
staged_glob="${stem}.staged-"
staged_name="${stem}.staged-${GITHUB_RUN_ID:-local}.${ext}"

# Every GitHub call here is retried with backoff when the failure looks
# transient: a 5xx, a 408 or 429, a request that hung past REQUEST_TIMEOUT, or
# no HTTP status at all (a dropped connection). Any other 4xx is an answer, not
# an outage, and fails straight away - `locate` depends on a 404 coming back as
# a 404.
#
# The waits are minutes, not seconds, because the errors come in spells. On 8
# and 9 Nov the release download URL answered 504 for 3 to 26 minutes at a time
# while the API kept answering; release-downloader's three tries 30s apart
# spent about a minute, and each spell cost a cycle until it was re-run by
# hand. Five attempts over about five minutes outlasts the shorter spells, and
# the longer ones are left to re-run-failed-logs.yml rather than held open
# here. The request timeout matters as much: on 8 Nov 12:00 each 504 took two
# minutes to arrive, and a healthy download of the largest log takes seconds.
RETRY_WAITS=${ROLLING_LOG_RETRY_WAITS:-"20 40 80 160"}
REQUEST_TIMEOUT=${ROLLING_LOG_REQUEST_TIMEOUT:-60}

gh_() {
  timeout "$REQUEST_TIMEOUT" gh "$@"
}

is_transient() {
  local status=$1 err=$2
  [ "$status" -eq 124 ] && return 0
  grep -qE "HTTP (5[0-9]{2}|408|429)" "$err" && return 0
  grep -qE "HTTP [0-9]{3}" "$err" && return 1
  return 0
}

# `set -e` does not apply inside a command run this way, so a function passed
# here returns on its own errors.
#
# Runs "$@" until it succeeds or fails for good. Its stdout is passed on only
# from the attempt that succeeded, so a failed attempt's error body is never
# mistaken for output; its stderr is passed on only from the last attempt.
retrying() {
  local out err status wait
  out=$(mktemp)
  err=$(mktemp)
  for wait in $RETRY_WAITS ""; do
    status=0
    "$@" > "$out" 2> "$err" || status=$?
    if [ "$status" -eq 0 ]; then
      cat "$out"
      rm -f "$out" "$err"
      return 0
    fi
    if [ -z "$wait" ] || ! is_transient "$status" "$err"; then
      cat "$err" >&2
      rm -f "$out" "$err"
      return "$status"
    fi
    local reason
    reason=$(tr '\n' ' ' < "$err" | head -c 200)
    echo "::warning::$(printf "%s " "${@:1:3}")failed (${reason:-exit $status}) - retrying in ${wait}s" >&2
    sleep "$wait"
  done
}

output() {
  echo "$1" >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

release_assets() {
  retrying gh_ api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
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
      output "release=false"
      return
    fi
    cat "${RUNNER_TEMP:-/tmp}/gh-error" >&2
    exit 1
  fi
  output "release=true"

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

# Through the API's asset endpoint rather than the release download URL that
# release-downloader uses: in every 504 spell so far the download URL failed
# while the API listed the same release in the step before. The size is checked
# against the listing, so a body cut short is retried rather than appended to.
download_asset() {
  local id=$1 size=$2 file=$3
  gh_ api -H "Accept: application/octet-stream" \
    "repos/$GITHUB_REPOSITORY/releases/assets/$id" > "$file.part" || return
  local actual
  actual=$(wc -c < "$file.part")
  if [ "$actual" -ne "$size" ]; then
    echo "Downloaded $actual bytes of $size" >&2
    rm -f "$file.part"
    return 1
  fi
  mv "$file.part" "$file"
}

download() {
  local name=$3
  local file=${4:?missing file}
  local listing id size
  listing=$(retrying gh_ api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
    --jq ".assets[] | select(.name == \"$name\") | [.id, .size] | @tsv")
  read -r id size <<< "$listing"
  if [ -z "$id" ]; then
    echo "Release $tag has no $name" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$file")"
  retrying download_asset "$id" "$size" "$file"
  echo "Downloaded $name ($size bytes) to $file"
}

# A create whose response was lost may still have gone through, so each attempt
# checks first; otherwise a retry would fail on the release already existing.
create_release() {
  if gh_ api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" > /dev/null 2>&1; then
    return 0
  fi
  gh_ release create "$tag" --repo "$GITHUB_REPOSITORY" \
    --target main --latest=false --title "$tag" --notes "$NOTES"
}

# Creates the release on the first cycle of its day or month and does nothing
# after that. The release action used to run every cycle to update a body that
# never changes, and was one more call to fail: it got a 500 on 4 Nov and 9 Nov
# and took the cycle with it.
ensure_release() {
  : "${NOTES:?missing NOTES for the release body}"
  if retrying gh_ api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" > /dev/null 2> "${RUNNER_TEMP:-/tmp}/gh-error"; then
    return
  fi
  if ! grep -q "HTTP 404" "${RUNNER_TEMP:-/tmp}/gh-error"; then
    cat "${RUNNER_TEMP:-/tmp}/gh-error" >&2
    exit 1
  fi
  retrying create_release
  echo "Created release $tag"
}

# A delete whose response was lost is retried into a 404, which means it went
# through the first time.
delete_asset() {
  local err
  err=$(mktemp)
  if gh_ api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$1" 2> "$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -q "HTTP 404" "$err"; then
    rm -f "$err"
    return 0
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

publish() {
  local file=${4:?missing file}
  local dir
  dir=$(mktemp -d)
  cp "$file" "$dir/$staged_name"

  # Fails the job with the old log untouched - a lost cycle, not a lost log.
  # `--clobber` replaces a staged copy of this run's own name, which is only
  # left by an earlier attempt of this same run, or of this upload, and is
  # stale either way.
  retrying gh_ release upload "$tag" "$dir/$staged_name" --repo "$GITHUB_REPOSITORY" --clobber

  local new_id
  new_id=$(asset_id "$staged_name")
  if [ -z "$new_id" ]; then
    echo "Uploaded $staged_name but the release does not list it" >&2
    exit 1
  fi

  local id
  for id in $(asset_id "$asset"); do
    retrying delete_asset "$id"
  done
  retrying gh_ api -X PATCH "repos/$GITHUB_REPOSITORY/releases/assets/$new_id" \
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
        retrying delete_asset "$id"
        ;;
    esac
  done < <(release_assets)

  echo "Published $asset to $tag"
}

case "$command" in
  locate | download | publish)
    : "${asset:?missing asset name}"
    "$command" "$@"
    ;;
  ensure-release) ensure_release ;;
  *)
    echo "Unknown command: $command" >&2
    exit 1
    ;;
esac
