export type InferredRepo = {
  host: string | null;
  owner: string | null;
  repo: string | null;
  isGitHub: boolean;
};

const HTTPS = /^https?:\/\/(?:[^/@]+@)?([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i;
const SSH = /^git@([^:]+):([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i;
const GIT_SSH = /^(?:git\+)?ssh:\/\/git@([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i;

export function inferGitHubOriginRepo(remoteUrl: string): InferredRepo {
  const empty: InferredRepo = { host: null, owner: null, repo: null, isGitHub: false };
  if (!remoteUrl) return empty;
  for (const re of [HTTPS, SSH, GIT_SSH]) {
    const m = re.exec(remoteUrl);
    if (m) {
      const [, host, owner, repo] = m;
      return {
        host: host.toLowerCase(),
        owner,
        repo,
        isGitHub: host.toLowerCase() === "github.com"
      };
    }
  }
  return empty;
}
