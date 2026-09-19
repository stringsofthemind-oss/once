export async function openIssue(octokit: any) {
  return octokit.issues.create({
    owner: "acme",
    repo: "service",
    title: "Incident"
  });
}
