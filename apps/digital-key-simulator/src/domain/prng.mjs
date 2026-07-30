export function createDeterministicPrng(seed = 1) {
  let state = normalizeSeed(seed);
  let spareNormal = null;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (mean = 0, standardDeviation = 1) => {
    if (!Number.isFinite(standardDeviation) || standardDeviation < 0) {
      throw new RangeError("standardDeviation must be non-negative");
    }
    if (standardDeviation === 0) {
      return mean;
    }
    if (spareNormal !== null) {
      const value = spareNormal;
      spareNormal = null;
      return mean + value * standardDeviation;
    }

    let first;
    let second;
    let radiusSquared;
    do {
      first = next() * 2 - 1;
      second = next() * 2 - 1;
      radiusSquared = first * first + second * second;
    } while (radiusSquared === 0 || radiusSquared >= 1);

    const multiplier = Math.sqrt((-2 * Math.log(radiusSquared)) / radiusSquared);
    spareNormal = second * multiplier;
    return mean + first * multiplier * standardDeviation;
  };

  return {
    next,
    normal,
  };
}

function normalizeSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
