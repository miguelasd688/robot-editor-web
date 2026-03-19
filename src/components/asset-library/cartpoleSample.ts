import {
  buildLibrarySampleEntryKey,
  findLibrarySampleKey,
  getLibrarySampleById,
  type LibrarySample,
} from "./librarySamples";

const CARTPOLE_SAMPLE_ID = "cartpole";

const FALLBACK_SAMPLE: LibrarySample = {
  id: CARTPOLE_SAMPLE_ID,
  section: "robots",
  label: "Cartpole Sample",
  description: "Cartpole URDF sample.",
  kind: "urdf",
  entry: "Cartpole_robot.urdf",
  files: ["Cartpole_robot.urdf"],
  bundlePath: "library/robots/cartpole/bundle.json",
  badge: "URDF",
  preview: {
    top: "rgba(101, 148, 117, 0.55)",
    bottom: "rgba(38, 74, 57, 0.9)",
    caption: "CARTPOLE",
  },
};

export const CARTPOLE_SAMPLE = getLibrarySampleById(CARTPOLE_SAMPLE_ID) ?? FALLBACK_SAMPLE;
export const CARTPOLE_SAMPLE_NAME = CARTPOLE_SAMPLE.entry;
export const CARTPOLE_SAMPLE_KEY = buildLibrarySampleEntryKey(CARTPOLE_SAMPLE);

export function findCartpoleSampleKey(keys: string[]) {
  const found = findLibrarySampleKey(keys, CARTPOLE_SAMPLE);
  if (found) return found;
  return (
    keys.find((key) => key.endsWith(`/${CARTPOLE_SAMPLE_NAME}`)) ??
    keys.find((key) => key === CARTPOLE_SAMPLE_NAME) ??
    null
  );
}
