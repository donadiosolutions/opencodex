# Verify this release

Use the package's existing registry access model. Authenticate to GHCR before
pulling if your account requires it. Verification needs Cosign 3.1.4, GitHub CLI
with artifact attestation support, jq, and sha256sum.

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
  '.repository == $repo and .release_tag == $tag and .workflow_sha == $workflow' release-manifest.json
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

Compare the verified release predicate with `release-manifest.json`: repository,
run ID, source branch/SHA, upstream tag/SHA, workflow SHA, release tag and digest
must all agree. The workflow SHA identifies trusted build tooling; the selected
source SHA is separately present in `buildkit-provenance.json`'s Git material.
That maximum-level BuildKit statement and `buildkit-sbom.spdx.json` are bound to
the linux/amd64 platform manifest inside the signed image index.

`runtime.spdx.json` and `runtime.cyclonedx.json` cover the runtime image's OS and
application packages. `build-dependencies.*.json` inventory the separate build
stage, including the dashboard toolchain. Signed `SHA256SUMS` covers the evidence
files; its own bundle and the independently verified manifest bundle are outside
that checksum list. Use the immutable image digest for independent inspection.
