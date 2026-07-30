import { clamp, finiteNumber } from "./utils.js";

export class ConstantVelocityKalman {
  constructor({
    processNoise = 2,
    measurementNoise = 25,
    initialCovariance = 1000,
    maxDtSeconds = 1,
  } = {}) {
    this.processNoise = Math.max(0, finiteNumber(processNoise, "processNoise"));
    this.measurementNoise = Math.max(
      1e-6,
      finiteNumber(measurementNoise, "measurementNoise"),
    );
    this.initialCovariance = Math.max(
      1e-6,
      finiteNumber(initialCovariance, "initialCovariance"),
    );
    this.maxDtSeconds = Math.max(
      0.001,
      finiteNumber(maxDtSeconds, "maxDtSeconds"),
    );
    this.initialized = false;
    this.timestampMs = null;
    this.state = [0, 0, 0, 0];
    this.positionVariance = this.initialCovariance;
    this.velocityVariance = this.initialCovariance;
  }

  reset() {
    this.initialized = false;
    this.timestampMs = null;
    this.state = [0, 0, 0, 0];
    this.positionVariance = this.initialCovariance;
    this.velocityVariance = this.initialCovariance;
  }

  step(measurement = {}) {
    const timestampMs = finiteNumber(
      measurement.timestampMs,
      "measurement.timestampMs",
    );
    const measurementValid =
      measurement.valid !== false &&
      Number.isFinite(Number(measurement.xMm)) &&
      Number.isFinite(Number(measurement.yMm));

    if (!this.initialized) {
      if (!measurementValid) {
        return this.#snapshot(false);
      }
      this.state = [
        Number(measurement.xMm),
        Number(measurement.yMm),
        0,
        0,
      ];
      this.timestampMs = timestampMs;
      this.initialized = true;
      return this.#snapshot(true);
    }

    const dt = clamp(
      Math.max(0, timestampMs - this.timestampMs) / 1000,
      0,
      this.maxDtSeconds,
    );
    this.timestampMs = timestampMs;
    this.state[0] += this.state[2] * dt;
    this.state[1] += this.state[3] * dt;
    this.positionVariance +=
      this.velocityVariance * dt * dt + this.processNoise * (1 + dt * dt);
    this.velocityVariance += this.processNoise * Math.max(dt, 0.001);

    if (measurementValid) {
      const gain = clamp(
        this.positionVariance /
          (this.positionVariance + this.measurementNoise),
        0.05,
        0.95,
      );
      const velocityGain = clamp(gain * 0.35, 0.02, 0.45);
      const residualX = Number(measurement.xMm) - this.state[0];
      const residualY = Number(measurement.yMm) - this.state[1];
      this.state[0] += gain * residualX;
      this.state[1] += gain * residualY;
      if (dt > 1e-6) {
        this.state[2] += (velocityGain * residualX) / dt;
        this.state[3] += (velocityGain * residualY) / dt;
      }
      this.positionVariance *= 1 - gain;
    }

    return this.#snapshot(measurementValid);
  }

  #snapshot(measurementUsed) {
    return {
      initialized: this.initialized,
      xMm: this.initialized ? this.state[0] : null,
      yMm: this.initialized ? this.state[1] : null,
      vxMmPerSecond: this.initialized ? this.state[2] : null,
      vyMmPerSecond: this.initialized ? this.state[3] : null,
      state: [...this.state],
      timestampMs: this.timestampMs,
      measurementUsed,
    };
  }
}
