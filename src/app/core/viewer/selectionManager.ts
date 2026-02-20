import * as THREE from "three";
import type { TransformControls } from "three-stdlib";
import type { TransformSettings } from "./types";

const HELPER_LAYER = 1;

export class SelectionManager {
  private scene: THREE.Scene | null = null;
  private transformControls: TransformControls | null = null;
  private objects: Map<string, THREE.Object3D> | null = null;
  private getTransformSettings: (() => TransformSettings) | null = null;
  private selectedId: string | null = null;
  private selectionBox: THREE.BoxHelper | null = null;
  private selectionTarget: THREE.Object3D | null = null;

  private findEditorChild(obj: THREE.Object3D, kind: string) {
    return obj.children.find((child) => child.userData?.editorKind === kind) ?? null;
  }

  private hasEditorChild(obj: THREE.Object3D, kind: string) {
    return obj.children.some((child) => child.userData?.editorKind === kind);
  }

  attach(
    scene: THREE.Scene,
    transformControls: TransformControls | null,
    objects: Map<string, THREE.Object3D>,
    getTransformSettings: () => TransformSettings
  ) {
    this.scene = scene;
    this.transformControls = transformControls;
    this.objects = objects;
    this.getTransformSettings = getTransformSettings;
  }

  detach() {
    this.scene = null;
    this.transformControls = null;
    this.objects = null;
    this.getTransformSettings = null;
  }

  setSelected(id: string | null) {
    this.selectedId = id;

    if (!this.scene || !this.objects) return;

    if (this.selectionBox) {
      this.selectionBox.removeFromParent();
      this.selectionBox = null;
    }
    this.selectionTarget = null;

    if (!id) {
      if (this.transformControls) {
        this.transformControls.detach();
        this.transformControls.visible = false;
      }
      return;
    }

    const obj = this.objects.get(id);
    if (!obj) {
      if (this.transformControls) {
        this.transformControls.detach();
        this.transformControls.visible = false;
      }
      return;
    }

    const target = this.findSelectionTarget(obj);
    this.selectionTarget = target;
    this.selectionBox = new THREE.BoxHelper(target, 0xffffff);
    this.selectionBox.layers.set(HELPER_LAYER);
    this.selectionBox.traverse((child) => child.layers.set(HELPER_LAYER));
    this.scene.add(this.selectionBox);

    if (this.transformControls && this.getTransformSettings) {
      const settings = this.getTransformSettings();
      const attachTarget = this.findTransformTarget(obj, settings);
      this.transformControls.attach(attachTarget);
      this.transformControls.visible = true;
      this.transformControls.setMode(settings.mode);
      this.transformControls.setSpace(settings.space);
      this.transformControls.setTranslationSnap(settings.translationSnap ?? 0);
      this.transformControls.setRotationSnap(settings.rotationSnap ?? 0);
    }
  }

  getSelectedId() {
    return this.selectedId;
  }

  isSelectionHelperObject(obj: THREE.Object3D | null) {
    if (!obj || !this.selectionBox) return false;
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur === this.selectionBox) return true;
      cur = cur.parent;
    }
    return false;
  }

  updateSelectionBox() {
    if (!this.selectionBox || !this.selectionTarget) return;
    this.selectionBox.setFromObject(this.selectionTarget);
  }

  private findSelectionTarget(obj: THREE.Object3D) {
    const anyObj = obj as any;
    if (anyObj.isURDFLink) {
      const directVisual = obj.children.find((child) => (child as any).isURDFVisual) ?? null;
      if (directVisual) return directVisual;
    }
    const editorKind = obj.userData?.editorKind;
    const parentIsJoint = obj.parent?.userData?.editorKind === "joint";
    if (editorKind === "link" && (this.hasEditorChild(obj, "joint") || parentIsJoint)) {
      const visual = this.findEditorChild(obj, "visual") ?? this.findEditorChild(obj, "mesh");
      if (visual) return visual;
    }
    return obj;
  }

  private findTransformTarget(obj: THREE.Object3D, settings: TransformSettings) {
    if (settings.mode !== "scale") return obj;
    return this.findSelectionTarget(obj);
  }

  dispose() {
    if (this.selectionBox) {
      this.selectionBox.removeFromParent();
      this.selectionBox = null;
    }
    if (this.transformControls) {
      this.transformControls.detach();
      this.transformControls.visible = false;
    }
    this.detach();
  }
}
