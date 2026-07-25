import { acquireLease, leaseIsExpired, synchronizeLease } from "./lease.mjs";
import {
  computeHookSettingsInventory,
  computeRuntimeBundle,
} from "./runtime-attestation.mjs";

const ATTESTATION_TTL_MS = 30 * 60 * 1000;

export async function refreshSessionLiveness(
  authority,
  {
    sessionId,
    projectRoot,
    pluginRoot,
    pluginVersion,
    userHome = null,
  },
) {
  const attestationRecord = await authority.readSigned(
    "attestations/hooks.json",
    { required: false },
  );
  if (
    !attestationRecord ||
    attestationRecord.payload.status !== "active" ||
    attestationRecord.payload.sessionId !== sessionId
  ) {
    return { refreshed: false, reason: "session is not the active attestation" };
  }
  const [runtimeBundle, settings] = await Promise.all([
    computeRuntimeBundle({ pluginRoot, pluginVersion }),
    computeHookSettingsInventory({ projectRoot, userHome }),
  ]);
  if (
    runtimeBundle.digest !== attestationRecord.payload.runtimeBundleDigest ||
    settings.digest !== attestationRecord.payload.settingsDigest ||
    settings.valid !== true ||
    settings.disableAllHooks === true ||
    settings.unknownSideEffectingHooks !== false
  ) {
    return { refreshed: false, reason: "runtime/settings attestation changed" };
  }
  const now = new Date().toISOString();
  const attestation = {
    ...attestationRecord.payload,
    refreshedAt: now,
    expiresAt: new Date(Date.parse(now) + ATTESTATION_TTL_MS).toISOString(),
    sequence: attestationRecord.payload.sequence + 1,
  };
  await authority.writeSigned("attestations/hooks.json", attestation, {
    expectedSequence: attestationRecord.payload.sequence,
  });
  const leaseRecord = await authority.readSigned("lease/current.json", {
    required: false,
  });
  if (
    !leaseRecord ||
    leaseRecord.payload.status !== "active" ||
    leaseRecord.payload.sessionId !== sessionId
  ) {
    return { refreshed: true, lease: null };
  }
  const state = (await authority.readSigned("state/current.json")).payload;
  const lease = leaseIsExpired(leaseRecord.payload)
    ? await acquireLease(authority, {
        sessionId,
        taskId: state.taskId ?? "__onboarding__",
        phase: state.phase,
      })
    : await synchronizeLease(authority, {
        sessionId,
        taskId: state.taskId ?? "__onboarding__",
        phase: state.phase,
      });
  return {
    refreshed: true,
    lease,
    leaseRotated: lease.leaseId !== leaseRecord.payload.leaseId,
  };
}
