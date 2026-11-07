import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const [receipt, manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const attestations = JSON.parse(readFileSync(receipt, 'utf8'));
if (!Array.isArray(attestations) || !attestations.some(item => {
  const statement = item?.verificationResult?.statement;
  return statement?.predicateType === `https://github.com/${manifest.repository}/attestations/bcdn-release/v1`
    && isDeepStrictEqual(statement.predicate, manifest)
    && statement.subject?.some(subject => subject.digest?.sha256 === manifest.package_sha256);
})) throw new Error('Verified package attestation does not bind the exact release manifest');
