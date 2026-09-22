export const QUOTAS = {
  FREE: { maxBots: 1, historyDays: 30 },
  PERSONAL: { maxBots: 3, historyDays: 90 },
  PRO: { maxBots: 10, historyDays: 180 },
  ENTERPRISE: { maxBots: 50, historyDays: 0 } // 0 means unlimited
};

export function getQuota(plan) {
  return QUOTAS[plan] || QUOTAS.FREE;
}
