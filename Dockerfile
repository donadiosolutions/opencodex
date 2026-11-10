# syntax=docker/dockerfile:1.22.0@sha256:4a43a54dd1fedceb30ba47e76cfcf2b47304f4161c0caeac2db1c61804ea3c91

# Keep the runtime aligned with package.json and pin the multi-platform image index.
# Runtime 1.4.4 keeps 1.4.2's #6684 Windows Bun.fetch streaming fix and ships NSS
# 3.131.1 roots without the compromised eMudhra CAs. Runtime and test-runner
# defaults are both 1.4.4; keep package.json's testRunnerBun pin and
# setup-project-bun's role input independently validated. Promotion requires
# an exact-head cross-platform lane=all dispatch, including multi-file --isolate:
# historical 1.4.2 preload crashes (#4821; #6713 run 37631558263) and 1.4.0
# spawnSync exit loss (#4956, oven-sh/bun#44581) remain regression risks.
ARG BUN_IMAGE=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG MANIFEST_STAGE=manifest-from-git

FROM ${BUN_IMAGE} AS manifest-from-git
WORKDIR /home/bun/app

# The pinned Bun image does not include Git. Keep it confined to this build-only stage.
RUN apt-get update -qq \
  && apt-get install -qq --no-install-recommends git \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/generate-compatibility-version.ts /tmp/generate-compatibility-version.ts
COPY docker/verify-compatibility.ts /tmp/verify-compatibility.ts

# Inspect the read-only context before COPY can dereference a source symlink, and produce the
# canonical manifest for the later stages. Two supported inputs, in order:
#
#   1. A manifest the host already generated. This is the pre-existing workflow and it still
#      wins, verified rather than silently replaced, so a prepared checkout keeps building
#      byte-for-byte as before.
#   2. A clean Git context, including a remote one. The generator's canonical file list comes
#      from `git ls-files`, which reads the index and never opens an object or a ref, so the
#      context carries only .git/index and .git/HEAD. Copying them into a scratch GIT_DIR owned
#      by this stage supplies the empty objects/ and refs/ directories Git's repository check
#      requires, keeps the read-only bind mount pristine, and sidesteps the dubious-ownership
#      refusal a context-owned .git would trigger.
#
# Neither input is allowed to be missing: a placeholder manifest would defeat the identity the
# runtime check exists to prove.
RUN --mount=type=bind,target=/build-context set -eu; \
  context_manifest=/build-context/src/generated/compatibility-version.json; \
  generated=/manifest/src/generated/compatibility-version.json; \
  if [ -e "$context_manifest" ] || [ -L "$context_manifest" ]; then \
    bun /tmp/verify-compatibility.ts /build-context; \
    install -D -m 0644 "$context_manifest" "$generated"; \
  elif [ -f /build-context/.git/index ] && [ -f /build-context/.git/HEAD ]; then \
    mkdir -p /gitdir/objects /gitdir/refs; \
    cp /build-context/.git/index /build-context/.git/HEAD /gitdir/; \
    GIT_DIR=/gitdir GIT_WORK_TREE=/build-context \
      bun /tmp/generate-compatibility-version.ts /build-context "$generated"; \
    bun /tmp/verify-compatibility.ts /build-context "$generated"; \
  else \
    echo "No compatibility manifest and no Git index in the build context." >&2; \
    echo "Build from a Git context (add BUILDKIT_CONTEXT_KEEP_GIT_DIR=1 for a remote one)," >&2; \
    echo "or run: bun scripts/generate-compatibility-version.ts" >&2; \
    exit 1; \
  fi

# Signed releases prepare the compatibility manifest from the exact selected
# checkout in a read-only job. The trusted named context contains the manifest
# and verifier only; this stage never installs Git or executes selected code.
FROM scratch AS prepared
FROM ${BUN_IMAGE} AS manifest-prepared
WORKDIR /home/bun/app
COPY --from=prepared /verify-compatibility.ts /tmp/verify-compatibility.ts
COPY --from=prepared /compatibility-version.json /manifest/src/generated/compatibility-version.json
RUN --mount=type=bind,target=/build-context \
  bun /tmp/verify-compatibility.ts /build-context /manifest/src/generated/compatibility-version.json

FROM ${MANIFEST_STAGE} AS manifest

FROM ${BUN_IMAGE} AS build
WORKDIR /home/bun/app

COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun gui/package.json gui/bun.lock ./gui/
RUN cd gui && bun install --frozen-lockfile

COPY --chown=bun:bun src ./src
COPY --from=manifest --chown=bun:bun /manifest/src/generated/compatibility-version.json ./src/generated/compatibility-version.json
COPY --chown=bun:bun scripts/model-metadata.source.json ./scripts/model-metadata.source.json
COPY --chown=bun:bun docker ./docker
COPY --chown=bun:bun gui ./gui
RUN cd gui && bun run build

# BuildKit npm-compatible archive. Packaging is deliberately script-free: in
# particular, package.json's prepack hook must not execute selected source.
FROM build AS package-build
WORKDIR /home/bun/app
COPY --chown=bun:bun bin ./bin
COPY --chown=bun:bun assets/banner.png assets/architecture.png assets/claude-code-models.gif assets/codex-app-picker.png ./assets/
COPY --chown=bun:bun assets/sponsors/orcarouter.png assets/sponsors/tokenlab-light.png assets/sponsors/tokenlab-dark.png ./assets/sponsors/
COPY --chown=bun:bun README.md SPONSORS.md AGENTS_INSTALL.md LICENSE .npmignore ./
COPY --chown=bun:bun native/remote-workspace-helper/Cargo.toml native/remote-workspace-helper/Cargo.lock ./native/remote-workspace-helper/
COPY --chown=bun:bun native/remote-workspace-helper/src ./native/remote-workspace-helper/src
COPY --chown=bun:bun native/ocx-child/Cargo.toml native/ocx-child/Cargo.lock ./native/ocx-child/
COPY --chown=bun:bun native/ocx-child/src ./native/ocx-child/src
RUN mkdir -p /out \
  && chmod 0755 bin/ocx.mjs \
  && find gui/dist -type d -exec chmod 0755 {} + \
  && find gui/dist -type f -exec chmod 0644 {} + \
  && bun pm pack --ignore-scripts --filename /out/opencodex.tgz

FROM scratch AS package
COPY --from=package-build /out/opencodex.tgz /opencodex.tgz

FROM ${BUN_IMAGE} AS runtime
WORKDIR /home/bun/app
ARG SOURCE_SHA=""
ARG SOURCE_REPOSITORY=""
ARG RELEASE_TAG=""
LABEL org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.version="${RELEASE_TAG}"

# Docker supervises this foreground process; retain routed state on stop/recreate.
# This uses the existing service lifecycle mode and does not install a service manager.
ENV NODE_ENV=production \
    OCX_SERVICE=1 \
    OPENCODEX_HOME=/home/bun/.opencodex \
    CODEX_HOME=/home/bun/.codex \
    OCX_API_TOKEN_FILE=/home/bun/.opencodex/service-api-token

# These homes have incompatible auth.json formats; persist them without combining them.
RUN install -d -m 0700 -o bun -g bun /home/bun/.opencodex /home/bun/.codex
COPY --chown=bun:bun --chmod=0600 docker/config.json /home/bun/.opencodex/config.json

COPY --from=build --chown=bun:bun /home/bun/app/package.json ./package.json
COPY --from=build --chown=bun:bun /home/bun/app/bun.lock ./bun.lock
COPY --from=build --chown=bun:bun /home/bun/app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /home/bun/app/src ./src
COPY --from=build --chown=bun:bun /home/bun/app/scripts/model-metadata.source.json ./scripts/model-metadata.source.json
COPY --from=build --chown=bun:bun /home/bun/app/docker ./docker
COPY --from=build --chown=bun:bun /home/bun/app/gui/dist ./gui/dist

USER bun
RUN ["bun", "docker/verify-compatibility.ts"]
RUN ["bun", "-e", "import { readOpenCodexCompatibilityVersion } from './src/routing/compatibility/version.ts'; if (!/^[0-9a-f]{64}$/.test(readOpenCodexCompatibilityVersion() ?? '')) throw new Error('Missing or invalid generated compatibility manifest');"]
VOLUME ["/home/bun/.opencodex", "/home/bun/.codex"]
EXPOSE 10100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:10100/healthz');if(!r.ok)process.exit(1)"]

CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]
