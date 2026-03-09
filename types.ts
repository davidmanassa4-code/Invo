export interface FinancialAssumption {
  label: string;
  value: string | number;
  source: string;
  url: string;
}

export interface WACCInputs {
  riskFreeRate: number;
  beta: number;
  equityRiskPremium: number;
  costOfDebt: number;
  taxRate: number;
  equityWeight: number;
  debtWeight: number;
}

export interface MovingWACCYear {
  year: number;
  riskFreeRate: number;
  beta: number;
  equityRiskPremium: number;
  taxRate: number;
  equityWeight: number;
  debtWeight: number;
  costOfDebt: number;
}

export interface SensitivityInputs {
  targetVariable: string;
  rowVariable: string;
  colVariable: string;
  baseValueRow: number;
  baseValueCol: number;
  incrementRow: number;
  incrementCol: number;
  targetUnit: string;
  baseTargetValue: number;
}
