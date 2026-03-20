/**
 * USD Loader — public façade.
 *
 * Internal responsibilities have been split into the `usdLoader/` module folder.
 * This file re-exports the public API so that existing callers continue to work
 * with the same import path.
 */

export type { UsdVariantImportHints, USDLoaderParams, USDImportDeps } from "./usdLoader/types";
export { __testOnlyHasMaterialChannelIntent } from "./usdLoader/materials";
export { collectUsdBundleFiles, loadUSDObject, loadWorkspaceUSDIntoViewer } from "./usdLoader/api";
