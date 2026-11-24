export type DeliveryScope = {
  workspaceDir: string;
  sessionKey: string;
};

export type DeliveryContext = DeliveryScope & {
  harness: string;
  deliverEverySec: number;
  timeBudgetSec: number;
  minWorkingSec: number;
  minReleases: number;
  model: string;
  channels: boolean;
  requirePlanApproval?: boolean;
  planMode?: 'fixed' | 'rolling';
};
