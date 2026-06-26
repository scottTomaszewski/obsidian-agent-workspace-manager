export interface Remote {
  host: "github" | "gitlab" | "other";
  owner: string;
  repo: string;
}

export function parseRemote(url: string): Remote {
  const s = url.trim().replace(/\.git$/, "");
  let hostName = "";
  let path = "";
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  const https = s.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (ssh) { hostName = ssh[1]; path = ssh[2]; }
  else if (https) { hostName = https[1]; path = https[2]; }
  else { return { host: "other", owner: "", repo: "" }; }

  const parts = path.split("/").filter((p) => p.length > 0);
  const repo = parts.pop() ?? "";
  const owner = parts.join("/");
  const host: Remote["host"] = /(^|\.)github\.com$/i.test(hostName)
    ? "github"
    : /gitlab/i.test(hostName)
      ? "gitlab"
      : "other";
  return { host, owner, repo };
}

export function compareUrl(remote: Remote, base: string, branch: string): string {
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${base}...${branch}?expand=1`;
}
