# Verify a bcdn image release

The numbered tag is an immutable locator. Use `image_digest` in
`release-manifest.json` for deployments and independent checks.

1. Check that `SHA256SUMS` covers every evidence file except the two Sigstore
   bundles and the checksum file itself. Run `sha256sum -c SHA256SUMS` in this
   directory.
2. Verify `SHA256SUMS.sigstore.json` and
   `release-manifest.sigstore.json` with `cosign verify-blob --bundle`, requiring
   the GitHub Actions OIDC issuer and the exact workflow certificate identity.
3. Verify the image by digest with `cosign verify`, using the same identity and
   issuer. Check the signed GitHub release binding attestation with
   `gh attestation verify oci://<image>@<digest> --repo <owner/repo>
   --signer-workflow <owner/repo>/.github/workflows/bcdn-image.yml`.
4. Compare the attested predicate, image registry provenance, and manifest:
   `source_sha`, `upstream_sha`, `workflow_sha`, `release_tag`, and
   `image_digest` must match the selected release. The raw
   `buildkit-provenance.json` material must identify the exact Git source
   commit and include max-mode build steps. Its `buildkit-sbom.spdx.json` and the
   runtime Syft SPDX/CycloneDX inventories must refer to that image digest.

The `build-dependencies.*.json` files inventory the separate BuildKit build
stage. They are evidence of packages used during the build, not packages in
the runtime image.
