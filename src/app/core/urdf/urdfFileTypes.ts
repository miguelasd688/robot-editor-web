export const URDF_EXTENSIONS = [".urdf", ".xacro"];

export function isUrdfLikePath(path: string) {
  const lower = path.toLowerCase();
  return URDF_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
