// The fixed, company-wide post-contract onboarding checklist. A code constant on purpose: no DB
// table, no admin UI. Seeding (onboarding-seed.ts) copies these rows onto an Account the first
// time it becomes ACTIVE; OnboardingStep.templateKey stores `key`.

// Step 1 is CONDITIONAL. It is always seeded, but whether it applies is DERIVED at read time from
// Account.takesOnlinePayments (false => "not applicable" and excluded from progress), so changing
// the flag later can never leave a stale row behind.
export const PAYMENT_STEP_KEY = "PAYMENT_PROVIDER_CONTRACT";

export type OnboardingTemplateStep = { key: string; title: string };

export const ONBOARDING_TEMPLATE: readonly OnboardingTemplateStep[] = [
  {
    key: PAYMENT_STEP_KEY,
    title: "Sign contract between building and payment-processing provider",
  },
  {
    key: "COLLECT_BUILDING_DATA",
    title: "Collect building data: apartments, residents, parkings",
  },
  {
    key: "ENTER_ADMIN_DATA",
    title: "Enter the building's data into the admin dashboard",
  },
  {
    key: "TRAIN_MANAGERS",
    title: "Onboard and train the building managers on the platform",
  },
  {
    key: "RESIDENT_SMS",
    title: "Send informational SMS to residents' mobile numbers",
  },
  {
    key: "WHATSAPP_VIDEO",
    title: "Send the onboarding video to residents on WhatsApp",
  },
];

/** True when a step with this key counts toward progress for the given flag value. */
export function isStepApplicable(
  templateKey: string | null,
  takesOnlinePayments: boolean | null,
): boolean {
  return !(templateKey === PAYMENT_STEP_KEY && takesOnlinePayments === false);
}
