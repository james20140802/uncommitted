import type { ProjectRecord } from "./project-registry.js";

export type ClaudeSessionAttribution = {
  projectId: string;
  projectName: string;
  matchedCwd: string;
};

export function attributeCwdToProject(
  cwd: string,
  projects: ProjectRecord[]
): ClaudeSessionAttribution | null {
  for (const project of projects) {
    if (cwd === project.root || cwd.startsWith(`${project.root}/`)) {
      return {
        projectId: project.id,
        projectName: project.name,
        matchedCwd: cwd
      };
    }
  }
  return null;
}
