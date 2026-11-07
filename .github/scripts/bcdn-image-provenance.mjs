import { readFileSync } from "node:fs";

const [path, repository, sourceSha, imageDigest, releaseTag, runId] = process.argv.slice(2);
const data = JSON.parse(readFileSync(path, "utf8"));
const sourceUris = new Set([
  `https://github.com/${repository}.git`,
  `https://github.com/${repository}`,
  `git+https://github.com/${repository}.git`,
]);

if (imageDigest) {
  if (!Array.isArray(data) || !data.length) throw new Error("Missing verified release attestations");
  const matched = data.some((item) => {
    const statement = item?.verificationResult?.statement;
    const subject = statement?.subject;
    const predicate = statement?.predicate;
    return Array.isArray(subject)
      && subject.some((entry) => entry?.digest?.sha256 === imageDigest.slice(7))
      && statement.predicateType === `https://github.com/${repository}/attestations/bcdn-release/v1`
      && predicate?.repository === repository
      && predicate?.source_sha === sourceSha
      && predicate?.image_digest === imageDigest
      && predicate?.release_tag === releaseTag
      && (!runId || predicate?.run_id === runId);
  });
  if (!matched) throw new Error("Verified attestation does not bind the selected release");
} else {
  const statement = data?.["buildx.build.provenance"];
  const predicate = statement?.predicate ?? statement;
  const materials = [
    ...(predicate?.materials ?? []),
    ...(predicate?.buildDefinition?.resolvedDependencies ?? []),
  ];
  const matched = materials.some((material) => {
    const uri = material?.uri?.split(/[?#]/, 1)[0];
    const hash = material?.digest?.sha1 ?? material?.digest?.gitCommit;
    return sourceUris.has(uri) && hash === sourceSha;
  });
  const configSource = predicate?.buildDefinition?.externalParameters?.configSource;
  const sourceMatch = sourceUris.has(configSource?.uri?.split(/[?#]/, 1)[0])
    && configSource?.digest?.sha1 === sourceSha;
  const maxMode = !!predicate?.buildDefinition?.internalParameters?.buildConfig?.llbDefinition;
  if (!(matched || sourceMatch) || !maxMode) {
    throw new Error("BuildKit max provenance lacks the selected Git source material");
  }
}
