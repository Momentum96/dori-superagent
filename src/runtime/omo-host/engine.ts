export type HostEngine = "omo" | "mhc";

export const isHostEngine = (value: unknown): value is HostEngine => value === "omo" || value === "mhc";

export const hostBinary = (
  engine: HostEngine,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  switch (engine) {
    case "omo":
      return "omo";
    case "mhc":
      return env["DORI_MHC_BIN"] || "mhc";
  }
};
