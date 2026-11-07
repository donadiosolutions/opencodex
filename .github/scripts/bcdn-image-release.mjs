const [repository, tag] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!token || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
  || !/^[a-zA-Z0-9_.-]+$/.test(tag)) throw new Error("Invalid release lookup");
const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
  signal: AbortSignal.timeout(30000),
});
if (response.status === 404) {
  console.log("absent");
} else if (response.ok) {
  const release = await response.json();
  if (release.tag_name !== tag || typeof release.draft !== "boolean") throw new Error("Invalid release readback");
  console.log(release.draft ? "draft" : "published");
} else {
  throw new Error(`GitHub release lookup: HTTP ${response.status}`);
}
