# Verify this release

Use the package's existing registry access model. Authenticate to GHCR before
pulling if your account requires it. Verification needs Cosign 3.1.4, GitHub CLI
with artifact attestation support, jq, sha256sum, and sha512sum.

Set `RELEASE_TAG` to the release you intended to download and `WORKFLOW_SHA` to
the full workflow commit from its trusted GitHub Actions run. Obtain these
expected values independently of the downloaded assets. Then, from those assets:

```bash
set -euo pipefail
REPO=donadiosolutions/opencodex
: "${RELEASE_TAG:?Set the expected release tag}"
: "${WORKFLOW_SHA:?Set the expected workflow commit}"
IDENTITY="https://github.com/$REPO/.github/workflows/bcdn-image.yml@refs/heads/custom"
ISSUER=https://token.actions.githubusercontent.com
cosign verify-blob --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" --bundle SHA256SUMS.sigstore.json SHA256SUMS
sha256sum -c SHA256SUMS
cosign verify-blob --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" --bundle release-manifest.sigstore.json release-manifest.json
jq -e --arg repo "$REPO" --arg tag "$RELEASE_TAG" --arg workflow "$WORKFLOW_SHA" \
  '.schema_version == 2 and .repository == $repo and .release_tag == $tag and .workflow_sha == $workflow and .package_filename == ("opencodex-" + $tag + ".tgz") and .package_name == "@bitkyc08/opencodex" and .upstream_tag == ("v" + .package_version)' release-manifest.json
PACKAGE=$(jq -er .package_filename release-manifest.json)
test "$(sha256sum "$PACKAGE" | cut -d' ' -f1)" = "$(jq -er .package_sha256 release-manifest.json)"
test "$(sha512sum "$PACKAGE" | cut -d' ' -f1)" = "$(jq -er .package_sha512 release-manifest.json)"
cosign verify-blob --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" --bundle package.sigstore.json "$PACKAGE"
gh attestation verify "$PACKAGE" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/bcdn-image.yml" --signer-digest "$WORKFLOW_SHA" --predicate-type "https://github.com/$REPO/attestations/bcdn-release/v1"
gh attestation verify "$PACKAGE" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/bcdn-image.yml" --signer-digest "$WORKFLOW_SHA" --predicate-type https://slsa.dev/provenance/v1
DIGEST=$(jq -er .image_digest release-manifest.json)
IMAGE="ghcr.io/$REPO@$DIGEST"
cosign verify --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" "$IMAGE"
gh attestation verify "oci://$IMAGE" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/bcdn-image.yml" --signer-digest "$WORKFLOW_SHA" --predicate-type "https://github.com/$REPO/attestations/bcdn-release/v1"
gh attestation verify "oci://$IMAGE" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/bcdn-image.yml" --signer-digest "$WORKFLOW_SHA" --predicate-type https://slsa.dev/provenance/v1
gh attestation verify "oci://$IMAGE" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/bcdn-image.yml" --signer-digest "$WORKFLOW_SHA" --predicate-type https://spdx.dev/Document
```

The certificate identity names the reusable workflow on the dispatch branch,
`custom`; it does not name the selected source branch. If the fork's default
branch changes, use that dispatch branch in the exact identity above.

Compare both verified release predicates with `release-manifest.json`: repository,
run ID, source branch/SHA, upstream tag/SHA, workflow SHA, release tag, image
digest and package hashes must agree. The workflow SHA identifies trusted build
tooling; the selected source SHA identifies the code built into the package and
image. The package's GitHub SLSA provenance identifies the workflow revision,
which can differ from the selected source. Its signed release predicate binds
the package digest to that source SHA; `package-build-metadata.json` records
the selected Git material and maximum-level BuildKit definition.
The image's selected source SHA is separately present in
`buildkit-provenance.json`'s Git material.
That maximum-level BuildKit statement and `buildkit-sbom.spdx.json` are bound to
the linux/amd64 platform manifest inside the signed image index.

`runtime.spdx.json` and `runtime.cyclonedx.json` cover the runtime image's OS and
application packages. `build-dependencies.*.json` inventory the separate build
stage, including the dashboard toolchain. Signed `SHA256SUMS` covers the package
tarball and evidence files; its own bundle and the independently verified
manifest and package signature bundles are outside that checksum list.
`package-inventory.json` records the packaged file set and
`package-binding-verification.json` records the verified release predicate.
Use the immutable image digest for independent inspection.

After verification, install the downloaded tarball. Installation may fetch its
runtime dependencies, but the release does not publish the package to npm:

```bash
npm install -g "./$PACKAGE"
# or: pnpm add -g "./$PACKAGE"
```
