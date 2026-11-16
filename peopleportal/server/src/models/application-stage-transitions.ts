import { ApplicationStage } from "./Application";

export const VALID_APPLICATION_STAGE_TRANSITIONS: Record<
    ApplicationStage,
    readonly ApplicationStage[]
> = {
    [ApplicationStage.APPLIED]: [
        ApplicationStage.INTERVIEW,
        ApplicationStage.REJECTED,
    ],
    [ApplicationStage.INTERVIEW]: [
        ApplicationStage.POTENTIAL_HIRE,
        ApplicationStage.HIRED,
        ApplicationStage.REJECTED,
    ],
    [ApplicationStage.POTENTIAL_HIRE]: [
        ApplicationStage.HIRED,
        ApplicationStage.REJECTED,
    ],
    [ApplicationStage.HIRED]: [],
    [ApplicationStage.REJECTED]: [],
};

export function isValidApplicationStageTransition(
    currentStage: ApplicationStage,
    newStage: ApplicationStage,
): boolean {
    return VALID_APPLICATION_STAGE_TRANSITIONS[currentStage]?.includes(
        newStage,
    );
}
