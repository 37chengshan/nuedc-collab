const GEOMETRY_EPSILON = 1e-3;

const square = (value) => value * value;

export function distanceBetween(left, right) {
  return Math.hypot(right.xMm - left.xMm, right.yMm - left.yMm);
}

export function solveThreeAnchors(anchors, distancesMm) {
  if (!hasValidInputs(anchors, distancesMm, 3)) {
    return invalidResult();
  }

  const a11 = 2 * (anchors[1].xMm - anchors[0].xMm);
  const a12 = 2 * (anchors[1].yMm - anchors[0].yMm);
  const a21 = 2 * (anchors[2].xMm - anchors[0].xMm);
  const a22 = 2 * (anchors[2].yMm - anchors[0].yMm);
  const b1 =
    square(distancesMm[0]) -
    square(distancesMm[1]) -
    square(anchors[0].xMm) +
    square(anchors[1].xMm) -
    square(anchors[0].yMm) +
    square(anchors[1].yMm);
  const b2 =
    square(distancesMm[0]) -
    square(distancesMm[2]) -
    square(anchors[0].xMm) +
    square(anchors[2].xMm) -
    square(anchors[0].yMm) +
    square(anchors[2].yMm);
  const determinant = a11 * a22 - a12 * a21;

  if (Math.abs(determinant) < GEOMETRY_EPSILON) {
    return invalidResult();
  }

  const point = {
    xMm: (b1 * a22 - a12 * b2) / determinant,
    yMm: (a11 * b2 - b1 * a21) / determinant,
  };
  return validResult(anchors, distancesMm, point);
}

export function solveTwoAnchors(anchors, distancesMm, hint = null) {
  if (!hasValidInputs(anchors, distancesMm, 2)) {
    return invalidResult();
  }

  const dx = anchors[1].xMm - anchors[0].xMm;
  const dy = anchors[1].yMm - anchors[0].yMm;
  const baselineMm = Math.hypot(dx, dy);
  if (baselineMm < GEOMETRY_EPSILON) {
    return invalidResult();
  }

  const alongMm =
    (square(distancesMm[0]) -
      square(distancesMm[1]) +
      square(baselineMm)) /
    (2 * baselineMm);
  const heightMm = Math.sqrt(
    Math.max(0, square(distancesMm[0]) - square(alongMm)),
  );
  const midpoint = {
    xMm: anchors[0].xMm + (alongMm * dx) / baselineMm,
    yMm: anchors[0].yMm + (alongMm * dy) / baselineMm,
  };
  const candidateA = {
    xMm: midpoint.xMm - (heightMm * dy) / baselineMm,
    yMm: midpoint.yMm + (heightMm * dx) / baselineMm,
  };
  const candidateB = {
    xMm: midpoint.xMm + (heightMm * dy) / baselineMm,
    yMm: midpoint.yMm - (heightMm * dx) / baselineMm,
  };

  let point;
  if (hint && Number.isFinite(hint.xMm) && Number.isFinite(hint.yMm)) {
    point =
      squaredPointDistance(candidateA, hint) <=
      squaredPointDistance(candidateB, hint)
        ? candidateA
        : candidateB;
  } else {
    point = candidateA.yMm >= candidateB.yMm ? candidateA : candidateB;
  }

  return validResult(anchors, distancesMm, point);
}

function validResult(anchors, distancesMm, point) {
  return {
    valid: true,
    point,
    residualMm: residualRms(anchors, distancesMm, point),
  };
}

function invalidResult() {
  return {
    valid: false,
    point: null,
    residualMm: Number.POSITIVE_INFINITY,
  };
}

function residualRms(anchors, distancesMm, point) {
  const sumSquares = anchors.reduce((sum, anchor, index) => {
    const error = distanceBetween(anchor, point) - distancesMm[index];
    return sum + square(error);
  }, 0);
  return Math.sqrt(sumSquares / anchors.length);
}

function squaredPointDistance(left, right) {
  return square(left.xMm - right.xMm) + square(left.yMm - right.yMm);
}

function hasValidInputs(anchors, distancesMm, count) {
  return (
    Array.isArray(anchors) &&
    Array.isArray(distancesMm) &&
    anchors.length === count &&
    distancesMm.length === count &&
    anchors.every(
      (anchor) => Number.isFinite(anchor.xMm) && Number.isFinite(anchor.yMm),
    ) &&
    distancesMm.every(
      (distanceMm) => Number.isFinite(distanceMm) && distanceMm >= 0,
    )
  );
}
