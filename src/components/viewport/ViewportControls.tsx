import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import { pauseSimulation, playSimulation, reloadSimulation } from "./services/simulationService";
import { formatSignificant } from "../../app/ui/numberFormat";

export type UrdfDebugOptions = {
  showVisuals: boolean;
  showCollisions: boolean;
  showInertias: boolean;
  showCOM: boolean;
  showAxes: boolean;
  showJointAxes: boolean;
};

type ViewportControlsProps = {
  onDebugChange?: (options: UrdfDebugOptions) => void;
};

export default function ViewportControls({ onDebugChange }: ViewportControlsProps) {
  const simState = useAppStore((s) => s.simState);

  const noiseRate = useMujocoStore((s) => s.noiseRate);
  const noiseScale = useMujocoStore((s) => s.noiseScale);
  const pointerSpringStiffnessNPerM = useMujocoStore((s) => s.pointerSpringStiffnessNPerM);
  const pointerMaxForceN = useMujocoStore((s) => s.pointerMaxForceN);
  const setNoiseRate = useMujocoStore((s) => s.setNoiseRate);
  const setNoiseScale = useMujocoStore((s) => s.setNoiseScale);
  const setPointerSpringStiffnessNPerM = useMujocoStore((s) => s.setPointerSpringStiffnessNPerM);
  const setPointerMaxForceN = useMujocoStore((s) => s.setPointerMaxForceN);
  const isReady = useMujocoStore((s) => s.isReady);
  const isLoading = useMujocoStore((s) => s.isLoading);
  const isDirty = useMujocoStore((s) => s.isDirty);
  const lastError = useMujocoStore((s) => s.lastError);

  const [controlsOpen, setControlsOpen] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [robotDebugOpen, setRobotDebugOpen] = useState(true);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [userInputsOpen, setUserInputsOpen] = useState(false);
  const [debugOptions, setDebugOptions] = useState<UrdfDebugOptions>({
    showVisuals: true,
    showCollisions: false,
    showInertias: false,
    showCOM: false,
    showAxes: false,
    showJointAxes: false,
  });

  useEffect(() => {
    onDebugChange?.(debugOptions);
  }, [debugOptions, onDebugChange]);

  const isPlaying = simState === "playing";
  const showPlayActive = isPlaying;
  const showPauseActive = userPaused && simState === "paused" && isReady && !isLoading && !isDirty;

  useEffect(() => {
    if (isLoading) setUserPaused(false);
  }, [isLoading]);

  useEffect(() => {
    if (simState === "playing") setUserPaused(false);
  }, [simState]);

  const mujocoStatusText = (() => {
    if (isLoading) return "Loading MuJoCo...";
    if (isReady && isDirty) return "MuJoCo dirty";
    if (isReady) return "MuJoCo ready";
    return null;
  })();

  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        right: 10,
        width: "min(240px, calc(100% - 20px))",
        ...(controlsOpen ? { bottom: 10 } : { maxHeight: "calc(100% - 20px)" }),
        display: "flex",
        flexDirection: "column",
        borderRadius: 10,
        background: "rgba(8,12,18,0.9)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.85)",
        fontSize: 12,
        boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
        overflow: "hidden",
      }}
      >
        <button
          onClick={() => setControlsOpen((v) => !v)}
          style={{
            width: "100%",
          height: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px",
          border: "none",
          background: "rgba(255,255,255,0.02)",
          color: "rgba(255,255,255,0.9)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
        }}
        title="Controls"
      >
        Controls
        <span style={{ opacity: 0.7 }}>{controlsOpen ? "▾" : "▸"}</span>
      </button>

      <div style={{ padding: "10px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setUserPaused(false);
              void playSimulation();
            }}
            disabled={isPlaying || isLoading}
            style={controlPill({ disabled: isPlaying || isLoading, tone: "green", active: showPlayActive })}
          >
            ▶ Play
          </button>
          <button
            onClick={() => {
              setUserPaused(true);
              pauseSimulation();
            }}
            disabled={simState !== "playing"}
            style={controlPill({ disabled: simState !== "playing", tone: "red", active: showPauseActive })}
          >
            ⏸ Pause
          </button>
          <button
            onClick={() => {
              setUserPaused(false);
              void reloadSimulation();
            }}
            disabled={isLoading}
            style={controlPill({ disabled: isLoading })}
          >
            ⟲ Reload
          </button>
        </div>
        {mujocoStatusText && <div style={{ marginTop: 8, opacity: 0.7, fontSize: 11 }}>{mujocoStatusText}</div>}
        {lastError && (
          <div style={{ marginTop: 8, color: "rgba(255,120,120,0.9)", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {lastError}
          </div>
        )}
      </div>

      {controlsOpen && (
        <div
          className="viewport-controls-scroll"
          onWheel={(e) => e.stopPropagation()}
          style={{
            padding: "0 0 12px",
            display: "flex",
            flexDirection: "column",
            gap: 0,
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
            flex: 1,
            minHeight: 0,
          }}
        >
          <Section title="ROBOT DEBUG" open={robotDebugOpen} onToggle={() => setRobotDebugOpen((v) => !v)}>
            <div style={{ display: "grid", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showVisuals}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showVisuals: e.target.checked }))}
                />
                Visuals
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showCollisions}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showCollisions: e.target.checked }))}
                />
                Collisions
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showInertias}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showInertias: e.target.checked }))}
                />
                Inertias
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showCOM}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showCOM: e.target.checked }))}
                />
                COM
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showAxes}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showAxes: e.target.checked }))}
                />
                Link axes
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={debugOptions.showJointAxes}
                  onChange={(e) => setDebugOptions((s) => ({ ...s, showJointAxes: e.target.checked }))}
                />
                Joint axes
              </label>
            </div>
          </Section>

          <Section title="SIMULATION" open={simulationOpen} onToggle={() => setSimulationOpen((v) => !v)}>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Noise rate</span>
                  <span style={{ opacity: 0.7, flexShrink: 0 }}>{formatSignificant(noiseRate)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.05}
                  value={noiseRate}
                  onChange={(e) => setNoiseRate(Number(e.target.value))}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Noise scale</span>
                  <span style={{ opacity: 0.7, flexShrink: 0 }}>{formatSignificant(noiseScale)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={noiseScale}
                  onChange={(e) => setNoiseScale(Number(e.target.value))}
                />
              </label>
            </div>
          </Section>

          <Section title="USER INPUTS" open={userInputsOpen} onToggle={() => setUserInputsOpen((v) => !v)}>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Pointer spring k</span>
                  <span style={{ opacity: 0.7, flexShrink: 0 }}>
                    {formatSignificant(pointerSpringStiffnessNPerM)} N/m
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={10}
                  value={pointerSpringStiffnessNPerM}
                  onChange={(e) => setPointerSpringStiffnessNPerM(Number(e.target.value))}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Pointer max force</span>
                  <span style={{ opacity: 0.7, flexShrink: 0 }}>{formatSignificant(pointerMaxForceN)} N</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={10}
                  value={pointerMaxForceN}
                  onChange={(e) => setPointerMaxForceN(Number(e.target.value))}
                />
              </label>
            </div>

            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 11 }}>
              Alt + drag en playing: fuerza tipo muelle F = k * x, limitada por Fmax.
            </div>
          </Section>

          <style>{`
            .viewport-controls-scroll {
              scrollbar-width: thin;
              scrollbar-color: rgba(255,255,255,0.36) rgba(255,255,255,0.04);
            }
            .viewport-controls-scroll::-webkit-scrollbar {
              width: 10px;
            }
            .viewport-controls-scroll::-webkit-scrollbar-thumb {
              background: rgba(255,255,255,0.28);
              border-radius: 999px;
              border: 2px solid rgba(8,12,18,0.9);
            }
            .viewport-controls-scroll::-webkit-scrollbar-thumb:hover {
              background: rgba(255,255,255,0.36);
            }
            .viewport-controls-scroll::-webkit-scrollbar-track {
              background: rgba(255,255,255,0.04);
              border-radius: 999px;
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

function Section(props: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const { title, open, onToggle, children } = props;
  return (
    <div
      style={{
        width: "100%",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          border: "none",
          background: "rgba(255,255,255,0.04)",
          color: "rgba(255,255,255,0.86)",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
        }}
      >
        <span style={{ opacity: 0.78 }}>{title}</span>
        <span style={{ opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div style={{ padding: "10px 12px 12px" }}>{children}</div>}
    </div>
  );
}

type PillTone = "neutral" | "green" | "red" | "blue" | "orange";
function controlPill(opts: { disabled?: boolean; tone?: PillTone; active?: boolean; asButton?: boolean }): React.CSSProperties {
  const { disabled = false, tone = "neutral", active = false, asButton = true } = opts;
  const isInteractive = asButton && !disabled;

  const toneStyles: Record<PillTone, { border: string; bg: string; fg: string; glow?: string }> = {
    neutral: {
      border: "rgba(255,255,255,0.10)",
      bg: disabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)",
      fg: "rgba(255,255,255,0.92)",
    },
    green: {
      border: active ? "rgba(60,200,110,0.55)" : "rgba(255,255,255,0.10)",
      bg: active ? "rgba(60,200,110,0.22)" : disabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)",
      fg: active ? "rgba(235,255,244,0.96)" : "rgba(255,255,255,0.92)",
      glow: active ? "0 0 0 1px rgba(60,200,110,0.14), 0 8px 18px rgba(0,0,0,0.25)" : undefined,
    },
    red: {
      border: active ? "rgba(255,90,90,0.55)" : "rgba(255,255,255,0.10)",
      bg: active ? "rgba(255,90,90,0.20)" : disabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)",
      fg: active ? "rgba(255,235,235,0.96)" : "rgba(255,255,255,0.92)",
      glow: active ? "0 0 0 1px rgba(255,90,90,0.12), 0 8px 18px rgba(0,0,0,0.25)" : undefined,
    },
    blue: {
      border: "rgba(80,160,255,0.45)",
      bg: "rgba(80,160,255,0.18)",
      fg: "rgba(232,245,255,0.96)",
      glow: "0 0 0 1px rgba(80,160,255,0.10), 0 8px 18px rgba(0,0,0,0.25)",
    },
    orange: {
      border: "rgba(255,180,80,0.46)",
      bg: "rgba(255,180,80,0.18)",
      fg: "rgba(255,244,232,0.96)",
      glow: "0 0 0 1px rgba(255,180,80,0.10), 0 8px 18px rgba(0,0,0,0.25)",
    },
  };

  const theme = toneStyles[tone];
  return {
    minHeight: 26,
    padding: "0 8px",
    borderRadius: 8,
    border: `1px solid ${theme.border}`,
    background: theme.bg,
    color: theme.fg,
    cursor: isInteractive ? "pointer" : disabled && asButton ? "not-allowed" : "default",
    fontSize: 12,
    whiteSpace: "normal",
    lineHeight: 1.2,
    display: "inline-flex",
    alignItems: "center",
    userSelect: "none",
    boxShadow: theme.glow,
    opacity: !active && disabled ? 0.72 : 1,
  };
}
