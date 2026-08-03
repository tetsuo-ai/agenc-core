import { APPLY_PATCH_CONTROL_CHECK_INTERVAL } from "./limits.js";
import { ApplyPatchRuntimeError } from "./types.js";

export interface ApplyPatchControl {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export function assertApplyPatchActive(
  control: ApplyPatchControl | undefined,
  stage: string,
): void {
  if (control?.signal?.aborted === true) {
    throw new ApplyPatchRuntimeError(`apply_patch was aborted during ${stage}`);
  }
  if (control?.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
    throw new ApplyPatchRuntimeError(
      `apply_patch deadline expired during ${stage}`,
    );
  }
}

export function periodicallyAssertApplyPatchActive(
  control: ApplyPatchControl | undefined,
  completedUnits: number,
  stage: string,
): void {
  if (completedUnits % APPLY_PATCH_CONTROL_CHECK_INTERVAL === 0) {
    assertApplyPatchActive(control, stage);
  }
}
