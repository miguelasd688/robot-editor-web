export type PickResult = {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
};

export type PointerRay = {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
};

export type PointerPickResult = PickResult & {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  distance: number;
};

export type PointerEventInfo = {
  pointerId: number;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ray: PointerRay | null;
  pick: PointerPickResult | null;
};

export type PointerMoveEventInfo = PointerEventInfo & {
  deltaX: number;
  deltaY: number;
};

export type PointerSpringVisual = {
  anchor: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  forceMagnitudeN: number;
  maxForceN: number;
  distanceMeters: number;
};

export type ViewerEvents = {
  onPick?: (pick: PickResult | null) => void;
  onPointerDown?: (event: PointerEventInfo) => boolean | void;
  onPointerMove?: (event: PointerMoveEventInfo) => void;
  onPointerUp?: (event: PointerEventInfo) => void;
  onPointerCancel?: (event: PointerEventInfo) => void;
  onTransformDragging?: (dragging: boolean) => void;
  onTransformChange?: (id: string) => void;
  onTransformEnd?: (id: string) => void;
};

export type TransformSettings = {
  mode: "translate" | "rotate" | "scale";
  space: "local" | "world";
  translationSnap: number | null;
  rotationSnap: number | null;
};

export type SceneNodeKind =
  | "group"
  | "robot"
  | "mesh"
  | "light"
  | "camera"
  | "link"
  | "joint"
  | "visual"
  | "collision"
  | "other";

export type SceneSnapshot = {
  nodes: Array<{
    id: string;
    name: string;
    parentId: string | null;
    children: string[];
    kind: SceneNodeKind;
  }>;
  roots: string[];
};
