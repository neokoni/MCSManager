import path from "path";

export function resolveDockerWorkspacePath(
  cwd: string,
  defaultInstanceDir: string,
  hostWorkspacePath: string | null
) {
  if (!hostWorkspacePath) return cwd;

  const relativePath = path.relative(defaultInstanceDir, cwd);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return cwd;
  }

  return path.normalize(path.join(hostWorkspacePath, relativePath));
}
