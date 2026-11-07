import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, directory] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
if (manifest?.schema_version !== 2 || typeof manifest.release_tag !== "string"
  || !/^[a-zA-Z0-9_.-]+-bcdn[0-9]{2,}$/.test(manifest.release_tag)
  || manifest.package_filename !== `opencodex-${manifest.release_tag}.tgz`) {
  throw new Error("Invalid package asset name in release manifest");
}
const signed = [
  "VERIFY.md",
  "build-dependencies.cyclonedx.json",
  "build-dependencies.spdx.json",
  "buildkit-provenance.json",
  "buildkit-sbom.spdx.json",
  "github-provenance-verification.json",
  "github-sbom-verification.json",
  "image-registry-verification.json",
  "image-signature-verification.json",
  "manifest-signature-verification.txt",
  "package-binding-verification.json",
  "package-build-metadata.json",
  manifest.package_filename,
  "package-inventory.json",
  "package-provenance-verification.json",
  "package-signature-verification.txt",
  "release-attestation-verification.json",
  "release-manifest.json",
  "runtime.cyclonedx.json",
  "runtime.spdx.json",
];
const all = [...signed, "SHA256SUMS", "SHA256SUMS.sigstore.json", "release-manifest.sigstore.json", "package.sigstore.json"];
const actual = readdirSync(directory).sort();
if (command === "verify" && actual.join() !== all.sort().join()) {
  throw new Error(`Release evidence asset set mismatch: ${actual.join(", ")}`);
}
const lines = signed.map((name) => {
  const hash = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
  return `${hash}  ${name}`;
});
const expected = `${lines.join("\n")}\n`;
if (command === "create") {
  writeFileSync(join(directory, "SHA256SUMS"), expected);
} else if (command === "verify") {
  if (readFileSync(join(directory, "SHA256SUMS"), "utf8") !== expected) {
    throw new Error("Release evidence checksums do not match");
  }
} else {
  throw new Error("Expected create or verify");
}
