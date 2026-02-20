import { useAppStore } from "../../../app/core/store/useAppStore";
import { useMujocoStore } from "../../../app/core/store/useMujocoStore";
import { logInfo, logWarn } from "../../../app/core/services/logger";

async function ensureMujocoReady() {
  const mujoco = useMujocoStore.getState();
  if ((!mujoco.isReady || mujoco.isDirty) && !mujoco.isLoading) {
    await mujoco.reload();
  }
  return useMujocoStore.getState().isReady;
}

export async function playSimulation() {
  logInfo("Simulation: play requested", { scope: "sim" });
  const ready = await ensureMujocoReady();
  if (ready) {
    useAppStore.getState().play();
    logInfo("Simulation: playing", { scope: "sim" });
  } else {
    logWarn("Simulation: play skipped (not ready)", { scope: "sim" });
  }
}

export function pauseSimulation() {
  useMujocoStore.getState().captureCurrentPoseAsTargets();
  useAppStore.getState().pause();
  logInfo("Simulation: paused", { scope: "sim" });
}

export async function reloadSimulation() {
  logInfo("Simulation: reload requested", { scope: "sim" });
  useAppStore.getState().pause();
  await useMujocoStore.getState().reload();
}

export function tickSimulation(dt: number) {
  const { simState, isTransformDragging } = useAppStore.getState();
  if (simState === "playing") {
    useMujocoStore.getState().tick(dt);
    return;
  }
  if (simState === "paused") {
    if (isTransformDragging) return;
    useMujocoStore.getState().preview();
  }
}
