export const IMPACT_POSE_SECONDS = 0.26;

/** Immediate contact response with a small spring-back, ending at the original pose. */
export function impactPoseAt(seconds: number): number {
  if (!(seconds >= 0) || seconds >= IMPACT_POSE_SECONDS) return 0;
  return Math.exp(-seconds * 18) * Math.cos(seconds * 25);
}
