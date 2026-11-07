// Trusted orchestration: never load code from the selected branch.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const PREFIX = 'opencodex-fork-reservation-v1\n';
const IMAGE = 'ghcr.io/donadiosolutions/opencodex';

function nextTag(upstream, names) {
  const prefix = `${upstream}-bcdn`;
  let maximum = 0n;
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const number = BigInt(name.slice(prefix.length));
    if (number > maximum) maximum = number;
  }
  return `${prefix}${String(maximum + 1n).padStart(2, '0')}`;
}
function reservation(message) {
  if (!message?.startsWith(PREFIX)) return null;
  const value = JSON.parse(message.slice(PREFIX.length));
  if (value.schema !== 1 || !/^\d+$/.test(value.run_id) ||
      !/^[a-f0-9]{40}$/.test(value.source_sha) || !/^[a-f0-9]{40}$/.test(value.workflow_sha) ||
      !/^[a-f0-9]{40}$/.test(value.upstream_sha) ||
      !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.upstream_tag) ||
      !value.release_tag?.startsWith(`${value.upstream_tag}-bcdn`) ||
      !/^\d+$/.test(value.release_tag.slice(`${value.upstream_tag}-bcdn`.length))) {
    throw new Error('Malformed release reservation');
  }
  return value;
}
async function allState(github, repo) {
  const [refs, releases] = await Promise.all([
    github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: 'tags/', per_page: 100 }),
    github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 }),
  ]);
  return { refs, releases };
}
async function readReservation(github, repo, ref) {
  if (ref.object.type !== 'tag') return null;
  const { data } = await github.rest.git.getTag({ ...repo, tag_sha: ref.object.sha });
  const value = reservation(data.message);
  if (value && (data.object.type !== 'commit' || data.object.sha !== value.source_sha ||
      ref.ref !== `refs/tags/${value.release_tag}`)) throw new Error('Reservation tag binding mismatch');
  return value;
}
function upstreamIdentity(repo, sha) {
  const directory = mkdtempSync(join(tmpdir(), 'fork-upstream-'));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git('init', '--bare', '--quiet');
  git('fetch', '--quiet', '--no-tags', `https://github.com/${repo.owner}/${repo.repo}.git`, sha);
  git('fetch', '--quiet', '--no-tags', 'https://github.com/lidge-jun/opencodex.git',
    '+refs/tags/v*:refs/tags/official/v*');
  const tag = git('describe', '--tags', '--abbrev=0', '--match', 'official/v[0-9]*', sha);
  const upstream_tag = tag.replace(/^official\//, '');
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(upstream_tag)) throw new Error('Invalid official version tag');
  const upstream_sha = git('rev-parse', `${tag}^{commit}`);
  git('merge-base', '--is-ancestor', upstream_sha, sha);
  return { upstream_tag, upstream_sha };
}
function notes(value, digest) {
  const run = `https://github.com/${value.repository}/actions/runs/${value.run_id}`;
  const ref = digest ? `${IMAGE}@${digest}` : 'Pending verified image';
  return `Upstream: [${value.upstream_tag}](https://github.com/lidge-jun/opencodex/tree/${value.upstream_sha})\n\n` +
    `Source: ${value.repository}@${value.source_sha} (branch: ${value.source_branch})\n\n` +
    `Workflow revision: ${value.workflow_sha}\n\nImage: \`${ref}\`\n\n[Build and verification run](${run})\n\n` +
    'The application version remains the upstream version. The numbered suffix identifies this fork artifact.\n\n' +
    'Download the release evidence and follow VERIFY.md to verify the digest, keyless signature, SBOMs, and provenance.\n\n' +
    `<!-- ${PREFIX}${JSON.stringify(value)} -->\n`;
}
async function reserve({ github, context, core }) {
  const repo = context.repo;
  if (`${repo.owner}/${repo.repo}` !== 'donadiosolutions/opencodex') throw new Error('Fork-only workflow');
  const { data: repository } = await github.rest.repos.get(repo);
  if (context.ref !== `refs/heads/${repository.default_branch}` || context.sha !== process.env.GITHUB_WORKFLOW_SHA) {
    throw new Error('Dispatch must use the default branch workflow revision');
  }
  // Reruns retain the original dispatch actor's privileges. Check both actors
  // so a writer cannot use an authorized operator's old run to publish.
  for (const username of new Set([context.actor, process.env.GITHUB_TRIGGERING_ACTOR])) {
    if (!username) throw new Error('Missing release actor identity');
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username });
    if (![data.permission, data.role_name].some(role => ['maintain', 'admin'].includes(role))) {
      throw new Error('Fork releases require maintain or admin repository access');
    }
  }
  const runId = String(context.runId);
  const state = await allState(github, repo);
  let value;
  for (const ref of state.refs.filter(r => /-bcdn\d+$/.test(r.ref))) {
    const candidate = await readReservation(github, repo, ref);
    if (candidate?.run_id === runId) {
      if (value) throw new Error('Duplicate run reservation');
      value = candidate;
    }
  }
  if (value && (value.repository !== `${repo.owner}/${repo.repo}` || value.workflow_sha !== context.sha)) {
    throw new Error('Rerun workflow identity differs from reservation');
  }
  if (!value) {
    const source_branch = process.env.SOURCE_BRANCH;
    if (!source_branch || source_branch.length > 200) throw new Error('Invalid source branch');
    execFileSync('git', ['check-ref-format', `refs/heads/${source_branch}`], { timeout: 10000 });
    const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: source_branch });
    const source_sha = branch.commit.sha;
    const identity = upstreamIdentity(repo, source_sha);
    const names = [...state.refs.map(r => r.ref.replace(/^refs\/tags\//, '')), ...state.releases.map(r => r.tag_name)];
    for (let attempt = 0; attempt < 10; attempt++) {
      const release_tag = nextTag(identity.upstream_tag, names);
      value = { schema: 1, repository: `${repo.owner}/${repo.repo}`, run_id: runId,
        source_branch, source_sha, ...identity, workflow_sha: context.sha, release_tag };
      const { data: tag } = await github.rest.git.createTag({ ...repo, tag: release_tag,
        message: PREFIX + JSON.stringify(value), object: source_sha, type: 'commit' });
      try {
        await github.rest.git.createRef({ ...repo, ref: `refs/tags/${release_tag}`, sha: tag.sha });
        break;
      } catch (error) {
        if (error.status !== 422 || attempt === 9) throw error;
        // Prove a real collision, then recompute the current numeric maximum.
        await github.rest.git.getRef({ ...repo, ref: `tags/${release_tag}` });
        const current = await allState(github, repo);
        names.push(release_tag, ...current.refs.map(r => r.ref.replace(/^refs\/tags\//, '')),
          ...current.releases.map(r => r.tag_name));
        value = undefined;
      }
    }
  }
  let release = state.releases.find(r => r.tag_name === value.release_tag);
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({ ...repo, tag_name: value.release_tag,
      target_commitish: value.source_sha, name: value.release_tag, body: notes(value), draft: true }));
  }
  if (release.name !== value.release_tag || !release.body?.includes(JSON.stringify(value))) {
    throw new Error('Release reservation metadata differs from tag');
  }
  for (const key of ['release_tag', 'source_sha', 'source_branch', 'upstream_tag', 'upstream_sha', 'workflow_sha']) {
    core.setOutput(key, value[key]);
  }
  core.setOutput('release_id', String(release.id));
  core.info(`Reserved ${value.release_tag} at ${value.source_sha}`);
}
async function finalize({ github, context, core }) {
  const repo = context.repo;
  const tag = process.env.RELEASE_TAG;
  const { data: ref } = await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
  const value = await readReservation(github, repo, ref);
  if (!value || value.run_id !== String(context.runId) || value.workflow_sha !== context.sha ||
      value.source_sha !== process.env.SOURCE_SHA) throw new Error('Finalization reservation mismatch');
  const directory = process.env.EVIDENCE_DIRECTORY;
  const manifestBytes = readFileSync(join(directory, 'release-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const digest = process.env.IMAGE_DIGEST;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || manifest.image_digest !== digest ||
      manifest.schema_version !== 1 || manifest.repository !== value.repository ||
      manifest.source_branch !== value.source_branch || manifest.run_id !== value.run_id ||
      manifest.source_sha !== value.source_sha || manifest.release_tag !== tag ||
      manifest.workflow_sha !== value.workflow_sha || manifest.upstream_tag !== value.upstream_tag ||
      manifest.upstream_sha !== value.upstream_sha) throw new Error('Verified manifest binding mismatch');
  const { data: release } = await github.rest.repos.getRelease({ ...repo, release_id: Number(process.env.RELEASE_ID) });
  if (release.tag_name !== tag) throw new Error('Release tag mismatch');
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some(f => !f.isFile())) throw new Error('Evidence must contain regular files only');
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  const assetBytes = async asset => {
    const { data } = await github.rest.repos.getReleaseAsset({ ...repo, asset_id: asset.id,
      headers: { accept: 'application/octet-stream' } });
    return Buffer.from(data);
  };
  if (!release.draft) {
    if (release.body !== notes(value, digest) || release.name !== tag || existing.length !== files.length) {
      throw new Error('Published release metadata or evidence set differs');
    }
    for (const file of files) {
      const prior = existing.find(a => a.name === file.name);
      if (!prior || !(await assetBytes(prior)).equals(readFileSync(join(directory, file.name)))) {
        throw new Error(`Published evidence differs: ${file.name}`);
      }
    }
    core.info('Verified existing published release; preserving its evidence');
    return;
  }
  for (const file of files) {
    const bytes = readFileSync(join(directory, file.name));
    const asset = existing.find(a => a.name === file.name);
    if (asset) {
      if ((await assetBytes(asset)).equals(bytes)) continue;
      // A verified retry may refresh signatures in an unpublished draft only.
      await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    }
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: release.id, name: file.name,
      data: bytes, headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length } });
  }
  await github.rest.repos.updateRelease({ ...repo, release_id: release.id,
    name: tag, body: notes(value, digest), draft: false, make_latest: 'false' });
  core.info(`Published ${tag}: ${digest}`);
}
async function promote({ github, context, core }) {
  if (process.env.SOURCE_BRANCH !== 'custom') throw new Error('Only custom can promote latest');
  const repo = context.repo;
  const state = await allState(github, repo);
  for (const release of state.releases.filter(r => !r.draft && /-bcdn\d+$/.test(r.tag_name))) {
    const ref = state.refs.find(r => r.ref === `refs/tags/${release.tag_name}`);
    const value = ref && await readReservation(github, repo, ref);
    if (value?.source_branch === 'custom' && BigInt(value.run_id) > BigInt(context.runId)) {
      core.info(`A newer custom release exists (${release.tag_name}); preserving latest`);
      return;
    }
  }
  const digest = process.env.IMAGE_DIGEST;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid verified digest');
  const auth = Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64');
  const response = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:donadiosolutions/opencodex:pull,push', {
    headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Registry auth failed: ${response.status}`);
  const { token } = await response.json();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' };
  const url = 'https://ghcr.io/v2/donadiosolutions/opencodex/manifests/';
  const source = await fetch(url + digest, { headers, signal: AbortSignal.timeout(30000) });
  if (!source.ok || source.headers.get('docker-content-digest') !== digest) throw new Error('Verified image is unavailable');
  const bytes = new Uint8Array(await source.arrayBuffer());
  const actual = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  if (`sha256:${actual}` !== digest) throw new Error('Registry manifest digest mismatch');
  const result = await fetch(url + 'latest', { method: 'PUT', headers: { ...headers, 'Content-Type': source.headers.get('content-type') },
    body: bytes, signal: AbortSignal.timeout(30000) });
  if (!result.ok) throw new Error(`Latest promotion failed: ${result.status}`);
  const latest = await fetch(url + 'latest', { method: 'HEAD', headers, signal: AbortSignal.timeout(30000) });
  if (!latest.ok || latest.headers.get('docker-content-digest') !== digest) throw new Error('Latest digest verification failed');
  core.info(`latest resolves to ${digest}`);
}
module.exports = { nextTag, reservation, reserve, finalize, promote, allState, readReservation, upstreamIdentity, notes };
