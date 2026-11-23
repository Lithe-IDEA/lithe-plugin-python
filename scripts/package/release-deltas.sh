#!/usr/bin/env bash
# Packages optional patches from the newest Store-listed release per platform.
set -euo pipefail

if [[ $# -ne 3 ]]; then
    printf 'usage: %s STORE_INDEX ZIP_DIRECTORY TARGET_VERSION\n' "$0" >&2
    exit 2
fi
index=$1
dist=$2
version=$3
plugin_id=io.github.lithe-idea.python-support
max_zip=67108864
version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$version" =~ $version_pattern ]]

scratch=$(mktemp -d)
trap 'python3 -c "import shutil, sys; shutil.rmtree(sys.argv[1])" "$scratch"' EXIT

shopt -s nullglob
for target in "$dist"/python-support-"$version"-*.zip; do
    platform=${target##*/python-support-"$version"-}
    platform=${platform%.zip}
    [[ "$platform" =~ ^(darwin|linux|windows)-(arm64|x64)$ ]] || continue
    size=$(wc -c < "$target")
    (( size > 0 && size <= max_zip )) || continue

    # The index is already ordered newest first. Compare the numeric parts to
    # ignore a concurrent newer release and release reruns.
    base=$(jq -r --arg id "$plugin_id" --arg platform "$platform" --arg target "$version" '
      def semver: split(".") | map(tonumber);
      first(
        .plugins[] | select(.id == $id) | .versions[]
        | select((.version | semver) < ($target | semver))
        | .version as $version
        | .downloads[] | select(.platforms | index($platform))
        | [$version, .downloadURL, .sha256] | @tsv
      ) // empty
    ' "$index")
    [[ -n "$base" ]] || continue
    IFS=$'\t' read -r previous url digest <<< "$base"
    if [[ ! "$previous" =~ $version_pattern ||
          ! "$url" =~ ^https://github\.com/Lithe-IDEA/lithe-plugin-python/releases/download/[^/]+/[^/]+\.zip$ ||
          ! "$digest" =~ ^[a-f0-9]{64}$ ]]; then
        printf 'Skipping delta for %s: invalid Store archive identity.\n' "$platform" >&2
        continue
    fi
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --max-time 25 --max-filesize "$max_zip" -o "$scratch/base.zip" "$url" ||
        ! actual=$(sha256sum "$scratch/base.zip") || [[ "${actual%% *}" != "$digest" ]]; then
        printf 'Skipping delta for %s: Store base could not be verified.\n' "$platform" >&2
        continue
    fi

    patch="$scratch/patch.zst"
    if ! zstd -f -q -M128MB --patch-from="$scratch/base.zip" -o "$patch" -- "$target"; then
        printf 'Skipping delta for %s: compression failed.\n' "$platform" >&2
        continue
    fi
    (( $(wc -c < "$patch") <= size * 3 / 4 )) || continue
    if ! zstd -q -dc -M128MB --patch-from="$scratch/base.zip" -- "$patch" | cmp -s "$target" -; then
        printf 'Skipping delta for %s: reconstruction did not match target.\n' "$platform" >&2
        continue
    fi
    mv "$patch" "${target%.zip}.from-$previous.zip.zst"
done
