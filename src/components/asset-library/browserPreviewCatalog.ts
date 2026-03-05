const BROWSER_ITEM_PREVIEW_IMAGES: Record<string, string> = {
  "floor-default": "/browser-previews/floors/default-floor.png",
  "floor-rough": "/browser-previews/floors/rough-floor.webp",
  "robot-sample-cartpole": "/browser-previews/robots/cartpole.png",
  "robot-sample-ant": "/browser-previews/robots/ant.webp",
  "robot-sample-humanoid": "/browser-previews/robots/humanoid.webp",
  "robot-sample-anymal_c": "/browser-previews/robots/anymal-c.webp",
  "robot-sample-ur10": "/browser-previews/robots/ur10.png",
  "robot-sample-open_arm": "/browser-previews/robots/open-arm.webp",
  "link-cube": "/browser-previews/links/cube-link.png",
  "link-sphere": "/browser-previews/links/sphere-link.png",
  "link-cylinder": "/browser-previews/links/cylinder-link.png",
};

const LIBRARY_SAMPLE_PREVIEW_IMAGES: Record<string, string> = {
  cartpole: "/browser-previews/robots/cartpole.png",
  ant: "/browser-previews/robots/ant.webp",
  humanoid: "/browser-previews/robots/humanoid.webp",
  anymal_c: "/browser-previews/robots/anymal-c.webp",
  ur10: "/browser-previews/robots/ur10.png",
  open_arm: "/browser-previews/robots/open-arm.webp",
};

export function getBrowserItemPreviewImage(itemId: string): string | undefined {
  return BROWSER_ITEM_PREVIEW_IMAGES[itemId];
}

export function getLibrarySamplePreviewImage(sampleId: string): string | undefined {
  return LIBRARY_SAMPLE_PREVIEW_IMAGES[sampleId];
}
