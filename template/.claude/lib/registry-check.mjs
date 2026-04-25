import './require-node.mjs';

/**
 * SemVer 2.0 comparison limited to the formats this scaffolder publishes:
 * `x.y.z` and `x.y.z-prerelease.N`. Returns -1, 0, or 1.
 *
 * Rules:
 *   - Compare major, minor, patch numerically.
 *   - A pre-release version is older than the same x.y.z without a tag.
 *   - Pre-release identifiers compare per-identifier; numeric identifiers
 *     compare numerically (so `beta.10 > beta.2`), non-numeric lexically.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const [aBase, aPre] = a.split('-', 2);
  const [bBase, bPre] = b.split('-', 2);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((aParts[i] || 0) < (bParts[i] || 0)) return -1;
    if ((aParts[i] || 0) > (bParts[i] || 0)) return 1;
  }
  if (!aPre && !bPre) return 0;
  if (!aPre && bPre)  return 1;
  if (aPre && !bPre)  return -1;
  const aIds = aPre.split('.');
  const bIds = bPre.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const ai = aIds[i];
    const bi = bIds[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = Number(ai), bn = Number(bi);
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else if (aNum && !bNum) {
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return 0;
}
