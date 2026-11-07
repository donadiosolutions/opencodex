import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [command, repository, reference, sourceSha, releaseTag, output] = process.argv.slice(2);
const actor = process.env.GITHUB_ACTOR;
const credential = process.env.GHCR_TOKEN;
if (!actor || !credential || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
  throw new Error("Missing registry identity");
}
const path = repository.toLowerCase();
const tokenUrl = new URL("https://ghcr.io/token");
tokenUrl.searchParams.set("service", "ghcr.io");
tokenUrl.searchParams.set("scope", `repository:${path}:pull`);
const auth = `Basic ${Buffer.from(`${actor}:${credential}`).toString("base64")}`;
const tokenResponse = await fetch(tokenUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30000) });
if (!tokenResponse.ok) throw new Error(`GHCR token request: HTTP ${tokenResponse.status}`);
const token = (await tokenResponse.json()).token;
if (typeof token !== "string" || !token) throw new Error("Missing GHCR bearer token");
const base = `https://ghcr.io/v2/${path}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

async function registryGet(kind, ref, accept) {
  const response = await fetch(`${base}/${kind}/${ref}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GHCR ${kind} request: HTTP ${response.status}`);
  return response;
}
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
async function manifest(ref) {
  const response = await registryGet("manifests", ref, manifestTypes);
  if (!response) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
  const header = response.headers.get("docker-content-digest");
  if (header && header !== digest) throw new Error("Registry manifest digest mismatch");
  return { value: JSON.parse(bytes.toString("utf8")), digest };
}
async function blob(ref) {
  const response = await registryGet("blobs", ref, "application/octet-stream");
  if (!response) throw new Error("Missing registry blob");
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== ref) throw new Error("Registry blob digest mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

if (command === "lookup") {
  const result = await manifest(reference);
  writeFileSync(output, `${result?.digest ?? "absent"}\n`);
} else if (command === "verify") {
  if (!digestPattern.test(reference) || !/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("Invalid selected digest");
  const root = await manifest(reference);
  if (!root || root.digest !== reference || !Array.isArray(root.value.manifests)) {
    throw new Error("Expected immutable OCI image index");
  }
  const platform = root.value.manifests.filter((item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64");
  if (platform.length !== 1) throw new Error("Expected one linux/amd64 image");
  const platformManifest = await manifest(platform[0].digest);
  const configDigest = platformManifest?.value?.config?.digest;
  if (!digestPattern.test(configDigest)) throw new Error("Missing image config");
  const config = await blob(configDigest);
  const labels = config?.config?.Labels;
  if (labels?.["org.opencontainers.image.revision"] !== sourceSha
    || labels?.["org.opencontainers.image.source"] !== `https://github.com/${repository}`
    || labels?.["org.opencontainers.image.version"] !== releaseTag) {
    throw new Error("Image source labels do not match selected release");
  }
  const attestations = root.value.manifests.filter((item) => item.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
    && item.annotations?.["vnd.docker.reference.digest"] === platform[0].digest);
  if (!attestations.length) throw new Error("Missing digest-bound BuildKit attestations");
  let provenance = null;
  let sbom = null;
  for (const item of attestations) {
    const attestation = await manifest(item.digest);
    for (const layer of attestation?.value?.layers ?? []) {
      if (!digestPattern.test(layer.digest)) continue;
      const statement = await blob(layer.digest);
      if (!statement || !Array.isArray(statement.subject)
        || !statement.subject.some((subject) => subject?.digest?.sha256 === platform[0].digest.slice(7))) continue;
      if (statement.predicateType?.startsWith("https://slsa.dev/provenance/")) {
        const predicate = statement.predicate;
        const materials = [
          ...(predicate?.materials ?? []),
          ...(predicate?.buildDefinition?.resolvedDependencies ?? []),
          predicate?.buildDefinition?.externalParameters?.configSource,
        ].filter(Boolean);
        const sourceMatch = materials.some((material) => {
          const uri = material?.uri?.split(/[?#]/, 1)[0];
          return [`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git+https://github.com/${repository}.git`].includes(uri)
            && (material?.digest?.sha1 === sourceSha || material?.digest?.gitCommit === sourceSha);
        });
        const maxMode = !!predicate?.buildDefinition?.internalParameters?.buildConfig?.llbDefinition;
        if (sourceMatch && maxMode) provenance = statement;
      }
      if (statement.predicateType === "https://spdx.dev/Document") sbom = statement;
    }
  }
  if (!provenance || !sbom) throw new Error("BuildKit source provenance or SBOM does not bind this image");
  writeFileSync(output, `${JSON.stringify({ image_digest: reference, platform_digest: platform[0].digest, source_sha: sourceSha, buildkit_provenance: true, buildkit_sbom: true }, null, 2)}\n`);
  writeFileSync(join(dirname(output), "buildkit-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(join(dirname(output), "buildkit-sbom.spdx.json"), `${JSON.stringify(sbom.predicate, null, 2)}\n`);
} else {
  throw new Error("Expected lookup or verify");
}
