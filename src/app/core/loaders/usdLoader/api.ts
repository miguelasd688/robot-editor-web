/**
 * api.ts — High-level orchestration layer for USD import.
 *
 * Re-exports the three public entry points:
 *   - collectUsdBundleFiles
 *   - loadUSDObject
 *   - loadWorkspaceUSDIntoViewer
 */

import * as THREE from "three";
import {
  collectUsdBundleFiles as collectUsdBundleFilesFromCollector,
  type CollectedUsdBundle,
  type UsdWorkspaceAssetEntry,
} from "../../usd/usdBundleCollector";
import type { UsdModelSource } from "../../editor/document/types";
import { basename, createAssetResolver } from "../assetResolver";
import { logInfo, logWarn } from "../../services/logger";
import { useLoaderStore } from "../../store/useLoaderStore";
import {
  isDefaultFloorWorkspaceKey,
  isManagedRoughFloorWorkspaceKey,
} from "../../assets/floorAppearance";
import type {
  USDLoaderParams,
  USDImportDeps,
  UsdImportWarning,
  NormalizedUsdMeshScene,
  NormalizedUsdIntrospection,
  UsdJointPoseDecisionSummary,
} from "./types";
import { stripFileExtension } from "./types";
import {
  usdConverterEnabled,
  resolveUsdImportDebugTrace,
  createUsdImportTraceId,
  resolveUsdMeshSceneProfile,
  normalizeUsdConverterDiagnostics,
  resolveUsdConverterAssetId,
  convertUsdAssetToMjcf,
  introspectUsdAsset,
  fetchUsdMeshScene,
} from "./converterPipeline";
import { parseMjcf, buildRobotFromMjcf, applyMeshSceneBodyPosesToMjcf } from "./mjcf";
import { buildRobotFromIntrospection, attachUsdIntrospectionMetadata } from "./introspection";
import {
  augmentRobotHierarchyFromMeshSceneBodies,
  applyUsdBodyPosesToCollapsedLinks,
  attachUsdMeshSceneToRoot,
} from "./hierarchy";
import { collectMeshSceneStructureTokens } from "./meshScene";
import {
  inferSceneAssetSourceRole,
  applyDefaultFloorAppearanceToSceneAsset,
  applyRoughFloorAppearanceToSceneAsset,
  retagUsdRootAsSceneAsset,
  applySceneAssetPhysicsDefaults,
  ensureSceneAssetRootHierarchy,
  groupSceneAssetLinksUnderContainers,
} from "./sceneAsset";
import { fallbackUsdHierarchyFromTokens, buildRobotFromMeshSceneBodies } from "./fallback";

// ── collectUsdBundleFiles ───────────────────────────────────────────────

export async function collectUsdBundleFiles(params: {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  resolveResource?: (resourcePath: string) => string | null;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  bundleHintPaths?: string[];
  maxFiles?: number;
}): Promise<CollectedUsdBundle> {
  return await collectUsdBundleFilesFromCollector(params);
}

// ── loadUSDObject ───────────────────────────────────────────────────────

export async function loadUSDObject(params: USDLoaderParams): Promise<THREE.Object3D> {
  const {
    usdUrl,
    usdKey,
    usdFile,
    usdName,
    resolveResource,
    importOptions,
    converterAssetId,
    assetsByKey,
    bundleHintPaths,
    variantImportHints,
    sceneRole,
  } = params;
  const importSceneRole = sceneRole === "scene_asset" ? "scene_asset" : "robot";
  const displayName = usdName ?? (basename(usdKey) || usdKey);
  const debugTrace = resolveUsdImportDebugTrace(importOptions);
  const debugTraceDetailed = debugTrace === "detailed";
  const traceId = createUsdImportTraceId(usdKey);

  logInfo(`USD load: ${usdKey}`, {
    scope: "usd",
    data: {
      traceId,
      debugTrace,
      posePolicy: variantImportHints?.posePolicy ?? "auto",
      referenceUsdKey: variantImportHints?.referenceUsdKey ?? null,
    },
  });

  let root: THREE.Object3D | null = null;
  let resolvedConverterAssetId = converterAssetId ?? null;
  let resolvedMjcfAssetId: string | undefined;
  let mjcfXml: string | undefined;
  let useVisualCollisionSync = true;
  let introspection: NormalizedUsdIntrospection | null = null;
  let meshScene: NormalizedUsdMeshScene | null = null;
  let detectedFloatingBase: boolean | undefined;
  let converterDiagnostics = normalizeUsdConverterDiagnostics(null);
  const normalizedUsdKey = String(usdKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  const importWarnings: UsdImportWarning[] = [];
  let jointPoseSummary: UsdJointPoseDecisionSummary | null = null;

  if (usdConverterEnabled) {
    if (!resolvedConverterAssetId) {
      try {
        resolvedConverterAssetId = await resolveUsdConverterAssetId({
          usdUrl,
          usdKey,
          usdFile,
          resolveResource,
          assetsByKey,
          bundleHintPaths,
        });
      } catch (error) {
        logWarn("USD converter upload path failed; using fallback import path.", {
          scope: "usd",
          data: {
            usdKey,
            error: String((error as Error)?.message ?? error),
          },
        });
      }
    }

    if (resolvedConverterAssetId) {
      try {
        introspection = await introspectUsdAsset(resolvedConverterAssetId);
        if (
          introspection &&
          introspection.joints.length > 0 &&
          introspection.joints.some((joint) => !joint.frame0Local)
        ) {
          importWarnings.push({
            code: "USD_IMPORT_FRAME_MISMATCH_FALLBACK",
            message: "USD introspection omitted frame0Local on some joints; compatibility fallback was applied.",
            context: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
            },
          });
          logWarn("USD introspection payload missing frame0Local on one or more joints; using compatibility fallback.", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
            },
          });
        }
      } catch (error) {
        logWarn("USD introspection failed for converter asset.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            error: String((error as Error)?.message ?? error),
          },
        });
      }

      try {
        meshScene = await fetchUsdMeshScene(
          resolvedConverterAssetId,
          resolveUsdMeshSceneProfile(usdKey, importOptions)
        );
      } catch (error) {
        logWarn("USD mesh scene extraction failed for converter asset.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            error: String((error as Error)?.message ?? error),
          },
        });
      }
    }

    try {
      if (!resolvedConverterAssetId) throw new Error("converter asset id unavailable after upload.");
      const converted = await convertUsdAssetToMjcf({
        converterAssetId: resolvedConverterAssetId,
        usdKey,
        importOptions,
      });
      converterDiagnostics = normalizeUsdConverterDiagnostics(converted.diagnostics);
      if (converterDiagnostics.placeholderGeomBodies > 0) {
        useVisualCollisionSync = false;
        importWarnings.push({
          code: "USD_IMPORT_PLACEHOLDER_COLLISION_GEOMS",
          message: "USD conversion synthesized placeholder collision geometry; visual collision proxy sync was disabled to preserve authored collision diagnostics.",
          context: {
            usdKey,
            placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
            bodiesWithAnyGeom: converterDiagnostics.bodiesWithAnyGeom,
          },
        });
      }
      resolvedConverterAssetId = converted.converterAssetId;
      resolvedMjcfAssetId = converted.mjcfAssetId;
      mjcfXml = converted.mjcfXml;
      const introspectionJointCount = introspection?.joints.length ?? 0;
      const mjcfHasBodyHierarchy = /<body(?:\s|>)/i.test(mjcfXml);

      if (!mjcfHasBodyHierarchy && introspection && introspectionJointCount > 0) {
        const built = buildRobotFromIntrospection(introspection, displayName);
        root = built.root;
        logWarn("USD MJCF is missing body hierarchy; using introspection skeleton.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            mjcfAssetId: resolvedMjcfAssetId,
            introspectionJoints: introspectionJointCount,
          },
        });
        logInfo("USD conversion + render completed", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            mjcfAssetId: resolvedMjcfAssetId,
            links: built.linkCount,
            joints: built.jointCount,
            hierarchySource: "introspection",
            diagnostics: converted.diagnostics ?? null,
          },
        });
      } else {
        const parsed = parseMjcf(mjcfXml);
        const eeLinkBody = parsed.bodies.find((body) => body.name === "ee_link") ?? null;
        const eeLinkOnlyPlaceholderBox =
          !!eeLinkBody && eeLinkBody.geoms.length > 0 && eeLinkBody.geoms.every((geom) => geom.type === "box");
        const meshSceneHasEeLinkGeometry = Boolean(
          meshScene?.meshes.some((mesh) => mesh.parentBody === "ee_link") ||
          meshScene?.primitives.some((primitive) => primitive.parentBody === "ee_link")
        );
        if (
          eeLinkOnlyPlaceholderBox &&
          meshSceneHasEeLinkGeometry &&
          (normalizedUsdKey.includes("/ur10") || normalizedUsdKey.endsWith("ur10.usd"))
        ) {
          importWarnings.push({
            code: "USD_IMPORT_EE_LINK_PLACEHOLDER_COLLISION",
            message: "ee_link imported with placeholder box collision geometry while mesh-scene data still exposes end-effector visuals.",
            context: {
              usdKey,
              placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
              eeLinkGeomTypes: eeLinkBody?.geoms.map((geom) => geom.type) ?? [],
            },
          });
        }
        detectedFloatingBase = parsed.bodies.some((body) => body.joints.some((joint) => joint.type === "free"));
        const builtFromMjcf = buildRobotFromMjcf(parsed, displayName, {
          introspection,
          meshScene,
          posePolicy: variantImportHints?.posePolicy ?? "auto",
          traceId,
          debugTraceDetailed,
        });
        const builtJointPoseSummary = builtFromMjcf.poseSummary;
        jointPoseSummary = builtJointPoseSummary;
        logInfo("USD joint pose selection summary", {
          scope: "usd",
          data: {
            traceId,
            usdKey,
            posePolicy: variantImportHints?.posePolicy ?? "auto",
            totalJoints: builtJointPoseSummary.totalDecisions,
            framePairJoints: builtJointPoseSummary.framePairDecisions,
            mjcfJoints: builtJointPoseSummary.mjcfDecisions,
            fallbackJoints: builtJointPoseSummary.fallbackCount,
          },
        });
        if (builtJointPoseSummary.fallbackCount > 0) {
          importWarnings.push({
            code: "USD_IMPORT_JOINT_POSE_FALLBACK",
            message: "Some joints switched from USD frame-pair to MJCF local pose based on policy/evidence.",
            context: {
              traceId,
              posePolicy: variantImportHints?.posePolicy ?? "auto",
              fallbackCount: builtJointPoseSummary.fallbackCount,
              fallbackJoints: builtJointPoseSummary.fallbackJoints,
            },
          });
        }
        const introspectionBodyCount = introspection
          ? new Set(
              introspection.joints
                .flatMap((joint) => [joint.parentBody, joint.childBody])
                .filter((name): name is string => Boolean(name))
            ).size
          : 0;
        const meshSceneBodyCount = meshScene?.bodies.length ?? 0;
        const meshSceneStructureTokenCount = meshScene ? collectMeshSceneStructureTokens(meshScene).size : 0;
        const mjcfHierarchyIncomplete =
          introspectionJointCount > 0 &&
          (
            builtFromMjcf.linkCount <= 1 ||
            builtFromMjcf.jointCount === 0 ||
            (introspectionJointCount >= 4 &&
              builtFromMjcf.jointCount < Math.ceil(introspectionJointCount * 0.4)) ||
            (introspectionBodyCount >= 3 &&
              builtFromMjcf.linkCount < Math.ceil(introspectionBodyCount * 0.4))
          );
        if (mjcfHierarchyIncomplete && introspection) {
          const built = buildRobotFromIntrospection(introspection, displayName);
          root = built.root;
          logWarn("USD MJCF hierarchy appears incomplete; using introspection skeleton.", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
              mjcfAssetId: resolvedMjcfAssetId,
              introspectionJoints: introspectionJointCount,
              introspectionBodies: introspectionBodyCount,
              mjcfLinks: builtFromMjcf.linkCount,
              mjcfJoints: builtFromMjcf.jointCount,
            },
          });
          logInfo("USD conversion + render completed", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
              mjcfAssetId: resolvedMjcfAssetId,
              links: built.linkCount,
              joints: built.jointCount,
              hierarchySource: "introspection",
              diagnostics: converted.diagnostics ?? null,
            },
          });
        } else {
          const mjcfLikelyCorruptedAgainstMeshScene =
            !introspection &&
            meshSceneStructureTokenCount >= 3 &&
            (
              builtFromMjcf.linkCount < Math.max(2, Math.ceil(meshSceneStructureTokenCount * 0.25)) ||
              (meshSceneStructureTokenCount >= 2 && builtFromMjcf.jointCount === 0)
            );
          if (mjcfLikelyCorruptedAgainstMeshScene && meshScene) {
            const builtFromMeshScene = buildRobotFromMeshSceneBodies(meshScene, displayName);
            if (builtFromMeshScene.linkCount > 0) {
              root = builtFromMeshScene.root;
              logWarn("USD MJCF hierarchy appears incompatible with mesh-scene body graph; using mesh-scene skeleton.", {
                scope: "usd",
                data: {
                  usdKey,
                  converterAssetId: resolvedConverterAssetId,
                  mjcfAssetId: resolvedMjcfAssetId,
                  mjcfLinks: builtFromMjcf.linkCount,
                  mjcfJoints: builtFromMjcf.jointCount,
                  meshSceneBodies: meshSceneBodyCount,
                  meshSceneStructureTokens: meshSceneStructureTokenCount,
                },
              });
              logInfo("USD conversion + render completed", {
                scope: "usd",
                data: {
                  usdKey,
                  converterAssetId: resolvedConverterAssetId,
                  mjcfAssetId: resolvedMjcfAssetId,
                  links: builtFromMeshScene.linkCount,
                  joints: builtFromMeshScene.jointCount,
                  hierarchySource: "mesh_scene",
                  diagnostics: converted.diagnostics ?? null,
                },
              });
            } else {
              root = builtFromMjcf.root;
              logInfo("USD conversion + render completed", {
                scope: "usd",
                data: {
                  usdKey,
                  converterAssetId: resolvedConverterAssetId,
                  mjcfAssetId: resolvedMjcfAssetId,
                  links: builtFromMjcf.linkCount,
                  joints: builtFromMjcf.jointCount,
                  hierarchySource: "mjcf",
                  diagnostics: converted.diagnostics ?? null,
                },
              });
            }
          } else {
            root = builtFromMjcf.root;
            logInfo("USD conversion + render completed", {
              scope: "usd",
              data: {
                usdKey,
                converterAssetId: resolvedConverterAssetId,
                mjcfAssetId: resolvedMjcfAssetId,
                links: builtFromMjcf.linkCount,
                joints: builtFromMjcf.jointCount,
                hierarchySource: "mjcf",
                diagnostics: converted.diagnostics ?? null,
              },
            });
          }
        }
      }

      if (useVisualCollisionSync) {
        logInfo("USD visual->collision sync enabled by default.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
          },
        });
      } else {
        logWarn("USD visual->collision sync disabled to avoid masking authored placeholder collision diagnostics.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
          },
        });
      }
    } catch (error) {
      logWarn("USD conversion failed; checking introspection fallback.", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
          error: String((error as Error)?.message ?? error),
        },
      });
    }
  } else {
    logWarn("USD converter is disabled (empty VITE_USD_CONVERTER_BASE_URL). Using fallback hierarchy.", {
      scope: "usd",
    });
  }

  if (!root && introspection) {
    const built = buildRobotFromIntrospection(introspection, displayName);
    root = built.root;
    logInfo("USD introspection fallback hierarchy used.", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        links: built.linkCount,
        joints: built.jointCount,
      },
    });
  }

  const meshSceneStructureTokenCount = meshScene ? collectMeshSceneStructureTokens(meshScene).size : 0;
  if (!root && importSceneRole === "robot" && meshScene && meshSceneStructureTokenCount > 0) {
    const built = buildRobotFromMeshSceneBodies(meshScene, displayName);
    if (built.linkCount > 0) {
      root = built.root;
      logInfo("USD mesh-scene body fallback hierarchy used.", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
          links: built.linkCount,
          joints: built.jointCount,
          bodyCount: meshScene.bodies.length,
          structureTokenCount: meshSceneStructureTokenCount,
        },
      });
    }
  }

  if (!root) {
    root = await fallbackUsdHierarchyFromTokens(displayName, usdUrl, resolveResource);
  }

  attachUsdIntrospectionMetadata(root, introspection);
  const hierarchyAugment =
    importSceneRole === "robot"
      ? augmentRobotHierarchyFromMeshSceneBodies(root, meshScene, {
          selfCollisionEnabled: importOptions?.selfCollision === true,
          traceId,
          detailedTrace: debugTraceDetailed,
        })
      : { createdLinks: 0, createdJoints: 0, unresolvedBodies: 0 };
  if (hierarchyAugment.createdLinks > 0 || hierarchyAugment.unresolvedBodies > 0) {
    const logFn = hierarchyAugment.unresolvedBodies > 0 ? logWarn : logInfo;
    logFn("USD mesh-scene hierarchy augmentation summary", {
      scope: "usd",
      data: {
        traceId,
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        createdLinks: hierarchyAugment.createdLinks,
        createdJoints: hierarchyAugment.createdJoints,
        unresolvedBodies: hierarchyAugment.unresolvedBodies,
      },
    });
  }
  const bodyPosesApplied = applyUsdBodyPosesToCollapsedLinks(root, meshScene);
  let mjcfBodiesPatchedFromMeshScene = 0;
  if (bodyPosesApplied > 0) {
    logInfo("USD body poses applied to collapsed link layout", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        bodyPosesApplied,
        meshSceneBodyCount: meshScene?.bodyCount ?? 0,
      },
    });
    if (mjcfXml) {
      const patched = applyMeshSceneBodyPosesToMjcf(mjcfXml, meshScene);
      if (patched.updatedBodyCount > 0) {
        mjcfXml = patched.mjcfXml;
        mjcfBodiesPatchedFromMeshScene = patched.updatedBodyCount;
        logInfo("USD MJCF body poses patched from mesh scene", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            patchedBodies: patched.updatedBodyCount,
          },
        });
      } else {
        logWarn("USD body poses were adjusted in viewer but MJCF body patch found no matching names.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            bodyPosesApplied,
            meshSceneBodyCount: meshScene?.bodyCount ?? 0,
          },
        });
      }
    }
  }
  const shouldReplaceExistingVisuals = Boolean(
    meshScene &&
      !meshScene.truncated &&
      (meshScene.meshes.length > 0 || meshScene.primitives.length > 0)
  );
  const meshAttach = attachUsdMeshSceneToRoot(root, meshScene, {
    selfCollisionEnabled: importOptions?.selfCollision === true,
    resolveResource,
    attachCollisionProxies: useVisualCollisionSync,
    replaceExisting: shouldReplaceExistingVisuals,
    traceId,
    detailedTrace: debugTraceDetailed,
  });
  if (meshScene && meshScene.meshes.length > 0 && meshAttach.attachedMeshes === 0) {
    importWarnings.push({
      code: "USD_IMPORT_MESH_ATTACH_DROP",
      message: "USD mesh-scene contained meshes but no visual mesh could be attached.",
      context: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        meshCount: meshScene.meshes.length,
        primitiveCount: meshScene.primitives.length,
      },
    });
    logWarn("USD mesh scene contains meshes but none were attached; keeping fallback geometry.", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        meshCount: meshScene.meshes.length,
        primitiveCount: meshScene.primitives.length,
        bodyCount: meshScene.bodyCount,
      },
    });
  }
  if (meshAttach.attachedToRoot > 0 || meshAttach.aliasCollisionCount > 0) {
    importWarnings.push({
      code: "USD_IMPORT_HIERARCHY_FLATTEN_FALLBACK",
      message: "Some USD visuals could not be matched to a unique link lineage and were attached to root fallback containers.",
      context: {
        usdKey,
        attachedToRoot: meshAttach.attachedToRoot,
        aliasCollisionCount: meshAttach.aliasCollisionCount,
      },
    });
  }
  if (meshAttach.parentPoseWorldFallbacks > 0 || meshAttach.bodyFrameCorrections > 0) {
    importWarnings.push({
      code: "USD_IMPORT_FRAME_MISMATCH_FALLBACK",
      message: "Detected frame/pose mismatch in mesh attachment; applied compatibility rebasing to local link frames.",
      context: {
        usdKey,
        parentPoseWorldFallbacks: meshAttach.parentPoseWorldFallbacks,
        bodyFrameCorrections: meshAttach.bodyFrameCorrections,
      },
    });
  }
  if (meshAttach.unresolvedTextureBindings > 0) {
    importWarnings.push({
      code: "USD_IMPORT_OPTIONAL_MATERIAL_BINDING_MISSING",
      message: "Some USD material texture references were missing in the resolved bundle; fallback material bindings were used.",
      context: {
        usdKey,
        unresolvedTextureBindings: meshAttach.unresolvedTextureBindings,
        referencedTextures: meshAttach.referencedTextures,
        unresolvedTextureBindingsByChannel: meshAttach.unresolvedTextureBindingsByChannel,
      },
    });
  }
  if (meshAttach.attachedMeshes > 0 || meshAttach.attachedPrimitives > 0) {
    logInfo("USD mesh scene attached", {
      scope: "usd",
      data: {
        traceId,
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        attachedMeshes: meshAttach.attachedMeshes,
        attachedPrimitives: meshAttach.attachedPrimitives,
        bodyCount: meshScene?.bodyCount ?? 0,
        attachedToLinks: meshAttach.attachedToLinks,
        attachedToRoot: meshAttach.attachedToRoot,
        meshSceneTruncated: Boolean(meshScene?.truncated),
        materialsBound: Number(root.userData?.usdMeshScene?.materialsBound ?? 0),
        texturedMaterials: Number(root.userData?.usdMeshScene?.texturedMaterials ?? 0),
        unresolvedTextureBindings: Number(root.userData?.usdMeshScene?.unresolvedTextureBindings ?? 0),
        unresolvedTextureBindingsByChannel: root.userData?.usdMeshScene?.unresolvedTextureBindingsByChannel ?? null,
        aliasCollisionCount: Number(root.userData?.usdMeshScene?.aliasCollisionCount ?? 0),
        parentPoseWorldFallbacks: Number(root.userData?.usdMeshScene?.parentPoseWorldFallbacks ?? 0),
        bodyFrameCorrections: Number(root.userData?.usdMeshScene?.bodyFrameCorrections ?? 0),
      },
    });
  }
  const uniqueImportWarnings = Array.from(
    new Map(
      importWarnings.map((warning) => [
        `${warning.code}|${warning.message}|${JSON.stringify(warning.context ?? {})}`,
        warning,
      ])
    ).values()
  );
  const usdImportDebug = {
    traceId,
    debugTrace,
    posePolicy: variantImportHints?.posePolicy ?? "auto",
    referenceUsdKey: variantImportHints?.referenceUsdKey ?? null,
    hierarchySummary: {
      createdLinks: hierarchyAugment.createdLinks,
      createdJoints: hierarchyAugment.createdJoints,
      unresolvedBodies: hierarchyAugment.unresolvedBodies,
    },
    jointPoseSummary: jointPoseSummary
      ? {
          totalDecisions: jointPoseSummary.totalDecisions,
          framePairDecisions: jointPoseSummary.framePairDecisions,
          mjcfDecisions: jointPoseSummary.mjcfDecisions,
          fallbackCount: jointPoseSummary.fallbackCount,
          fallbackJoints: jointPoseSummary.fallbackJoints,
        }
      : null,
    materialSummary: {
      materialsBound: meshAttach.materialsBound,
      texturedMaterials: meshAttach.texturedMaterials,
      referencedTextures: meshAttach.referencedTextures,
      unresolvedTextureBindings: meshAttach.unresolvedTextureBindings,
      unresolvedTextureBindingsByChannel: meshAttach.unresolvedTextureBindingsByChannel,
    },
    ...(debugTraceDetailed
      ? {
          jointPoseDetails: jointPoseSummary?.decisions ?? [],
          materialTraceEntries: meshAttach.materialTraceEntries,
        }
      : {}),
  };
  root.userData.usdImportDebug = usdImportDebug;

  if (importSceneRole === "scene_asset") {
    const sceneAssetRole = inferSceneAssetSourceRole(usdKey);
    const sceneAssetName = stripFileExtension(displayName) || displayName;
    const sceneAssetRoot = ensureSceneAssetRootHierarchy(root, {
      sceneAssetName,
      selfCollisionEnabled: importOptions?.selfCollision === true,
      sourceRole: sceneAssetRole,
    });
    const usesManagedDefaultFloor = sceneAssetRole === "terrain" && isDefaultFloorWorkspaceKey(usdKey);
    const usesManagedRoughFloor = sceneAssetRole === "terrain" && isManagedRoughFloorWorkspaceKey(usdKey);
    const grouping = groupSceneAssetLinksUnderContainers(sceneAssetRoot);
    let styledFloorMeshes = 0;
    if (usesManagedDefaultFloor) {
      styledFloorMeshes = applyDefaultFloorAppearanceToSceneAsset(sceneAssetRoot);
    } else if (usesManagedRoughFloor) {
      styledFloorMeshes = applyRoughFloorAppearanceToSceneAsset(sceneAssetRoot);
    }
    const sceneAssetMetadata: Record<string, unknown> = {
      importSceneRole,
      sceneAssetLinkContainers: grouping.containerCount,
      sceneAssetGroupedLinks: grouping.groupedLinks,
      importWarnings: uniqueImportWarnings,
    };
    if (usesManagedDefaultFloor) {
      sceneAssetMetadata.managedTerrainAssetId = "floor";
      sceneAssetMetadata.visualStyle = "default_floor";
      sceneAssetMetadata.styledMeshCount = styledFloorMeshes;
    } else if (usesManagedRoughFloor) {
      sceneAssetMetadata.managedTerrainAssetId = "floor:rough";
      sceneAssetMetadata.visualStyle = "rough_floor";
      sceneAssetMetadata.styledMeshCount = styledFloorMeshes;
    }
    retagUsdRootAsSceneAsset(sceneAssetRoot, sceneAssetName);
    applySceneAssetPhysicsDefaults(sceneAssetRoot, {
      forceRootCollider: meshAttach.attachedToRoot > 0 || (sceneAssetRoot.userData?.usdMeshScene?.bodyCount ?? 0) <= 0,
      sourceRole: sceneAssetRole,
      meshScene,
    });
    sceneAssetRoot.userData.usdUrl = usdUrl;
    sceneAssetRoot.userData.usdWorkspaceKey = usdKey;
    sceneAssetRoot.userData.usdImportWarnings = uniqueImportWarnings;
    sceneAssetRoot.userData.usdConverterDiagnostics = converterDiagnostics;
    sceneAssetRoot.userData.usdImportDebug = usdImportDebug;
    sceneAssetRoot.userData.sceneAssetSource = {
      kind: "usd",
      role: sceneAssetRole,
      workspaceKey: usdKey,
      converterAssetId: resolvedConverterAssetId ?? null,
      trainingAssetId: null,
      sourceUrl: usdUrl,
      importOptions: importOptions ? { ...importOptions } : null,
      metadata: sceneAssetMetadata,
    };
    if (resolvedConverterAssetId) sceneAssetRoot.userData.converterAssetId = resolvedConverterAssetId;
    if (resolvedMjcfAssetId) sceneAssetRoot.userData.mjcfAssetId = resolvedMjcfAssetId;
    if (mjcfXml) sceneAssetRoot.userData.mjcfSource = mjcfXml;
    if (mjcfBodiesPatchedFromMeshScene > 0) sceneAssetRoot.userData.mjcfBodyPosePatchCount = mjcfBodiesPatchedFromMeshScene;
    if (usesManagedDefaultFloor) {
      logInfo("USD default floor scene asset restyled to editor floor material", {
        scope: "usd",
        data: {
          usdKey,
          styledFloorMeshes,
          managedTerrainAssetId: "floor",
        },
      });
    } else if (usesManagedRoughFloor) {
      logInfo("USD rough floor scene asset restyled to editor rough-floor material", {
        scope: "usd",
        data: {
          usdKey,
          styledFloorMeshes,
          managedTerrainAssetId: "floor:rough",
        },
      });
    }
    logInfo("USD scene asset import completed", {
      scope: "usd",
      data: {
        usdKey,
        sceneAssetName: sceneAssetRoot.name,
        converterAssetId: resolvedConverterAssetId,
        attachedMeshes: meshAttach.attachedMeshes,
        attachedPrimitives: meshAttach.attachedPrimitives,
        usesManagedDefaultFloor,
        usesManagedRoughFloor,
        sceneAssetLinkContainers: grouping.containerCount,
        importWarningCount: uniqueImportWarnings.length,
      },
    });
    return sceneAssetRoot;
  }

  const modelSource: UsdModelSource = {
    kind: "usd",
    usdKey: resolvedConverterAssetId ?? usdKey,
    workspaceKey: usdKey,
    converterAssetId: resolvedConverterAssetId,
    trainingAssetId: null,
    // Keep the converted MJCF reference even when visual/collision sync is enabled.
    // MuJoCo runtime reload depends on this cached source for clean USD models.
    mjcfKey: resolvedMjcfAssetId,
    importOptions: {
      ...(importOptions ?? {}),
      floatingBase:
        typeof importOptions?.floatingBase === "boolean"
          ? importOptions.floatingBase
          : (detectedFloatingBase ?? false),
    },
    // Visual/collision sync is part of the default import pipeline and should not
    // mark the source as user-edited. Edits are tracked later via markSceneDirty.
    isDirty: false,
    importWarnings: uniqueImportWarnings,
  };

  root.userData.robotModelSource = modelSource;
  root.userData.usdUrl = usdUrl;
  root.userData.usdWorkspaceKey = usdKey;
  root.userData.usdImportWarnings = uniqueImportWarnings;
  root.userData.usdConverterDiagnostics = converterDiagnostics;
  if (resolvedConverterAssetId) root.userData.converterAssetId = resolvedConverterAssetId;
  if (resolvedMjcfAssetId) root.userData.mjcfAssetId = resolvedMjcfAssetId;
  if (mjcfXml) root.userData.mjcfSource = mjcfXml;
  if (mjcfBodiesPatchedFromMeshScene > 0) root.userData.mjcfBodyPosePatchCount = mjcfBodiesPatchedFromMeshScene;

  return root;
}

// ── loadWorkspaceUSDIntoViewer ──────────────────────────────────────────

export async function loadWorkspaceUSDIntoViewer(deps: USDImportDeps) {
  const {
    usdKey,
    assets,
    importOptions,
    bundleHintPaths,
    variantImportHints,
    rootName,
    sceneRole,
    frameOnAdd,
    skipPostLoadHook,
  } = deps;

  if (!usdKey) {
    logWarn("USD load requested but no USD selected.", { scope: "usd" });
    alert("No USD selected. Import a folder/files with a .usd file and select it.");
    return;
  }

  const entry = assets[usdKey];
  if (!entry) {
    logWarn("Selected USD not found in workspace.", { scope: "usd", data: { usdKey } });
    alert("Selected USD not found in workspace.");
    return;
  }

  logInfo(`USD load requested: ${usdKey}`, { scope: "usd" });
  const resolveResource = createAssetResolver(assets, usdKey);

  return await useLoaderStore.getState().load(
    "usd",
    {
      usdUrl: entry.url,
      usdKey,
      usdFile: entry.file,
      usdName: rootName?.trim() || basename(usdKey),
      sceneRole,
      resolveResource,
      assetsByKey: assets,
      importOptions,
      bundleHintPaths,
      variantImportHints,
    } satisfies USDLoaderParams,
    {
      name: rootName?.trim() || undefined,
      frame: frameOnAdd ?? true,
      skipPostLoadHook: skipPostLoadHook === true,
    }
  );
}
