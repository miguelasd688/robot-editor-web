import { useAppStore } from "../core/store/useAppStore";
import { pauseSimulation, playSimulation, reloadSimulation } from "../../components/viewport/services/simulationService";

export default function SimToolbar() {
  const simState = useAppStore((s) => s.simState);

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        onClick={() => {
          void playSimulation();
        }}
        disabled={simState === "playing"}
        style={btnStyle(simState === "playing")}
      >
        ▶ Play
      </button>

      <button
        onClick={pauseSimulation}
        disabled={simState !== "playing"}
        style={btnStyle(simState !== "playing")}
      >
        ⏸ Pause
      </button>

      <button
        onClick={() => {
          void reloadSimulation();
        }}
        style={btnStyle(false)}
      >
        ⟲ Reset
      </button>
    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 30,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.10)",
    background: disabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)",
    color: "rgba(255,255,255,0.92)",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
