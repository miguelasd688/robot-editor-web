const BROWSER_ITEM_PREVIEW_IMAGES: Record<string, string> = {
  "floor-default": "/browser-previews/floors/default-floor.png",
  "floor-rough": "/browser-previews/floors/rough-floor.svg",
  "link-cube": "/browser-previews/links/cube-link.png",
  "link-sphere": "/browser-previews/links/sphere-link.png",
  "link-cylinder": "/browser-previews/links/cylinder-link.png",
};

export function getBrowserItemPreviewImage(itemId: string): string | undefined {
  return BROWSER_ITEM_PREVIEW_IMAGES[itemId];
}
