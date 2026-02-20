import type { ThreeSceneAdapter } from "./ThreeSceneAdapter";

let adapter: ThreeSceneAdapter | null = null;

export function setThreeAdapter(next: ThreeSceneAdapter | null) {
  adapter = next;
}

export function getThreeAdapter() {
  return adapter;
}
