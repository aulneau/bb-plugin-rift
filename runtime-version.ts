export function newerVersion(candidate: string, current: string) {
  const left = candidate.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
