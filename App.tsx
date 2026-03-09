import React, { useState } from 'react';
import { 
  Search, 
  FileSpreadsheet, 
  Calculator, 
  Layers, 
  Download,
  TrendingUp,
  ChevronRight,
  Loader2,
  ExternalLink,
  Sparkles
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as XLSX from 'xlsx';
import { financialSearch, generateAssumptions } from './services/gemini';
import type { FinancialAssumption, WACCInputs, MovingWACCYear } from './types';
import ReactMarkdown from 'react-markdown';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Tab = 'search' | 'assumptions' | 'wacc' | 'sensitivity';

const QUICK_PRESETS = [
  {
    id: "dcf", label: "DCF", icon: "💰",
    row: { name: "wacc", label: "WACC (%)", min: "8", max: "14" },
    col: { name: "tgr",  label: "Terminal Growth (%)", min: "1", max: "4" },
    output: "Equity Value / Share ($)",
    constants: "fcf1 = 100\ng = 5\nn = 5\nnetDebt = 200\nshares = 50\nsharePrice = 25",
    displayFormula: [
      { text: "Step 1 — PV of Free Cash Flows:", sub: true },
      { text: "PV(FCFs) = Σ  FCF₁ × (1 + g)^(t−1)  /  (1 + WACC)^t", bold: true },
      { text: "Step 2 — Terminal Value (Gordon Growth):", sub: true },
      { text: "TV = FCF_n × (1 + TGR)  /  (WACC − TGR)", bold: true },
      { text: "Step 3 — Equity Value per Share:", sub: true },
      { text: "Equity / Share = [ PV(FCFs) + TV / (1+WACC)^n − Net Debt ]  /  Shares", bold: true },
    ],
    _jsFormula: `(() => {
  const w=wacc/100, t=tgr/100, _g=g/100;
  if(w<=t) return null;
  let pv=0; for(let i=1;i<=n;i++) pv+=(fcf1*Math.pow(1+_g,i-1))/Math.pow(1+w,i);
  const tv=(fcf1*Math.pow(1+_g,n-1)*(1+t))/(w-t);
  return (pv+tv/Math.pow(1+w,n)-netDebt)/shares;
})()`,
  },
  {
    id: "wacc", label: "WACC", icon: "🧮",
    row: { name: "beta", label: "Beta (β)", min: "0.6", max: "1.6" },
    col: { name: "mrp",  label: "Market Risk Premium (%)", min: "3", max: "7" },
    output: "WACC (%)",
    constants: "rfr = 4.5\nrd = 6\ntax = 21\nE = 800\nD = 200",
    displayFormula: [
      { text: "WACC = (E/V) × Re  +  (D/V) × Rd × (1 − Tax)", bold: true },
      { text: "where:", sub: true },
      { text: "Re (Cost of Equity) = RFR  +  β × MRP", bold: true },
      { text: "Rd after-tax = Rd × (1 − Tax)", bold: true },
      { text: "V = E + D", bold: true },
    ],
    _jsFormula: `(() => {
  const V=E+D; if(!V) return null;
  return ((E/V)*(rfr/100+beta*mrp/100)+(D/V)*(rd/100)*(1-tax/100))*100;
})()`,
  },
  {
    id: "ebit", label: "Revenue", icon: "📈",
    row: { name: "growth", label: "Revenue Growth (%)", min: "2", max: "15" },
    col: { name: "margin", label: "EBIT Margin (%)", min: "8", max: "25" },
    output: "EBIT ($M)",
    constants: "baseRev = 500\nyears = 3",
    displayFormula: [
      { text: "Revenue = Base Revenue × (1 + Growth%)^Years", bold: true },
      { text: "EBIT = Revenue × EBIT Margin%", bold: true },
    ],
    _jsFormula: `baseRev * Math.pow(1+growth/100, years) * (margin/100)`,
  },
  {
    id: "lbo", label: "LBO / IRR", icon: "🏦",
    row: { name: "entry", label: "Entry EV/EBITDA (x)", min: "6", max: "12" },
    col: { name: "exit",  label: "Exit EV/EBITDA (x)", min: "7", max: "14" },
    output: "IRR (%)",
    constants: "ebitda = 100\ndebtPct = 60\ngrw = 8\nyrs = 5",
    displayFormula: [
      { text: "Entry EV = Entry Multiple × EBITDA", bold: true },
      { text: "Entry Equity = Entry EV × (1 − Debt%)", bold: true },
      { text: "Exit EV = Exit Multiple × EBITDA × (1 + g)^Years", bold: true },
      { text: "Exit Equity = Exit EV − Entry Debt", bold: true },
      { text: "IRR = (Exit Equity / Entry Equity)^(1/Years) − 1", bold: true },
    ],
    _jsFormula: `(() => {
  const ev0=entry*ebitda, eq0=ev0*(1-debtPct/100);
  const ev1=exit*ebitda*Math.pow(1+grw/100,yrs), eq1=ev1-ev0*(debtPct/100);
  if(eq0<=0||eq1<=0) return null;
  return (Math.pow(eq1/eq0,1/yrs)-1)*100;
})()`,
  },
  {
    id: "custom", label: "Custom", icon: "✏️",
    row: { name: "x", label: "Variable X", min: "1", max: "10" },
    col: { name: "y", label: "Variable Y", min: "1", max: "10" },
    output: "Output",
    constants: "a = 1",
    displayFormula: null,
    _jsFormula: `x * y * a`,
  },
];

function parseConstants(text: string) {
  const vars: Record<string, number> = {};
  (text || "").split("\n").forEach(line => {
    const [k, v] = line.split("=").map(s => s.trim());
    if (k && /^[a-zA-Z_]\w*$/.test(k) && v !== undefined) vars[k] = parseFloat(v) || 0;
  });
  return vars;
}

function evalSens(formula: string, vars: Record<string, number>) {
  try {
    const keys = Object.keys(vars), vals = keys.map(k => vars[k]);
    const r = new Function(...keys, '"use strict";return (' + formula + ');\n')(...vals);
    return typeof r === "number" && isFinite(r) ? r : null;
  } catch { return null; }
}

function linspace(mn: number, mx: number, n: number) {
  const s = Math.max(2, n);
  return Array.from({ length: s }, (_, i) => mn + (i / (s - 1)) * (mx - mn));
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedInstitution, setSelectedInstitution] = useState<string>('');
  const [searchResults, setSearchResults] = useState<{ text: string; sources: any[] } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Assumptions State
  const [assumptionInputs, setAssumptionInputs] = useState({ name: '', industry: '', country: '', period: '5 Years' });
  const [assumptions, setAssumptions] = useState<FinancialAssumption[]>([]);
  const [isGeneratingAssumptions, setIsGeneratingAssumptions] = useState(false);

  // WACC State
  const [waccType, setWaccType] = useState<'constant' | 'moving'>('constant');
  const [waccInputs, setWaccInputs] = useState<WACCInputs>({
    riskFreeRate: 4.5,
    beta: 1.1,
    equityRiskPremium: 5.0,
    costOfDebt: 6.0,
    taxRate: 25,
    equityWeight: 70,
    debtWeight: 30
  });

  const [movingWACCYears, setMovingWACCYears] = useState<MovingWACCYear[]>([
    { year: 1, riskFreeRate: 4.5, beta: 1.1, equityRiskPremium: 5.0, taxRate: 25, equityWeight: 70, debtWeight: 30, costOfDebt: 6.0 },
    { year: 2, riskFreeRate: 4.5, beta: 1.1, equityRiskPremium: 5.0, taxRate: 25, equityWeight: 75, debtWeight: 25, costOfDebt: 5.8 },
    { year: 3, riskFreeRate: 4.5, beta: 1.1, equityRiskPremium: 5.0, taxRate: 25, equityWeight: 80, debtWeight: 20, costOfDebt: 5.5 },
    { year: 4, riskFreeRate: 4.5, beta: 1.1, equityRiskPremium: 5.0, taxRate: 25, equityWeight: 85, debtWeight: 15, costOfDebt: 5.2 },
    { year: 5, riskFreeRate: 4.5, beta: 1.1, equityRiskPremium: 5.0, taxRate: 25, equityWeight: 90, debtWeight: 10, costOfDebt: 5.0 },
  ]);

  // Sensitivity State from snippet
  const [preset, setPreset] = useState<string | null>(null);
  const [rowLabel, setRowLabel] = useState("");
  const [rowName, setRowName] = useState("x");
  const [rowMin, setRowMin] = useState("");
  const [rowMax, setRowMax] = useState("");
  const [colLabel, setColLabel] = useState("");
  const [colName, setColName] = useState("y");
  const [colMin, setColMin] = useState("");
  const [colMax, setColMax] = useState("");
  const [outputLabel, setOutputLabel] = useState("");
  const [constants, setConstants] = useState("");
  const [formula, setFormula] = useState("");
  const [displayFormula, setDisplayFormula] = useState<any[] | null>(null);
  const [results, setResults] = useState<any>(null);
  const [sensitivityErr, setSensitivityErr] = useState("");

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const results = await financialSearch(searchQuery, selectedInstitution);
      if (!results.text) {
        setSearchError("The search returned no results. Please try a different query.");
      }
      setSearchResults(results);
    } catch (error: any) {
      console.error(error);
      setSearchError(error.message || "An error occurred while connecting to the financial intelligence engine.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleGenerateAssumptions = async () => {
    setIsGeneratingAssumptions(true);
    try {
      const data = await generateAssumptions(assumptionInputs.country, assumptionInputs.industry);
      setAssumptions(data);
    } catch (error) {
      console.error(error);
    } finally {
      setIsGeneratingAssumptions(false);
    }
  };

  const loadPreset = (p: any) => {
    setPreset(p.id);
    setRowLabel(p.row.label); setRowName(p.row.name);
    setRowMin(p.row.min);     setRowMax(p.row.max);
    setColLabel(p.col.label); setColName(p.col.name);
    setColMin(p.col.min);     setColMax(p.col.max);
    setOutputLabel(p.output); setConstants(p.constants);
    setFormula(p._jsFormula); setDisplayFormula(p.displayFormula);
    setResults(null); setSensitivityErr("");
  };

  const runSensitivity = () => {
    setSensitivityErr("");
    const rn = parseFloat(rowMin), rx = parseFloat(rowMax);
    const cn = parseFloat(colMin), cx = parseFloat(colMax);
    if (!rowName || !colName) return setSensitivityErr("Variable names are required.");
    if (isNaN(rn) || isNaN(rx) || isNaN(cn) || isNaN(cx)) return setSensitivityErr("Fill in Min and Max for both variables.");
    if (rn >= rx) return setSensitivityErr("Row Max must be greater than Row Min.");
    if (cn >= cx) return setSensitivityErr("Col Max must be greater than Col Min.");
    if (!formula.trim()) return setSensitivityErr("Enter a formula.");
    const fixed = parseConstants(constants);
    const rows = linspace(rn, rx, 7), cols = linspace(cn, cx, 7);
    const matrix = rows.map(rv => cols.map(cv =>
      evalSens(formula, { ...fixed, [rowName]: rv, [colName]: cv })
    ));
    const flat = matrix.flat().filter(v => v !== null);
    if (!flat.length) return setSensitivityErr("Formula returned no valid results. Check your formula and inputs.");
    setResults({ rows, cols, matrix, min: Math.min(...flat as number[]), max: Math.max(...flat as number[]) });
  };

  const fmtVal = (v: number | null) => {
    if (v === null || isNaN(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(2);
  };

  const fmtAxis = (v: number) => parseFloat(v.toPrecision(4)) + "";

  const cellStyle = (val: number | null, mn: number, mx: number) => {
    if (val === null) return { backgroundColor: "#1a2540", color: "#334155" };
    const t = mx === mn ? 0.5 : (val - mn) / (mx - mn);
    if (t >= 0.5) {
      const s = (t - 0.5) * 2;
      return { backgroundColor: `rgb(${Math.round(14 * (1 - s))},${Math.round(26 + s * 60)},${Math.round(12 * (1 - s))})`, color: t > 0.65 ? "#34d399" : "#86efac" };
    }
    const s = (0.5 - t) * 2;
    return { backgroundColor: `rgba(120,20,20,${0.12 + s * 0.5})`, color: t < 0.3 ? "#fca5a5" : "#fecaca" };
  };

  const downloadSensitivityExcel = () => {
    if (!results) return;
    const { rows, cols, matrix } = results;
    
    const data = rows.map((rv: number, ri: number) => {
      const row: any = { [rowLabel || rowName]: fmtAxis(rv) };
      cols.forEach((cv: number, ci: number) => {
        row[fmtAxis(cv)] = fmtVal(matrix[ri][ci]);
      });
      return row;
    });

    exportToExcel(data, 'Sensitivity_Analysis');
  };

  const exportToExcel = (data: any[], fileName: string) => {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `${fileName}.xlsx`);
  };

  const calculateWACC = (inputs: WACCInputs, movingYear?: MovingWACCYear) => {
    const rf = movingYear ? movingYear.riskFreeRate : inputs.riskFreeRate;
    const beta = movingYear ? movingYear.beta : inputs.beta;
    const erp = movingYear ? movingYear.equityRiskPremium : inputs.equityRiskPremium;
    const cod = movingYear ? movingYear.costOfDebt : inputs.costOfDebt;
    const tax = movingYear ? movingYear.taxRate : inputs.taxRate;
    const ew = movingYear ? movingYear.equityWeight : inputs.equityWeight;
    const dw = movingYear ? movingYear.debtWeight : inputs.debtWeight;

    const costOfEquity = rf + (beta * erp);
    const afterTaxCostOfDebt = cod * (1 - tax / 100);
    const totalWeight = ew + dw;
    const wacc = (costOfEquity * (ew / totalWeight)) + (afterTaxCostOfDebt * (dw / totalWeight));
    return wacc.toFixed(2);
  };

  return (
    <div className="flex h-screen bg-[#0A0A0A] text-[#E5E5E5] font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/10 flex flex-col bg-[#0F0F0F]">
        <div className="p-6 border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-500 rounded flex items-center justify-center">
              <TrendingUp className="text-black w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tighter text-white">INVO</h1>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 uppercase tracking-widest font-semibold">Financial Intelligence Engine</p>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <NavItem 
            active={activeTab === 'search'} 
            onClick={() => setActiveTab('search')} 
            icon={<Search size={18} />} 
            label="Research Terminal" 
          />
          <NavItem 
            active={activeTab === 'assumptions'} 
            onClick={() => setActiveTab('assumptions')} 
            icon={<FileSpreadsheet size={18} />} 
            label="Assumption Sheet" 
          />
          <NavItem 
            active={activeTab === 'wacc'} 
            onClick={() => setActiveTab('wacc')} 
            icon={<Calculator size={18} />} 
            label="WACC Modeler" 
          />
          <NavItem 
            active={activeTab === 'sensitivity'} 
            onClick={() => setActiveTab('sensitivity')} 
            icon={<Layers size={18} />} 
            label="Sensitivity Analysis" 
          />
        </nav>

        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500 text-xs font-bold">
              JD
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">Analyst Terminal</p>
              <p className="text-[10px] text-zinc-500 truncate">Pro Edition</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 border-b border-white/10 flex items-center justify-between px-8 bg-[#0F0F0F]">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Terminal</span>
            <ChevronRight size={12} />
            <span className="text-white capitalize">{activeTab}</span>
          </div>
          <div className="flex items-center gap-4">
            <button className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded text-zinc-300 transition-colors uppercase tracking-wider font-bold">
              System Status: Optimal
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'search' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="space-y-4">
                <h2 className="text-3xl font-bold tracking-tight text-white">Financial Research Terminal</h2>
                <p className="text-zinc-400 text-sm">Query global financial institutions with real-time grounding and direct citations.</p>
              </div>

              <form onSubmit={handleSearch} className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={20} />
                  <input 
                    type="text" 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search for GDP growth, inflation rates, risk premiums..." 
                    className="w-full bg-[#1A1A1A] border border-white/10 rounded-xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                </div>
                
                <div className="flex flex-wrap gap-2">
                  {['IMF', 'World Bank', 'Fitch Ratings', 'Moody’s', 'S&P Global', 'Central Banks'].map(inst => (
                    <button
                      key={inst}
                      type="button"
                      onClick={() => setSelectedInstitution(selectedInstitution === inst ? '' : inst)}
                      className={cn(
                        "text-[10px] px-3 py-1.5 rounded border transition-all uppercase tracking-wider font-bold",
                        selectedInstitution === inst 
                          ? "bg-emerald-500 border-emerald-500 text-black" 
                          : "bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10"
                      )}
                    >
                      {inst}
                    </button>
                  ))}
                </div>
                <button 
                  disabled={isSearching}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {isSearching ? <Loader2 className="animate-spin" size={20} /> : "Execute Semantic Search"}
                </button>
              </form>

              {searchError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                  <span className="text-lg">⚠️</span>
                  <p>{searchError}</p>
                </div>
              )}

              {searchResults && searchResults.text && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="p-6 bg-[#151515] border border-white/10 rounded-xl prose prose-invert max-w-none">
                    <ReactMarkdown>{searchResults.text}</ReactMarkdown>
                  </div>
                  
                  {searchResults.sources.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Verified Sources</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {searchResults.sources.map((source: any, i: number) => (
                          <a 
                            key={i}
                            href={source.web?.uri} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center justify-between p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors group"
                          >
                            <span className="text-xs text-zinc-300 truncate pr-4">{source.web?.title || 'Source Link'}</span>
                            <ExternalLink size={14} className="text-zinc-500 group-hover:text-emerald-500" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'assumptions' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h2 className="text-3xl font-bold tracking-tight text-white">Assumption Sheet Generator</h2>
                  <p className="text-zinc-400 text-sm">Automated macroeconomic and industry-specific forecasting inputs.</p>
                </div>
                {assumptions.length > 0 && (
                  <button 
                    onClick={() => exportToExcel(assumptions, 'Financial_Assumptions')}
                    className="flex items-center gap-2 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 px-4 py-2 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition-all"
                  >
                    <Download size={16} />
                    Export to Excel
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-[#151515] p-6 rounded-xl border border-white/10">
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Company / Project Name</label>
                  <input 
                    type="text" 
                    value={assumptionInputs.name}
                    onChange={e => setAssumptionInputs({...assumptionInputs, name: e.target.value})}
                    placeholder="e.g. Tesla Inc." 
                    className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Industry Sector</label>
                  <input 
                    type="text" 
                    value={assumptionInputs.industry}
                    onChange={e => setAssumptionInputs({...assumptionInputs, industry: e.target.value})}
                    placeholder="e.g. Automotive / Renewable Energy" 
                    className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Target Country</label>
                  <input 
                    type="text" 
                    value={assumptionInputs.country}
                    onChange={e => setAssumptionInputs({...assumptionInputs, country: e.target.value})}
                    placeholder="e.g. United States" 
                    className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Forecasting Period</label>
                  <select 
                    value={assumptionInputs.period}
                    onChange={e => setAssumptionInputs({...assumptionInputs, period: e.target.value})}
                    className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500/50"
                  >
                    <option>3 Years</option>
                    <option>5 Years</option>
                    <option>10 Years</option>
                  </select>
                </div>
                <button 
                  onClick={handleGenerateAssumptions}
                  disabled={isGeneratingAssumptions || !assumptionInputs.country || !assumptionInputs.industry}
                  className="md:col-span-2 bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isGeneratingAssumptions ? <Loader2 className="animate-spin" size={20} /> : "Generate Assumption Matrix"}
                </button>
              </div>

              {assumptions.length > 0 && (
                <div className="overflow-hidden border border-white/10 rounded-xl">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-[#1A1A1A] text-[10px] uppercase tracking-widest font-bold text-zinc-500">
                      <tr>
                        <th className="px-6 py-4">Assumption Variable</th>
                        <th className="px-6 py-4">Value</th>
                        <th className="px-6 py-4">Source</th>
                        <th className="px-6 py-4">Reference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 bg-[#151515]">
                      {assumptions.map((item, i) => (
                        <tr key={i} className="hover:bg-white/5 transition-colors">
                          <td className="px-6 py-4 font-medium text-white">{item.label}</td>
                          <td className="px-6 py-4 text-emerald-500 font-mono">{item.value}</td>
                          <td className="px-6 py-4 text-zinc-400">{item.source}</td>
                          <td className="px-6 py-4">
                            <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-emerald-500">
                              <ExternalLink size={14} />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'wacc' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h2 className="text-3xl font-bold tracking-tight text-white">WACC Modeler</h2>
                  <p className="text-zinc-400 text-sm">Weighted Average Cost of Capital calculation with dynamic capital structure.</p>
                </div>
                <div className="flex items-center bg-white/5 p-1 rounded-lg border border-white/10">
                  <button 
                    onClick={() => setWaccType('constant')}
                    className={cn(
                      "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest transition-all",
                      waccType === 'constant' ? "bg-emerald-500 text-black" : "text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    Constant
                  </button>
                  <button 
                    onClick={() => setWaccType('moving')}
                    className={cn(
                      "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest transition-all",
                      waccType === 'moving' ? "bg-emerald-500 text-black" : "text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    Moving
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                  {waccType === 'constant' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-[#151515] p-6 rounded-xl border border-white/10">
                      <WACCInput 
                        label="Risk-Free Rate (%)" 
                        value={waccInputs.riskFreeRate} 
                        onChange={v => setWaccInputs({...waccInputs, riskFreeRate: v})} 
                      />
                      <WACCInput 
                        label="Beta (β)" 
                        value={waccInputs.beta} 
                        onChange={v => setWaccInputs({...waccInputs, beta: v})} 
                      />
                      <WACCInput 
                        label="Equity Risk Premium (%)" 
                        value={waccInputs.equityRiskPremium} 
                        onChange={v => setWaccInputs({...waccInputs, equityRiskPremium: v})} 
                      />
                      <WACCInput 
                        label="Pre-tax Cost of Debt (%)" 
                        value={waccInputs.costOfDebt} 
                        onChange={v => setWaccInputs({...waccInputs, costOfDebt: v})} 
                      />
                      <WACCInput 
                        label="Marginal Tax Rate (%)" 
                        value={waccInputs.taxRate} 
                        onChange={v => setWaccInputs({...waccInputs, taxRate: v})} 
                      />
                      <div className="md:col-span-2 grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                        <WACCInput 
                          label="Equity Weight (%)" 
                          value={waccInputs.equityWeight} 
                          onChange={v => setWaccInputs({...waccInputs, equityWeight: v, debtWeight: 100 - v})} 
                        />
                        <WACCInput 
                          label="Debt Weight (%)" 
                          value={waccInputs.debtWeight} 
                          onChange={v => setWaccInputs({...waccInputs, debtWeight: v, equityWeight: 100 - v})} 
                        />
                      </div>
                    </div>
                  )}

                  {waccType === 'moving' && (
                    <div className="space-y-4">
                      <div className="p-6 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
                        <div className="flex items-center gap-2 text-emerald-500 mb-2">
                          <TrendingUp size={16} />
                          <h4 className="text-xs font-bold uppercase tracking-widest">Moving WACC Schedule Enabled</h4>
                        </div>
                        <p className="text-xs text-zinc-400">Adjust the capital structure and cost of debt for each forecasting year.</p>
                      </div>

                      <div className="overflow-x-auto border border-white/10 rounded-xl">
                        <table className="w-full text-left text-xs min-w-[800px]">
                          <thead className="bg-[#1A1A1A] text-[10px] uppercase tracking-widest font-bold text-zinc-500">
                            <tr>
                              <th className="px-4 py-3">Year</th>
                              <th className="px-4 py-3">RF %</th>
                              <th className="px-4 py-3">Beta</th>
                              <th className="px-4 py-3">ERP %</th>
                              <th className="px-4 py-3">Tax %</th>
                              <th className="px-4 py-3">Equity %</th>
                              <th className="px-4 py-3">Debt %</th>
                              <th className="px-4 py-3">COD %</th>
                              <th className="px-4 py-3 text-emerald-500">WACC %</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5 bg-[#151515]">
                            {movingWACCYears.map((year, idx) => (
                              <tr key={year.year}>
                                <td className="px-4 py-3 font-bold text-zinc-400">Y{year.year}</td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    step="0.1"
                                    value={year.riskFreeRate}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].riskFreeRate = parseFloat(e.target.value) || 0;
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    step="0.1"
                                    value={year.beta}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].beta = parseFloat(e.target.value) || 0;
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    step="0.1"
                                    value={year.equityRiskPremium}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].equityRiskPremium = parseFloat(e.target.value) || 0;
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    step="0.1"
                                    value={year.taxRate}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].taxRate = parseFloat(e.target.value) || 0;
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    value={year.equityWeight}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].equityWeight = parseFloat(e.target.value) || 0;
                                      newYears[idx].debtWeight = 100 - (parseFloat(e.target.value) || 0);
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    value={year.debtWeight}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].debtWeight = parseFloat(e.target.value) || 0;
                                      newYears[idx].equityWeight = 100 - (parseFloat(e.target.value) || 0);
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3">
                                  <input 
                                    type="number" 
                                    step="0.1"
                                    value={year.costOfDebt}
                                    onChange={e => {
                                      const newYears = [...movingWACCYears];
                                      newYears[idx].costOfDebt = parseFloat(e.target.value) || 0;
                                      setMovingWACCYears(newYears);
                                    }}
                                    className="w-14 bg-white/5 border border-white/10 rounded px-1.5 py-1 focus:outline-none focus:border-emerald-500/50"
                                  />
                                </td>
                                <td className="px-4 py-3 font-mono text-emerald-500 font-bold">
                                  {calculateWACC(waccInputs, year)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="bg-emerald-500 p-4 rounded-xl flex flex-col items-center justify-center text-center">
                    <span className="text-[10px] uppercase tracking-widest font-black text-black/60 mb-1">
                      {waccType === 'constant' ? 'Calculated WACC' : 'Avg. Moving WACC'}
                    </span>
                    <div className="text-3xl font-black text-black tracking-tighter">
                      {waccType === 'constant' 
                        ? `${calculateWACC(waccInputs)}%` 
                        : `${(movingWACCYears.reduce((acc, curr) => acc + parseFloat(calculateWACC(waccInputs, curr)), 0) / 5).toFixed(2)}%`
                      }
                    </div>
                    <div className="mt-4 w-full h-1 bg-black/10 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-black" 
                        style={{ 
                          width: `${waccType === 'constant' 
                            ? calculateWACC(waccInputs) 
                            : (movingWACCYears.reduce((acc, curr) => acc + parseFloat(calculateWACC(waccInputs, curr)), 0) / 5).toFixed(2)}%` 
                        }}
                      ></div>
                    </div>
                  </div>

                  <button 
                    onClick={() => exportToExcel([waccInputs, { calculatedWACC: calculateWACC(waccInputs) }], 'WACC_Model')}
                    className="w-full flex items-center justify-center gap-2 bg-white/5 border border-white/10 text-white py-2 rounded-lg text-xs font-bold hover:bg-white/10 transition-all"
                  >
                    <Download size={18} />
                    Export WACC Schedule
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'sensitivity' && (
            <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="space-y-2">
                <h2 className="text-3xl font-extrabold tracking-tight text-white">🎯 Sensitivity Calculator</h2>
                <p className="text-zinc-400 text-sm">Pick a preset or define your own two variables, constants, and formula.</p>
              </div>

              {/* Presets */}
              <div className="flex flex-wrap gap-2">
                {QUICK_PRESETS.map(p => (
                  <button 
                    key={p.id} 
                    onClick={() => loadPreset(p)}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-lg border transition-all font-bold text-xs uppercase tracking-widest",
                      preset === p.id 
                        ? "bg-emerald-500 text-black border-emerald-500" 
                        : "bg-[#151515] border-white/10 text-zinc-500 hover:text-zinc-300 hover:border-white/20"
                    )}
                  >
                    <span>{p.icon}</span>
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Row Variable */}
                <div className="bg-[#151515] border border-white/10 rounded-xl p-6 space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">↕ Row Variable</div>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Label</label>
                      <input 
                        value={rowLabel} 
                        onChange={e => setRowLabel(e.target.value)} 
                        placeholder="e.g. WACC (%)" 
                        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Variable Name <span className="lowercase font-normal text-zinc-600">(used in formula)</span></label>
                      <input 
                        value={rowName} 
                        onChange={e => setRowName(e.target.value)} 
                        placeholder="e.g. wacc" 
                        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-emerald-500 focus:outline-none focus:border-emerald-500/50 font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Min</label>
                        <input 
                          type="number" 
                          value={rowMin} 
                          onChange={e => setRowMin(e.target.value)} 
                          placeholder="8" 
                          className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Max</label>
                        <input 
                          type="number" 
                          value={rowMax} 
                          onChange={e => setRowMax(e.target.value)} 
                          placeholder="14" 
                          className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Col Variable */}
                <div className="bg-[#151515] border border-white/10 rounded-xl p-6 space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">↔ Column Variable</div>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Label</label>
                      <input 
                        value={colLabel} 
                        onChange={e => setColLabel(e.target.value)} 
                        placeholder="e.g. Terminal Growth (%)" 
                        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Variable Name <span className="lowercase font-normal text-zinc-600">(used in formula)</span></label>
                      <input 
                        value={colName} 
                        onChange={e => setColName(e.target.value)} 
                        placeholder="e.g. tgr" 
                        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-emerald-500 focus:outline-none focus:border-emerald-500/50 font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Min</label>
                        <input 
                          type="number" 
                          value={colMin} 
                          onChange={e => setColMin(e.target.value)} 
                          placeholder="1" 
                          className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Max</label>
                        <input 
                          type="number" 
                          value={colMax} 
                          onChange={e => setColMax(e.target.value)} 
                          placeholder="4" 
                          className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Constants */}
                <div className="bg-[#151515] border border-white/10 rounded-xl p-6 space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">📋 Constants</div>
                  <div className="space-y-2">
                    <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">One per line: <span className="text-emerald-500/70">name = value</span></p>
                    <textarea 
                      value={constants} 
                      onChange={e => setConstants(e.target.value)} 
                      rows={6}
                      placeholder="fcf1 = 100&#10;g = 5&#10;n = 5&#10;netDebt = 200&#10;shares = 50"
                      className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-3 text-sm text-emerald-500 focus:outline-none focus:border-emerald-500/50 font-mono leading-relaxed resize-none"
                    />
                  </div>
                </div>

                {/* Formula */}
                <div className="bg-[#151515] border border-white/10 rounded-xl p-6 space-y-4 flex flex-col">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">ƒ Formula</div>
                  <div className="flex-1 space-y-4">
                    {displayFormula ? (
                      <div className="bg-[#040912] border border-white/5 rounded-lg p-5 space-y-3 h-full">
                        {displayFormula.map((line, i) => (
                          <div key={i}>
                            {line.sub 
                              ? <div className="text-[10px] uppercase font-bold text-zinc-600 tracking-widest mb-1">{line.text}</div>
                              : <div className="text-sm font-bold text-emerald-500 font-mono leading-relaxed">{line.text}</div>
                            }
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-2 h-full flex flex-col">
                        <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">
                          Use: <span className="text-emerald-500">{rowName || "x"}</span>, <span className="text-emerald-500">{colName || "y"}</span>
                          {Object.keys(parseConstants(constants)).map(k => <span key={k}>, <span className="text-emerald-500">{k}</span></span>)}
                        </p>
                        <textarea 
                          value={formula} 
                          onChange={e => setFormula(e.target.value)} 
                          rows={4}
                          placeholder={rowName + " * " + colName}
                          className="w-full flex-1 bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-3 text-sm text-emerald-500 focus:outline-none focus:border-emerald-500/50 font-mono leading-relaxed resize-none"
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">Output Label</label>
                      <input 
                        value={outputLabel} 
                        onChange={e => setOutputLabel(e.target.value)} 
                        placeholder="e.g. Equity Value / Share ($)" 
                        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {sensitivityErr && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 text-sm font-bold flex items-center gap-3">
                  <span className="text-lg">⚠️</span>
                  {sensitivityErr}
                </div>
              )}

              <button 
                onClick={runSensitivity}
                className="w-full bg-emerald-500 text-black py-4 rounded-xl font-bold text-lg hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-3"
              >
                ⚡ Run Sensitivity Analysis
              </button>

              {results && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-bold text-white flex items-center gap-3">
                      <span className="text-emerald-500">✅</span>
                      {outputLabel || "Results"}
                    </h3>
                    <button 
                      onClick={downloadSensitivityExcel}
                      className="flex items-center gap-2 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 px-5 py-2.5 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition-all"
                    >
                      <Download size={16} />
                      Export to Excel
                    </button>
                  </div>

                  {/* Legend */}
                  <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500 font-mono">
                    <div className="flex h-2.5 w-24 rounded-full overflow-hidden border border-white/5">
                      {Array.from({length: 8}, (_, i) => (
                        <div 
                          key={i} 
                          className="flex-1" 
                          style={{ 
                            background: i < 4 
                              ? `rgba(120,20,20,${0.12 + (0.5 - i/8) * 1})` 
                              : `rgb(${(i-4)*4},${26+(i-4)*15},0)` 
                          }} 
                        />
                      ))}
                    </div>
                    <span className="text-red-400">Low</span>
                    <span className="text-zinc-700">→</span>
                    <span className="text-emerald-500">High</span>
                  </div>

                  {/* Table */}
                  <div className="bg-[#151515] border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr>
                            <th className="p-5 bg-[#1A1A1A] border-b border-white/10 text-left whitespace-nowrap">
                              <div className="text-[10px] font-bold uppercase tracking-widest">
                                <span className="text-emerald-500">{rowLabel || rowName}</span> ↓
                              </div>
                              <div className="text-[10px] font-bold uppercase tracking-widest mt-1">
                                <span className="text-emerald-500">{colLabel || colName}</span> →
                              </div>
                            </th>
                            {results.cols.map((cv: number, ci: number) => (
                              <th key={ci} className="p-5 bg-[#1A1A1A] border-b border-white/10 border-l border-white/5 text-center whitespace-nowrap font-mono text-xs font-bold text-emerald-500">
                                {fmtAxis(cv)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {results.rows.map((rv: number, ri: number) => (
                            <tr key={ri} className="group">
                              <td className="p-5 bg-[#1A1A1A] border-b border-white/5 text-left font-mono text-xs font-bold text-emerald-500 whitespace-nowrap">
                                {fmtAxis(rv)}
                              </td>
                              {results.cols.map((_: number, ci: number) => {
                                const val = results.matrix[ri][ci];
                                const style = cellStyle(val, results.min, results.max);
                                return (
                                  <td 
                                    key={ci} 
                                    className="p-5 border-b border-white/5 border-l border-white/5 text-center font-mono text-sm font-bold transition-all group-hover:opacity-80"
                                    style={style}
                                  >
                                    {fmtVal(val)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {[
                      { label: "📉 Min", value: fmtVal(results.min), color: "text-red-400", bg: "bg-red-500/5", border: "border-red-500/10" },
                      { label: "📊 Mid", value: fmtVal((results.min + results.max) / 2), color: "text-zinc-400", bg: "bg-zinc-500/5", border: "border-zinc-500/10" },
                      { label: "📈 Max", value: fmtVal(results.max), color: "text-emerald-500", bg: "bg-emerald-500/5", border: "border-emerald-500/10" },
                    ].map((stat, i) => (
                      <div key={i} className={cn("p-6 rounded-xl border flex flex-col gap-2", stat.bg, stat.border)}>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 font-mono">{stat.label}</div>
                        <div className={cn("text-2xl font-bold font-mono", stat.color)}>{stat.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function NavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all group",
        active 
          ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/20" 
          : "text-zinc-400 hover:bg-white/5 hover:text-white"
      )}
    >
      <span className={cn("transition-colors", active ? "text-black" : "text-zinc-500 group-hover:text-emerald-500")}>
        {icon}
      </span>
      {label}
    </button>
  );
}

function WACCInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{label}</label>
      <input 
        type="number" 
        step="0.1"
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-[#1A1A1A] border border-white/10 rounded-lg p-3 text-sm font-mono text-emerald-500 focus:outline-none focus:border-emerald-500/50"
      />
    </div>
  );
}
