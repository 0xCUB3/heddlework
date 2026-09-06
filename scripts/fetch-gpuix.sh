#!/usr/bin/env bash
# Downloads the prebuilt patched GPUix tarballs that package.json points at from the fork's GitHub release and
# verifies them against vendor/gpuix/SHA256SUMS. Rebuild them from source with scripts/build-gpuix.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/vendor/gpuix"
repo="${GPUIX_RELEASE_REPO:-0xCUB3/heddlework}"
build_version="${GPUIX_BUILD_VERSION:-0.7.0-heddlework.3}"
tag="gpuix-$build_version"
base="https://github.com/$repo/releases/download/$tag"

mkdir -p "$out"
for name in "gpuix-native-$build_version.tgz" "gpuix-react-$build_version.tgz"; do
  if [ -f "$out/$name" ]; then
    echo "[gpuix] $name present"
  else
    echo "[gpuix] downloading $name"
    curl -fsSL --retry 3 -o "$out/$name" "$base/$name"
  fi
done

# Windows runners lack shasum; sha256sum from Git for Windows accepts the same file format.
if command -v shasum >/dev/null; then
  (cd "$root" && shasum -a 256 -c vendor/gpuix/SHA256SUMS)
else
  (cd "$root" && sha256sum -c vendor/gpuix/SHA256SUMS)
fi
