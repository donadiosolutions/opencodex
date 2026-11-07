#!/usr/bin/env bash
set -euo pipefail

kind=${1:?expected bun, buildx, syft, or cosign}
tool_dir="${RUNNER_TEMP:?}/bcdn-image-tools"
mkdir -p "$tool_dir"

case "$kind" in
  bun)
    archive="$tool_dir/bun.zip"
    curl -fsSL --retry 3 -o "$archive" https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip
    printf '%s  %s\n' 'bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c' "$archive" | sha256sum -c -
    unzip -q "$archive" 'bun-linux-x64/bun' -d "$tool_dir"
    install -m 0755 "$tool_dir/bun-linux-x64/bun" "$tool_dir/bun"
    printf '%s\n' "$tool_dir" >> "$GITHUB_PATH"
    "$tool_dir/bun" --version
    ;;
  buildx)
    file="$tool_dir/docker-buildx"
    curl -fsSL --retry 3 -o "$file" https://github.com/docker/buildx/releases/download/v0.38.2/buildx-v0.38.2.linux-amd64
    printf '%s  %s\n' '7992ec09413b80ff57ba4e081f56fc833d7bac1d5e71143c6c809e7e6065f6d6' "$file" | sha256sum -c -
    install -D -m 0755 "$file" "$HOME/.docker/cli-plugins/docker-buildx"
    docker buildx version
    ;;
  syft)
    archive="$tool_dir/syft.tar.gz"
    curl -fsSL --retry 3 -o "$archive" https://github.com/anchore/syft/releases/download/v1.57.0/syft_1.57.0_linux_amd64.tar.gz
    printf '%s  %s\n' '9c077a7d43029b3b13e98a8db720661e700c4d58db6352153a06395ae4a2a704' "$archive" | sha256sum -c -
    tar -xzf "$archive" -C "$tool_dir" syft
    chmod 0755 "$tool_dir/syft"
    printf '%s\n' "$tool_dir" >> "$GITHUB_PATH"
    "$tool_dir/syft" version
    ;;
  cosign)
    file="$tool_dir/cosign"
    curl -fsSL --retry 3 -o "$file" https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64
    printf '%s  %s\n' '424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa' "$file" | sha256sum -c -
    chmod 0755 "$file"
    printf '%s\n' "$tool_dir" >> "$GITHUB_PATH"
    "$file" version
    ;;
  *)
    printf 'unknown tool: %s\n' "$kind" >&2
    exit 2
    ;;
esac
