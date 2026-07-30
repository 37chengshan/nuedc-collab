export class ZoneStateMachine {
  constructor({
    unlockEnterMm = 1000,
    unlockLeaveMm = 1050,
    welcomeEnterMm = 2000,
    welcomeLeaveMm = 2050,
    confirmationFrames = 3,
  } = {}) {
    this.thresholds = {
      unlockEnterMm,
      unlockLeaveMm,
      welcomeEnterMm,
      welcomeLeaveMm,
    };
    this.confirmationFrames = Math.max(1, Math.trunc(confirmationFrames));
    this.state = "LOCKED";
    this.pendingState = null;
    this.pendingCount = 0;
  }

  update(input = {}) {
    const positionValid = input.positionValid ?? input.valid ?? false;
    const idValid = input.idValid ?? false;
    const modelValid = input.modelValid ?? false;
    const radialMm = Number(
      input.boundaryDistanceMm ?? input.radialMm ?? Number.NaN,
    );
    if (
      !positionValid ||
      !idValid ||
      !modelValid ||
      !Number.isFinite(radialMm)
    ) {
      this.state = "LOCKED";
      this.pendingState = null;
      this.pendingCount = 0;
      return this.#snapshot("invalid-input");
    }

    const desired = this.#desiredState(radialMm);
    if (desired === this.state) {
      this.pendingState = null;
      this.pendingCount = 0;
      return this.#snapshot("stable");
    }
    if (this.pendingState === desired) {
      this.pendingCount += 1;
    } else {
      this.pendingState = desired;
      this.pendingCount = 1;
    }
    if (this.pendingCount >= this.confirmationFrames) {
      this.state = desired;
      this.pendingState = null;
      this.pendingCount = 0;
      return this.#snapshot("confirmed");
    }
    return this.#snapshot("confirming");
  }

  #desiredState(radialMm) {
    const {
      unlockEnterMm,
      unlockLeaveMm,
      welcomeEnterMm,
      welcomeLeaveMm,
    } = this.thresholds;
    if (this.state === "UNLOCKED") {
      if (radialMm <= unlockLeaveMm) {
        return "UNLOCKED";
      }
      return radialMm <= welcomeLeaveMm ? "WELCOME" : "LOCKED";
    }
    if (this.state === "WELCOME") {
      if (radialMm <= unlockEnterMm) {
        return "UNLOCKED";
      }
      return radialMm <= welcomeLeaveMm ? "WELCOME" : "LOCKED";
    }
    if (radialMm <= unlockEnterMm) {
      return "UNLOCKED";
    }
    return radialMm <= welcomeEnterMm ? "WELCOME" : "LOCKED";
  }

  #snapshot(reason) {
    return {
      state: this.state,
      locked: this.state !== "UNLOCKED",
      welcome: this.state === "WELCOME",
      pendingState: this.pendingState,
      pendingCount: this.pendingCount,
      reason,
    };
  }
}
