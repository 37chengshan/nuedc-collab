export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function medianAbsoluteDeviation(values, center = median(values)) {
  if (center === null) {
    return null;
  }
  return median(values.map((value) => Math.abs(value - center)));
}

export function roundTo(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有限数值`);
  }
  return number;
}

export function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [
    ...row.map(Number),
    Number(vector[index]),
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) {
      return null;
    }
    [augmented[column], augmented[pivot]] = [
      augmented[pivot],
      augmented[column],
    ];

    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) {
      augmented[column][index] /= divisor;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

export function weightedLeastSquares(rows, targets, weights) {
  if (rows.length === 0) {
    return null;
  }
  const width = rows[0].length;
  const normal = Array.from({ length: width }, () => Array(width).fill(0));
  const right = Array(width).fill(0);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const weight = weights?.[rowIndex] ?? 1;
    const row = rows[rowIndex];
    for (let left = 0; left < width; left += 1) {
      right[left] += weight * row[left] * targets[rowIndex];
      for (let top = 0; top < width; top += 1) {
        normal[left][top] += weight * row[left] * row[top];
      }
    }
  }
  return solveLinearSystem(normal, right);
}

export function squaredDistance(left, right) {
  const dx = left.xMm - right.xMm;
  const dy = left.yMm - right.yMm;
  return dx * dx + dy * dy;
}

export function deepClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
