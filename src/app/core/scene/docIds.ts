import type * as THREE from "three";

let counter = 0;

export function createDocId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  counter += 1;
  return `doc_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function ensureDocId(obj: THREE.Object3D): string {
  const anyObj = obj as any;
  if (anyObj.userData?.docId) return String(anyObj.userData.docId);
  const next = createDocId();
  if (!anyObj.userData) anyObj.userData = {};
  anyObj.userData.docId = next;
  return next;
}

export function getDocId(obj: THREE.Object3D): string {
  const anyObj = obj as any;
  const existing = anyObj.userData?.docId;
  if (existing) return String(existing);
  return ensureDocId(obj);
}
