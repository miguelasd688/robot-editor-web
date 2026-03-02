import { isUrdfLikePath } from "../../../app/core/urdf/urdfFileTypes";

export function isURDF(path: string) {
  return isUrdfLikePath(path);
}
