import { DigitalKeyAgentError } from "./errors.js";
import { clone } from "./json.js";

function defaultKeyState(options = {}) {
  return {
    active: options.active ?? true,
    keyAddress: options.keyAddress ?? 0x1113,
    xMm: options.xMm ?? 0,
    yMm: options.yMm ?? 2500,
    timeMs: options.timeMs ?? 0,
  };
}

function faultsForProfile(profile) {
  if (profile === "anchor") {
    return { disabledAnchors: [1] };
  }
  if (profile === "multipath") {
    return {
      distanceNoiseStdDevMm: [30, 45, 60],
      distanceBiasMm: [160, -90, 220],
    };
  }
  if (profile === "timeout") {
    return { disabledAnchors: [0, 1, 2] };
  }
  return {};
}

function adaptSimulator(simulator, module, options = {}) {
  let currentSimulator = simulator;
  let lifecycle = options.lifecycle ?? "paused";
  let expectedId = options.expectedId ?? 3;
  let faultProfile = options.faultProfile ?? "none";
  let key = defaultKeyState(options.key);
  let latestSnapshot = null;

  const rebuild = () => {
    const simulationOptions = options.simulationOptions ?? {};
    currentSimulator = module.createDigitalKeySimulator({
      ...simulationOptions,
      expectedId,
      faults: {
        ...(simulationOptions.faults ?? {}),
        ...faultsForProfile(faultProfile),
      },
    });
    latestSnapshot = null;
  };

  const step = (patch = {}) => {
    key = { ...key, ...patch };
    const nextTime = Number.isFinite(key.timeMs) ? key.timeMs : 0;
    key.timeMs = Math.max(nextTime, latestSnapshot?.truth?.timeMs ?? 0);
    const effectiveKey = { ...key };
    if (faultProfile === "id") {
      effectiveKey.keyAddress =
        (effectiveKey.keyAddress & 0xfff0) | ((expectedId + 1) & 0x0f);
    }
    if (faultProfile === "timeout") {
      effectiveKey.active = false;
    }
    latestSnapshot = currentSimulator.step(effectiveKey);
    return latestSnapshot;
  };

  const state = () => ({
    lifecycle,
    key: clone(key),
    expectedId,
    faultProfile,
    snapshot: clone(latestSnapshot),
  });

  return {
    async query(operation) {
      if (operation === "simulation.state.get") {
        return state();
      }
      if (operation === "lock.snapshot.get") {
        return clone(latestSnapshot?.estimate?.lock ?? {
          state: "locked",
          authorized: false,
          reason: "no-snapshot",
        });
      }
      throw new DigitalKeyAgentError(
        "OPERATION_NOT_ALLOWED",
        `仿真领域不支持查询：${operation}`,
        { status: 404, details: { operation } },
      );
    },

    async execute(operation, argumentsValue, context) {
      if (operation === "simulation.lifecycle.set") {
        if (argumentsValue.state === "reset") {
          lifecycle = "paused";
          key = defaultKeyState(options.key);
          rebuild();
        } else {
          lifecycle = argumentsValue.state;
          if (lifecycle === "running" && !latestSnapshot) {
            step();
          }
        }
        return state();
      }
      if (operation === "simulation.key.setPose") {
        return {
          ...state(),
          snapshot: clone(step(argumentsValue)),
        };
      }
      if (operation === "simulation.lock.setExpectedId") {
        expectedId = argumentsValue.expectedId;
        rebuild();
        return state();
      }
      if (operation === "simulation.faults.set") {
        faultProfile = argumentsValue.profile;
        rebuild();
        step();
        return state();
      }
      if (operation === "simulation.scenario.run") {
        context.emit("scenario.progress", {
          completed: 0,
          total: 1,
        });
        const result = module.runFixedSeedEntryScenario({
          ...argumentsValue,
          name: undefined,
        });
        latestSnapshot = result.samples.at(-1) ?? latestSnapshot;
        key = latestSnapshot
          ? {
              active: latestSnapshot.truth.active,
              keyAddress: latestSnapshot.truth.keyAddress,
              xMm: latestSnapshot.truth.xMm,
              yMm: latestSnapshot.truth.yMm,
              timeMs: latestSnapshot.truth.timeMs,
            }
          : key;
        lifecycle = "paused";
        context.emit("scenario.progress", {
          completed: 1,
          total: 1,
        });
        return {
          name: argumentsValue.name ?? "fixed-seed-entry",
          ...result,
        };
      }
      if (operation === "diagnostics.run.start") {
        context.emit("diagnostics.progress", {
          completed: 0,
          total: 1,
        });
        const result =
          typeof module.runDiagnostics === "function"
            ? await module.runDiagnostics({
                simulator: currentSimulator,
                state: state(),
                ...argumentsValue,
              })
            : {
                healthy: true,
                checks: {
                  simulatorAvailable: true,
                  snapshotAvailable: latestSnapshot !== null,
                  forcedUnlockAvailable: false,
                },
              };
        context.emit("diagnostics.progress", {
          completed: 1,
          total: 1,
        });
        return result;
      }
      throw new DigitalKeyAgentError(
        "OPERATION_NOT_ALLOWED",
        `仿真领域不支持命令：${operation}`,
        { status: 404, details: { operation } },
      );
    },
  };
}

export function createDomainResolver(options = {}) {
  let domainPromise;
  return async () => {
    if (!domainPromise) {
      domainPromise = (async () => {
        if (options.domain) {
          return options.domain;
        }
        if (typeof options.domainLoader === "function") {
          return options.domainLoader();
        }
        const module = await import("../domain/index.mjs");
        const simulator =
          options.simulation ??
          module.createDigitalKeySimulator({
            ...(options.simulationOptions ?? {}),
            expectedId: options.expectedId ?? 3,
          });
        return adaptSimulator(simulator, module, options);
      })();
    }
    return domainPromise;
  };
}
