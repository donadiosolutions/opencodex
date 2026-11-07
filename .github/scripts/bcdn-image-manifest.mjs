import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [command, path, ...values] = process.argv.slice(2);
const sha = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const tag = /^[a-zA-Z0-9_.-]+-bcdn[0-9]{2,}$/;
const version = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[A-Za-z-][0-9A-Za-z-]*|0|[1-9][0-9]*)(?:\.(?:[A-Za-z-][0-9A-Za-z-]*|0|[1-9][0-9]*))*)?$/;

function check(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`);
}

function validate(manifest) {
  const fields = ["schema_version", "repository", "source_branch", "source_sha", "upstream_tag", "upstream_sha", "release_tag", "workflow_sha", "run_id", "image_digest", "package_filename", "package_name", "package_version", "package_sha256", "package_sha512"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort().join() !== fields.sort().join()) throw new Error("Invalid release manifest keys");
  if (manifest.schema_version !== 2) throw new Error("Invalid release manifest version");
  check(manifest.repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "repository");
  if (typeof manifest.source_branch !== "string" || !manifest.source_branch
    || manifest.source_branch.length > 200 || /[\u0000-\u001f\u007f]/.test(manifest.source_branch)) {
    throw new Error("Invalid source_branch");
  }
  check(manifest.source_sha, sha, "source_sha");
  check(manifest.upstream_tag, /^[a-zA-Z0-9_.-]+$/, "upstream_tag");
  check(manifest.upstream_sha, sha, "upstream_sha");
  check(manifest.release_tag, tag, "release_tag");
  if (!manifest.release_tag.startsWith(`${manifest.upstream_tag}-bcdn`)) {
    throw new Error("Release tag does not extend upstream tag");
  }
  check(manifest.workflow_sha, sha, "workflow_sha");
  check(manifest.run_id, /^[1-9][0-9]*$/, "run_id");
  check(manifest.image_digest, digest, "image_digest");
  if (manifest.package_filename !== `opencodex-${manifest.release_tag}.tgz`) {
    throw new Error("Package filename does not bind release tag");
  }
  if (manifest.package_name !== "@bitkyc08/opencodex") throw new Error("Invalid package name");
  check(manifest.package_version, version, "package_version");
  if (manifest.upstream_tag !== `v${manifest.package_version}`) {
    throw new Error("Package version does not match upstream tag");
  }
  check(manifest.package_sha256, /^[0-9a-f]{64}$/, "package_sha256");
  check(manifest.package_sha512, /^[0-9a-f]{128}$/, "package_sha512");
}

function verifyPackage(manifest, packagePath) {
  validate(manifest);
  if (basename(packagePath) !== manifest.package_filename) throw new Error("Package path does not match manifest filename");
  const bytes = readFileSync(packagePath);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.package_sha256
    || createHash("sha512").update(bytes).digest("hex") !== manifest.package_sha512) {
    throw new Error("Package bytes do not match release manifest");
  }
}

if (command === "create") {
  const [repository, source_branch, source_sha, upstream_tag, upstream_sha, release_tag, workflow_sha, run_id, image_digest,
    package_filename, package_name, package_version, package_sha256, package_sha512] = values;
  const manifest = { schema_version: 2, repository, source_branch, source_sha, upstream_tag, upstream_sha, release_tag, workflow_sha, run_id, image_digest,
    package_filename, package_name, package_version, package_sha256, package_sha512 };
  validate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (command === "verify") {
  const [expectedDigest, expectedReleaseTag, expectedSourceSha, expectedWorkflowSha,
    expectedUpstreamTag, expectedUpstreamSha, expectedSourceBranch, expectedRunId, expectedPackagePath] = values;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  validate(manifest);
  if (!expectedPackagePath) throw new Error("Expected package path is required");
  verifyPackage(manifest, expectedPackagePath);
  if (manifest.image_digest !== expectedDigest || manifest.release_tag !== expectedReleaseTag
    || manifest.source_sha !== expectedSourceSha || manifest.workflow_sha !== expectedWorkflowSha
    || manifest.upstream_tag !== expectedUpstreamTag || manifest.upstream_sha !== expectedUpstreamSha
    || manifest.source_branch !== expectedSourceBranch || manifest.run_id !== expectedRunId) {
    throw new Error("Release manifest does not bind expected image and workflow");
  }
  if (`${JSON.stringify(manifest, null, 2)}\n` !== readFileSync(path, "utf8")) {
    throw new Error("Non-canonical release manifest");
  }
} else {
  throw new Error("Expected create or verify");
}
