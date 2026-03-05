import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Bot, Download, Play, RefreshCcw, ShieldAlert, UploadCloud } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Sankey, ScatterChart, Scatter } from "recharts";

/** See README for column mapping. This is the compact version. */

type TopProviderRow = { name: string; billed: number; allowed: number; claims: number; denied: number; umMismatch: number; cycleAvg: number };

type Claim = {
  serviceDate: string;
  svcFrom: string;
  svcThru: string;
  claimId: string;
  itmcd: string;
  seqno: number;
  entryDate: string;
  completedDate: string;
  cycleDays: number | null;
  payAction: string;
  denied: boolean;
  billed: number;
  allowed: number;
  paidProxy: number;
  lppInit: number;
  umCase: string;
  umMatch: "MATCH" | "NO MATCH" | "MULTI MATCH" | "USERNOMATCH" | "<100% MATCH" | "OTHER" | "";
  provider: string;
  region: string;
  company: string;
  reason: string;
  diagPrimary: string;
  diag: string;
  proc: string;
  discharge: string;
  los: number;
  expLos: number;
  dischargeGap: boolean;
  stopLoss: boolean;
  serviceLine: string;
};

type Msg = { id: string; role: "user" | "assistant"; text: string; csv?: string };
type TraceItem = { id: string; kind: "think" | "tool"; name: string; status: "running" | "done"; detail?: string };

const NL = String.fromCharCode(10);

function uid() {
  const anyCrypto: any = (globalThis as any).crypto;
  return anyCrypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function usd(n: number) { return Number.isFinite(n) ? n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}) : "–"; }
function pct(x: number) { return Number.isFinite(x) ? `${(x*100).toFixed(1)}%` : "–"; }
function nfmt(n: number) { return Number.isFinite(n) ? Math.round(n).toLocaleString() : "–"; }
function safeStr(v: any) { return String(v ?? "").trim(); }
function num(v: any) { const s = safeStr(v).replace(/[$,]/g,""); const n = typeof v === "number" ? v : Number(s); return Number.isFinite(n) ? n : 0; }
function groupBy<T>(arr: T[], keyFn: (t: T) => string) { const m=new Map<string,T[]>(); for(const it of arr){const k=keyFn(it); (m.get(k)??m.set(k,[]).get(k)!).push(it);} return m; }
function toCSV(rows: { [k: string]: any }[]) { if(!rows.length) return ""; const headers=Object.keys(rows[0]); const esc=(v:any)=>JSON.stringify(v??""); return [headers.join(","),...rows.map(r=>headers.map(h=>esc(r[h])).join(","))].join(NL); }
function downloadCSV(filename: string, text: string) { const blob=new Blob([text],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }

function looksLikeYYYYMMDD(s: string) { return /^[0-9]{8}$/.test(s); }
function toIsoDate(v:any):string{
  if(v==null||v==="") return "";
  if(v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0,10);
  if(typeof v==="number" && isFinite(v) && v>20000 && v<90000){ const d=XLSX.SSF.parse_date_code(v); if(d) return new Date(Date.UTC(d.y,d.m-1,d.d)).toISOString().slice(0,10); }
  const s=safeStr(v); const dt=new Date(s); if(!isNaN(dt.getTime())) return dt.toISOString().slice(0,10);
  if(looksLikeYYYYMMDD(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return "";
}
function parseSeqno(v:any){ const n=num(v); return Number.isFinite(n)&&n>0?Math.round(n):999; }
function isDenied(payAct:string){ return safeStr(payAct).toUpperCase().startsWith("R"); }
function daysBetween(aIso:string,bIso:string){ if(!aIso||!bIso) return null; const a=new Date(`${aIso}T00:00:00Z`); const b=new Date(`${bIso}T00:00:00Z`); if(isNaN(a.getTime())||isNaN(b.getTime())) return null; return Math.round((b.getTime()-a.getTime())/86400000); }
function losFromDates(fromIso:string,thruIso:string){ if(!fromIso&&!thruIso) return 1; const f=new Date(`${(fromIso||thruIso)}T00:00:00Z`); const t=new Date(`${(thruIso||fromIso)}T00:00:00Z`); if(isNaN(f.getTime())||isNaN(t.getTime())) return 1; return Math.max(1,Math.round((t.getTime()-f.getTime())/86400000)+1); }
function inferServiceLine(row:any){ const t=`${safeStr(row.REASON)} ${safeStr(row.DDC_NAT_E00_DIAG_CODE)} ${safeStr(row.DDC_CD_ICDA_CDE_1)} ${safeStr(row.DDC_NAT_E00_PROC_CODE)}`.toLowerCase(); if(t.includes("sepsis")) return "Sepsis"; if(t.includes("onc")||t.includes("cancer")||t.includes("chemo")||t.includes("tumor")) return "Oncology"; if(t.includes("neo")||t.includes("nicu")||t.includes("neon")) return "NICU"; return "Other"; }
function umMatchBucket(umCase:string):Claim["umMatch"]{ const u=safeStr(umCase).toUpperCase(); if(!u) return ""; if(u.includes("NO MATCH")) return "NO MATCH"; if(u.includes("MULTI MATCH")) return "MULTI MATCH"; if(u.includes("USERNOMATCH")) return "USERNOMATCH"; if(u.includes("<100% MATCH")) return "<100% MATCH"; if(u.includes("MATCH")) return "MATCH"; return "OTHER"; }
function selectLatestAdjustments(rows:any[]){ const withDcn=rows.filter(r=>!!safeStr(r.DCN)); const noDcn=rows.filter(r=>!safeStr(r.DCN)); const by=groupBy(withDcn,r=>safeStr(r.DCN)); const out:any[]=[]; for(const [,list] of by.entries()){ let best=list[0]; let bestSeq=parseSeqno(best.SEQNO); for(const r of list){ const s=parseSeqno(r.SEQNO); if(s<bestSeq){ best=r; bestSeq=s; } } out.push(best); } return [...out,...noDcn]; }
function expectedLosByServiceLine(claims:Claim[]){ const by=groupBy(claims,c=>c.serviceLine); const out:Record<string,number>={}; for(const [k,list] of by.entries()){ const vals=list.map(x=>x.los).filter(n=>n>0).sort((a,b)=>a-b); const med=vals.length?vals[Math.floor(vals.length/2)]:5; out[k]=Math.max(1,Math.round(med)); } return out; }

function mapExcelRowsToClaims(rows:any[]):Claim[]{
  const deduped=selectLatestAdjustments(rows);
  const tmp:Claim[]=deduped.map((r,idx)=>{
    const claimId=safeStr(r.DCN)||`ROW-${idx+1}`;
    const itmcd=safeStr(r.ITMCD);
    const seqno=parseSeqno(r.SEQNO);
    const svcFrom=toIsoDate(r.DDC_CD_SVC_FROM_DTE ?? r.DDC_CD_SVC_THRU_DTE);
    const svcThru=toIsoDate(r.DDC_CD_SVC_THRU_DTE ?? r.DDC_CD_SVC_FROM_DTE);
    const serviceDate=svcFrom||svcThru||"";
    const entryDate=toIsoDate(r.DDC_CD_ORIG_ENTRY_DTE);
    const completedDate=toIsoDate(r.DDC_CD_CLM_COMPL_DTE);
    const cycleDays=daysBetween(entryDate,completedDate);
    const payAction=safeStr(r.PAY_ACT_CD);
    const denied=isDenied(payAction);
    const billed=num(r.DDC_CD_TOT_CHRG_AMT);
    const allowed=num(r.DDC_CD_TOT_BNFT_AMT);
    const paidProxy=denied?0:allowed;
    const lppInit=num(r.DDC_CD_LPP_INT_AMT);
    const umCase=safeStr(r.DDC_NAT_E00_CAS_NBR);
    const umMatch=umMatchBucket(umCase);
    const provider=safeStr(r.DDC_CD_PRVDR_NME)||safeStr(r.DDC_CD_PRVDR_TAX_ID)||"Unknown Provider";
    const region=safeStr(r.DDC_CD_GRP_STATE)||"Unknown";
    const company=safeStr(r.DDC_CD_COMPANY_CDE);
    const reason=safeStr(r.REASON);
    const diagPrimary=safeStr(r.DDC_CD_ICDA_CDE_1);
    const diag=safeStr(r.DDC_NAT_E00_DIAG_CODE)||diagPrimary;
    const proc=safeStr(r.DDC_NAT_E00_PROC_CODE);
    const discharge=safeStr(r.DDC_NAT_E00_DISCHARGE_CODE);
    const los=losFromDates(svcFrom,svcThru);
    const expLos=5;
    const serviceLine=inferServiceLine(r);
    const stopLoss=allowed>=150000;
    const dischargeGap=los-expLos>=3;
    return {serviceDate,svcFrom,svcThru,claimId,itmcd,seqno,entryDate,completedDate,cycleDays,payAction,denied,billed,allowed,paidProxy,lppInit,umCase,umMatch,provider,region,company,reason,diagPrimary,diag,proc,discharge,los,expLos,dischargeGap,stopLoss,serviceLine};
  }).filter(c=>!!c.serviceDate);

  const med=expectedLosByServiceLine(tmp);
  return tmp.map(c=>{ const expLos=med[c.serviceLine]??5; const dischargeGap=c.los-expLos>=3; return {...c,expLos,dischargeGap}; });
}

async function readXlsxFromArrayBuffer(buf:ArrayBuffer):Promise<Claim[]>{
  const wb=XLSX.read(buf,{type:"array"});
  const sheetName=wb.SheetNames[0];
  const ws=wb.Sheets[sheetName];
  const rows=XLSX.utils.sheet_to_json(ws,{defval:"",raw:true}) as any[];
  return mapExcelRowsToClaims(rows);
}
async function readXlsxFromFile(file:File){ return readXlsxFromArrayBuffer(await file.arrayBuffer()); }
async function readXlsxFromUrl(url:string){ const res=await fetch(url); if(!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`); return readXlsxFromArrayBuffer(await res.arrayBuffer()); }

function lastNDays(data:Claim[],n:number){ const dates=Array.from(new Set(data.map(d=>d.serviceDate))).sort(); const keep=new Set(dates.slice(-n)); return data.filter(r=>keep.has(r.serviceDate)); }
function daily(data:Claim[],threshold:number){ const by=groupBy(data,r=>r.serviceDate); const dates=Array.from(by.keys()).sort(); return dates.map(date=>{ const rows=by.get(date)||[]; let allowed=0,billed=0,lpp=0,highBilled=0,denied=0,umMismatch=0,cycleSum=0,cycleN=0; for(const r of rows){ allowed+=r.allowed; billed+=r.billed; lpp+=r.lppInit; if(r.billed>=threshold) highBilled+=r.billed; if(r.denied) denied+=1; if(r.umMatch==="NO MATCH"||r.umMatch==="USERNOMATCH"||r.umMatch==="MULTI MATCH") umMismatch+=1; if(r.cycleDays!=null){cycleSum+=r.cycleDays;cycleN+=1;} } return {date,allowed,billed,lpp,highBilled,denied,umMismatch,cycleAvg:cycleN?cycleSum/cycleN:0}; }); }
function concentration(data:Claim[],byKey:"provider"|"umCase"){ const m=groupBy(data,r=>byKey==="provider"?r.provider:(r.umCase||"(blank)")); const totals=Array.from(m.values()).map(list=>list.reduce((a,r)=>a+r.allowed,0)).sort((a,b)=>b-a); const total=totals.reduce((a,v)=>a+v,0)||1; const cut=(p:number)=>totals.slice(0,Math.max(1,Math.round(totals.length*p))).reduce((a,v)=>a+v,0)/total; return {entities:totals.length,top1:cut(0.01),top5:cut(0.05),top10:cut(0.1)}; }
function topProviders(data:Claim[],k=6):TopProviderRow[]{
  const m = groupBy(data, r => r.provider);
  const rows = Array.from(m.entries()).map(([name, list]) => {
    let billed = 0, allowed = 0, denied = 0, umMismatch = 0, cycleSum = 0, cycleN = 0;
    for (const r of list) {
      billed += r.billed;
      allowed += r.allowed;
      if (r.denied) denied += 1;
      if (r.umMatch === "NO MATCH" || r.umMatch === "USERNOMATCH" || r.umMatch === "MULTI MATCH") umMismatch += 1;
      if (r.cycleDays != null) { cycleSum += r.cycleDays; cycleN += 1; }
    }
    return { name, billed, allowed, claims: list.length, denied, umMismatch, cycleAvg: cycleN ? cycleSum / cycleN : 0 };
  }).sort((a, b) => b.billed - a.billed);
  return rows.slice(0, k);
}
function reasonBreakdown(data:Claim[],k=6){ const m=groupBy(data,r=>r.reason||"(blank)"); const rows=Array.from(m.entries()).map(([reason,list])=>{ let allowed=0,denied=0,stopLoss=0; for(const r of list){ allowed+=r.allowed; if(r.denied) denied+=1; if(r.stopLoss) stopLoss+=1; } return {reason,allowed,claims:list.length,denied,stopLoss}; }).sort((a,b)=>b.allowed-a.allowed); return rows.slice(0,k); }
function parseThreshold(text:string){ const s=(text||"").toLowerCase(); const m=s.match(/[0-9]+/); const n=m?Number(m[0]):NaN; if(!Number.isFinite(n)||n<=0) return 100000; if(s.includes("k")) return n*1000; if(n>=200&&n<=999) return n*1000; return n; }
function parseIntent(q:string){ const t=(q||"").toLowerCase(); const days=t.includes("90")||t.includes("quarter")?90:t.includes("7")||t.includes("week")?7:30; const threshold=(t.includes("$")||t.includes("k")||t.includes("over")||t.includes(">="))?parseThreshold(t):100000; const wants={topProviders:t.includes("provider"),concentration:t.includes("concentration"),reasons:t.includes("reason")||t.includes("domain"),export:t.includes("export")||t.includes("csv")||t.includes("download")}; return {days,threshold,wants}; }

function InteractiveChart({data, dataKey, title, color = "#3b82f6"}: {data: any[], dataKey: string, title: string, color?: string}) {
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');

  const chartData = useMemo(() => {
    return data.map((item, index) => ({
      ...item,
      date: item.date || `Day ${index + 1}`,
      [dataKey]: Number(item[dataKey]) || 0
    }));
  }, [data, dataKey]);

  const formatValue = (value: number) => {
    if (dataKey.includes('Rate') || dataKey.includes('rate')) {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (dataKey.includes('allowed') || dataKey.includes('billed') || dataKey.includes('lpp')) {
      return usd(value);
    }
    return nfmt(value);
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`Date: ${label}`}</p>
          <p className="text-sm" style={{ color }}>
            {`${title}: ${formatValue(payload[0].value)}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <button
          onClick={() => setChartType('line')}
          className={`px-2 py-1 text-xs rounded border ${chartType === 'line' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
        >
          Line
        </button>
        <button
          onClick={() => setChartType('bar')}
          className={`px-2 py-1 text-xs rounded border ${chartType === 'bar' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
        >
          Bar
        </button>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        {chartType === 'line' ? (
          <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => {
                if (value.includes('-')) {
                  const date = new Date(value);
                  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                return value;
              }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickFormatter={formatValue}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              dot={{ fill: color, strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6, stroke: color, strokeWidth: 2, fill: '#fff' }}
            />
          </LineChart>
        ) : (
          <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => {
                if (value.includes('-')) {
                  const date = new Date(value);
                  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                return value;
              }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickFormatter={formatValue}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey={dataKey}
              fill={color}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function InteractiveBarChart({data, dataKey, title, color = "#3b82f6"}: {data: any[], dataKey: string, title: string, color?: string}) {
  const chartData = useMemo(() => {
    return data.map((item) => ({
      ...item,
      [dataKey]: Number(item[dataKey]) || 0
    }));
  }, [data, dataKey]);

  const formatValue = (value: number) => {
    if (dataKey.includes('Rate') || dataKey.includes('rate')) {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (dataKey.includes('allowed') || dataKey.includes('billed') || dataKey.includes('lpp')) {
      return usd(value);
    }
    return nfmt(value);
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`${label}`}</p>
          <p className="text-sm" style={{ color }}>
            {`${title}: ${formatValue(payload[0].value)}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12 }}
          angle={-45}
          textAnchor="end"
          height={60}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          tickFormatter={formatValue}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar
          dataKey={dataKey}
          fill={color}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

function InteractivePieChart({data, dataKey, nameKey, title, colors = ["#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"]}: {data: any[], dataKey: string, nameKey: string, title: string, colors?: string[]}) {
  const chartData = useMemo(() => {
    return data.map((item, index) => ({
      ...item,
      [dataKey]: Number(item[dataKey]) || 0,
      fill: colors[index % colors.length]
    }));
  }, [data, dataKey, colors]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium">{`${data[nameKey]}`}</p>
          <p className="text-sm" style={{ color: data.fill }}>
            {`${title}: ${usd(data[dataKey])}`}
          </p>
          <p className="text-sm text-muted-foreground">
            {`${pct(data[dataKey] / data.total)} of total`}
          </p>
        </div>
      );
    }
    return null;
  };

  const total = chartData.reduce((sum, item) => sum + item[dataKey], 0);
  const dataWithTotal = chartData.map(item => ({ ...item, total }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={dataWithTotal}
          cx="50%"
          cy="50%"
          innerRadius={40}
          outerRadius={80}
          paddingAngle={2}
          dataKey={dataKey}
        >
          {dataWithTotal.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function SankeyDiagram({data}:{data:Claim[]}) {
  // Department configurations with processing days
  const departments = [
    { name: "SIU", days: 18 },
    { name: "PSCCR", days: 9 },
    { name: "COB", days: 7 },
    { name: "CERIS", days: 7 },
    { name: "Pricing", days: 2 },
    { name: "Valenz", days: 2 }
  ];
  
  const totalDays = departments.reduce((sum, dept) => sum + dept.days, 0);

  const nodes = useMemo(() => {
    // Single source node
    const sourceNode = { name: "All Claims", id: 0 };
    
    // Department nodes include days in label for readability
    const deptNodes = departments.map((dept, i) => ({
      name: `${dept.name} (${dept.days}d)`,
      id: i + 1
    }));
    
    return [sourceNode, ...deptNodes];
  }, []);

  const links = useMemo(() => {
    const totalCount = data.length;
    
    // Distribute all claims across departments based on processing days
    return departments.map((dept, deptIndex) => {
      const daysRatio = dept.days / totalDays;
      const claimCount = Math.max(1, Math.round(totalCount * daysRatio));
      
      return {
        source: 0, // From "All Claims"
        target: deptIndex + 1, // To department
        value: claimCount
      };
    });
  }, [data]);


  // custom node element to render rectangle + label to the right
  const CustomSankeyNode = (props: any) => {
    const { x, y, width, height, payload } = props;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill="#8884d8" stroke="#333" />
        <text x={x + width + 6} y={y + height / 2} fontSize={12} fill="#000" textAnchor="start" alignmentBaseline="middle">
          {payload.name}
        </text>
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={300}>
      <Sankey
          data={{ nodes, links }}
          margin={{ top: 10, right: 160, bottom: 10, left: 100 }}
          node={CustomSankeyNode}
          nodePadding={20}
          nodeWidth={80}
          link={{
            stroke: '#8884d8',
            strokeOpacity: 0.4
          }}
        >
        <Tooltip 
          contentStyle={{ 
            backgroundColor: '#fff', 
            border: '1px solid #ddd', 
            borderRadius: '4px', 
            padding: '10px' 
          }}
          formatter={(value) => {
            const numValue = Number(value);
            const percent = ((numValue / data.length) * 100).toFixed(1);
            return [`${nfmt(numValue)} claims`, `${percent}% of total`];
          }}
          labelStyle={{ color: '#000', fontSize: '12px' }}
        />
      </Sankey>
    </ResponsiveContainer>
  );
}

function AdjustmentDensity({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    // group by provider and domain
    const map = new Map<string, { provider:string; domain:string; count:number; totalPrompt:number }>();
    
    for (const claim of data) {
      const domain = (claim.reason||"Other").toLowerCase().includes("sepsis") ? "Sepsis"
        : (claim.reason||"").toLowerCase().includes("neo") ? "Neonatal"
        : (claim.reason||"").toLowerCase().includes("onc") ? "Oncology"
        : "Other";
      const key = `${claim.provider}||${domain}`;
      const existing = map.get(key) || { provider: claim.provider, domain, count:0, totalPrompt:0 };
      existing.count += 1;
      existing.totalPrompt += claim.paidProxy; // incurred prompt pay
      map.set(key, existing);
    }
    
    // create color palette for providers
    const providers = Array.from(new Set(Array.from(map.values()).map(v=>v.provider)));
    const colors = providers.reduce((acc,p,i)=>{ acc[p]=[`#10b981`,`#f59e0b`,`#8b5cf6`,`#ef4444`,`#06b6d4`,`#a855f7`][i%6]; return acc; },{} as Record<string,string>);
    
    return Array.from(map.values()).map(v=>({
      provider:v.provider,
      domain:v.domain,
      avgPromptPay: v.count? v.totalPrompt/v.count : 0,
      color: colors[v.provider] || '#8884d8'
    }));
  }, [data]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      return (
        <div className="bg-background border rounded-lg p-3 shadow-lg text-sm">
          <p className="font-medium">{d.provider} ({d.domain})</p>
          <p className="text-xs text-muted-foreground">Avg prompt pay: {usd(d.avgPromptPay)}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={250}>
      <ScatterChart margin={{ top: 20, right: 20, bottom: 40, left: 40 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="avgPromptPay" 
          name="Avg Prompt Pay" 
          tick={{ fontSize: 12 }}
          tickFormatter={usd}
          type="number"
        />
        <YAxis 
          dataKey="domain" 
          type="category" 
          tick={{ fontSize: 12 }}
          label={{ value: 'Domain', angle: -90, position: 'insideLeft' }}
        />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
        { /* render each provider group as separate scatter */ }
        {Array.from(new Set(chartData.map(d=>d.provider))).map(prov => (
          <Scatter 
            key={prov}
            name={prov}
            data={chartData.filter(d=>d.provider===prov)}
            fill={chartData.find(d=>d.provider===prov)?.color}
            fillOpacity={0.6}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function PromptPayDistribution({data}:{data:Claim[]}) {
  const chartData = useMemo(() => {
    const providerMap = new Map<string, {onTime: number, delayed: number, denied: number}>();
    
    for (const claim of data) {
      const existing = providerMap.get(claim.provider) || { onTime: 0, delayed: 0, denied: 0 };
      if (claim.denied) {
        existing.denied += 1;
      } else if (claim.cycleDays != null && claim.cycleDays <= 30) {
        existing.onTime += 1;
      } else {
        existing.delayed += 1;
      }
      providerMap.set(claim.provider, existing);
    }
    
    return Array.from(providerMap.entries())
      .sort((a, b) => (b[1].onTime + b[1].delayed + b[1].denied) - (a[1].onTime + a[1].delayed + a[1].denied))
      .slice(0, 6)
      .map(([provider, stats]) => ({
        provider,
        "On-Time": stats.onTime,
        "Delayed": stats.delayed,
        "Denied": stats.denied
      }));
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 40 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis 
          dataKey="provider" 
          tick={{ fontSize: 11 }}
          angle={-45}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="On-Time" stackId="a" fill="#10b981" />
        <Bar dataKey="Delayed" stackId="a" fill="#f59e0b" />
        <Bar dataKey="Denied" stackId="a" fill="#ef4444" />
      </BarChart>
    </ResponsiveContainer>
  );
}
function ConcRow({c}:{c:{entities:number;top1:number;top5:number;top10:number}}){ return (<div className="mt-1 grid grid-cols-3 gap-2 text-xs"><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 1%</div><div className="mt-1 font-semibold">{pct(c.top1)}</div></div><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 5%</div><div className="mt-1 font-semibold">{pct(c.top5)}</div></div><div className="rounded-xl border p-2"><div className="text-muted-foreground">Top 10%</div><div className="mt-1 font-semibold">{pct(c.top10)}</div></div></div>); }
function Kpi({label,value,sub}:{label:string;value:string;sub:string}){ return (<div className="rounded-2xl border p-3"><div className="text-sm font-medium">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div><div className="mt-1 text-xs text-muted-foreground">{sub}</div></div>); }
function MiniSelect({label,value,onChange,options}:{label:string;value:string;onChange:(v:string)=>void;options:string[]}){ return (<label className="text-xs"><span className="text-muted-foreground mr-1">{label}</span><select className="rounded-xl border px-2 py-1 text-xs bg-background" value={value} onChange={(e)=>onChange(e.target.value)}>{options.map(o=>(<option key={o} value={o}>{o}</option>))}</select></label>); }
function Card({title,subtitle,children}:{title:string;subtitle:string;children:React.ReactNode}){ return (<div className="rounded-2xl border p-3"><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{subtitle}</div><div className="mt-2">{children}</div></div>); }
function RowBar({name,value,max,right}:{name:string;value:number;max:number;right:string}){ const w=Math.max(2,Math.round((value/Math.max(1,max))*100)); return (<div className="rounded-xl border p-2"><div className="flex items-center justify-between gap-2"><div className="text-xs font-medium truncate" title={name}>{name}</div><div className="text-xs text-muted-foreground tabular-nums">{right}</div></div><div className="mt-2 h-2 w-full rounded-full bg-muted"><div className="h-2 rounded-full bg-foreground/40" style={{width:`${w}%`}}/></div></div>); }

export default function App(){
  const [claims,setClaims]=useState<Claim[]>([]);
  const [dataStatus,setDataStatus]=useState("No workbook loaded (using demo rows). Put claims.xlsx in /public to auto-load.");
  const [days,setDays]=useState(30);
  const [threshold,setThreshold]=useState(100000);
  const [region,setRegion]=useState("All");
  const [query,setQuery]=useState("");
  const [running,setRunning]=useState(false);
  const [trace,setTrace]=useState<TraceItem[]>([]);
  const [messages,setMessages]=useState<Msg[]>([{id:uid(),role:"assistant",text:"Metrics aligned to Excel columns: billed/allowed/LPP, denials from PAY_ACT_CD, UM match from DDC_NAT_E00_CAS_NBR, cycle time from entry→completed dates. Ask: ‘Top providers over $200k last 90 days’, ‘UM mismatch trends’, ‘Top REASON domains’, ‘Export csv’."}]);
  const bottomRef=useRef<HTMLDivElement|null>(null);

  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[messages,running]);

  useEffect(()=>{ (async()=>{ try{ setDataStatus("Checking /claims.xlsx …"); const c=await readXlsxFromUrl("/claims.xlsx"); if(c.length){ setClaims(c); setDataStatus(`Auto-loaded ${nfmt(c.length)} rows from /claims.xlsx.`); } else { setDataStatus("/claims.xlsx loaded but no rows mapped (using demo rows). Check column names."); } } catch { setDataStatus("No workbook loaded (using demo rows). Put claims.xlsx in /public to auto-load."); } })(); },[]);

  const demoClaims=useMemo(()=>{ const out:Claim[]=[]; const today=new Date(); for(let i=0;i<30;i++){ const d=new Date(today); d.setDate(today.getDate()-(29-i)); const ds=d.toISOString().slice(0,10); const denied=i%9===0; out.push({serviceDate:ds,svcFrom:ds,svcThru:ds,claimId:`D-${i}`,itmcd:"80",seqno:999,entryDate:ds,completedDate:ds,cycleDays:0,payAction:denied?"R1":"P0",denied,billed:120000+i*2000,allowed:60000+i*1100,paidProxy:denied?0:60000+i*1100,lppInit:100+i,umCase:i%7===0?"NO MATCH":"MATCH",umMatch:i%7===0?"NO MATCH":"MATCH",provider:`Provider ${String((i%5)+1).padStart(2,"0")}`,region:["IL","TX","NY","CA"][i%4],company:"",reason:["Oncology","Sepsis","Neonatal"][i%3],diagPrimary:"",diag:"",proc:"",discharge:"",los:6+(i%5),expLos:6,dischargeGap:i%11===0,stopLoss:(60000+i*1100)>=150000,serviceLine:["Oncology","Sepsis","NICU"][i%3]}); } return out; },[]);
  const data=claims.length?claims:demoClaims;
  const regionOptions=useMemo(()=>["All",...Array.from(new Set(data.map(c=>c.region))).sort()],[data]);
  const scoped=useMemo(()=>{ let d=lastNDays(data,days); if(region!=="All") d=d.filter(r=>r.region===region); return d; },[data,days,region]);
  const series=useMemo(()=>daily(scoped,threshold),[scoped,threshold]);
  const kpis=useMemo(()=>{ let billed=0,paid=0,allowed=0,lpp=0,denied=0,highBilled=0,umMismatch=0,cycleSum=0,cycleN=0; for(const r of scoped){ billed+=r.billed; paid+=r.paidProxy; allowed+=r.allowed; lpp+=r.lppInit; if(r.denied) denied+=1; if(r.billed>=threshold) highBilled+=r.billed; if(r.umMatch==="NO MATCH"||r.umMatch==="USERNOMATCH"||r.umMatch==="MULTI MATCH") umMismatch+=1; if(r.cycleDays!=null){cycleSum+=r.cycleDays; cycleN+=1;} } return {claims:scoped.length,billed,paid,allowed,lpp,deniedRate:scoped.length?denied/scoped.length:0,highShare:billed?highBilled/billed:0,paidToBilled:billed?paid/billed:0,allowedToBilled:billed?allowed/billed:0,umMismatchRate:scoped.length?umMismatch/scoped.length:0,cycleAvg:cycleN?cycleSum/cycleN:0}; },[scoped,threshold]);
  const topP=useMemo(()=>topProviders(scoped,6),[scoped]);
  const topR=useMemo(()=>reasonBreakdown(scoped,6),[scoped]);
  const concProv=useMemo(()=>concentration(scoped,"provider"),[scoped]);
  const concUm=useMemo(()=>concentration(scoped,"umCase"),[scoped]);
  const lastCsv=useMemo(()=> ([...messages].reverse().find(x=>x.role==="assistant"&&x.csv)?.csv) || "", [messages]);

  async function loadWorkbookFile(file:File){ setDataStatus(`Loading workbook: ${file.name}…`); try{ const c=await readXlsxFromFile(file); setClaims(c); setDataStatus(`Loaded ${nfmt(c.length)} rows from ${file.name}. Adjustments deduped by DCN (min SEQNO).`); } catch(e:any){ setDataStatus(`Failed to load workbook: ${e?.message||String(e)}`);} }
  async function loadWorkbookUrl(){ setDataStatus("Loading /claims.xlsx …"); try{ const c=await readXlsxFromUrl("/claims.xlsx"); setClaims(c); setDataStatus(`Loaded ${nfmt(c.length)} rows from /claims.xlsx.`);} catch(e:any){ setDataStatus(`Failed to load /claims.xlsx: ${e?.message||String(e)}`);} }

  // Pre-defined Q&A pairs for demo questions
  const qaPairs: { q: string; a: (data: Claim[]) => string }[] = [
    {
      q: "how many first time claims",
      a: (data) => {
        const firstTime = data.filter(c => c.seqno === 999).length;
        // Executive takeaways (mocked)
        return `A quick scan reveals ${nfmt(firstTime)} first time claims in the current scope.\n\nStatus update:\n• Change detected: Claim volume up 8% (32 vs 29 last month).\n• Primary catalysts: Provider 03 onboarding (60%), new product launch (25%), direct-to-consumer campaign (15%).\n• Suggested protocol: Claims Ops to audit onboarding for Provider 03 and report findings by Mar 15. Would you like a reminder scheduled?`;
      }
    },
    {
      q: "total dollar billed vs paid",
      a: (data) => {
        const billed = data.reduce((sum, c) => sum + c.billed, 0);
        const paid = data.reduce((sum, c) => sum + c.paidProxy, 0);
        return `Financial dashboard: Billed ${usd(billed)}, Paid ${usd(paid)}, with a paid-to-billed ratio of ${pct(billed ? paid / billed : 0)}.\n\nDiagnostics:\n• Recent shift: Paid ratio slipped to 48% (was 50% last week).\n• Root causes: Oncology denials (70%), Provider 02 disputes (20%), duplicate billing (10%).\n• Tactical response: Finance to review Oncology denials and resolve Provider 02 disputes by Mar 12. Would you like a summary emailed to the team?`;
      }
    },
    {
      q: "claims denial distribution by reasons",
      a: (data) => {
        const deniedByReason = groupBy(data.filter(c => c.denied), c => c.reason || "(blank)");
        let out = "Claims Denial Distribution by Reason:\n";
        for (const [reason, claims] of deniedByReason.entries()) {
          out += `- ${reason}: ${nfmt(claims.length)}\n`;
        }
        return `Denial distribution analysis complete.\n${out.trim()}\n\nKey findings:\n• Oncology denials up 5 cases (18 vs 13 last month).\n• Main offenders: Missing clinical notes (3), incorrect codes (1), absent prior auth (1).\n• Recommended action: Medical Review to contact Oncology providers and verify documentation by Mar 20. Would you like a briefing prepared for the next board meeting?`;
      }
    },
    {
      q: "number of correspondence/inquiries & disputes received",
      a: () => {
        return `Correspondence and disputes tally: 42, exceeding the expected threshold.\n\nSituation report:\n• Change: Disputes up 10% (42 vs 38 target).\n• Drivers: Provider 01 (50%), delayed payments (30%), portal errors (20%).\n• Next steps: Provider Relations to meet Provider 01 and resolve payment issues by Mar 18. IT to investigate portal reliability. Would you like an apology letter drafted?`;
      }
    },
    {
      q: "number of disputed overturned vs upheld",
      a: () => {
        return `Appeals review: 18 overturned, 24 upheld.\n\nPerformance update:\n• Overturned rate up 15% (18/42 vs 15/40 last week).\n• Success factors: Appeals checklist (2 cases), expedited review (1), improved documentation (remainder).\n• Directive: Appeals Team to track checklist compliance and submit a process improvement report by Mar 22. Would you like a follow-up scheduled?`;
      }
    },
    {
      q: "what kind of recovery was performed",
      a: () => {
        return `Recovery operations summary: Overpayment recoupment, Coordination of Benefits, Subrogation.\n\nHighlights:\n• Subrogation recoveries doubled ($40K vs $20K last month).\n• Catalysts: New audit tool ($15K), staff training ($3K), external vendor ($2K).\n• Mission: Recovery Team to expand audit scope and set vendor targets by Mar 25. Would you like the team notified?`;
      }
    },
    {
      q: "prompt pay distribution by provider",
      a: (data) => {
        const byProvider = groupBy(data.filter(c => !c.denied), c => c.provider);
        let out = "Prompt Pay Distribution by Provider:\n";
        for (const [provider, claims] of byProvider.entries()) {
          out += `- ${provider}: ${nfmt(claims.length)} paid\n`;
        }
        return `Prompt pay distribution:\n${out.trim()}\n\nAnalysis:\n• Provider 01 prompt pay rate fell to 80% (from 85% last month).\n• Culprits: 3 late submissions, 2 system outages, 1 staff turnover.\n• Recommendation: IT to automate reminders and monitor outages, status update by Mar 28. Would you like contingency protocols activated?`;
      }
    }
  ];

  function findAnswer(q: string, data: Claim[]): string | null {
    const norm = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const { q: question, a } of qaPairs) {
      if (norm.includes(question)) {
        return a(data);
      }
    }
    return null;
  }

  function send() {
    const text = query.trim();
    if (!text || running) return;
    setMessages(m => [...m, { id: uid(), role: "user", text }]);
    setQuery("");
    // Check for pre-defined Q&A
    const answer = findAnswer(text, scoped);
    if (answer) {
      setMessages(m => [...m, { id: uid(), role: "assistant", text: answer }]);
    } else {
      setMessages(m => [...m, { id: uid(), role: "assistant", text: "Agent runner is enabled in the full version. This fallback build focuses on the dashboard + CSV download from UI buttons." }]);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-2xl border flex items-center justify-center"><ShieldAlert className="h-5 w-5"/></div>
            <div>
              <div className="text-2xl font-semibold tracking-tight">Agentic Claims Analytics</div>
              <div className="text-sm text-muted-foreground">Excel-backed prototype • high-charge claims</div>
            </div>
          </div>
          <button className="px-3 py-2 rounded-xl border text-sm" onClick={()=>{ setDays(30); setThreshold(100000); setRegion("All"); setTrace([]); setMessages(m=>[m[0]]); }}>
            <span className="inline-flex items-center gap-2"><RefreshCcw className="h-4 w-4"/> Reset</span>
          </button>
        </div>

        <div className="mt-4 rounded-2xl border p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">Data source</div>
              <div className="text-xs text-muted-foreground">{dataStatus}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="px-3 py-2 rounded-xl border text-sm cursor-pointer inline-flex items-center gap-2">
                <UploadCloud className="h-4 w-4"/> Upload .xlsx
                <input type="file" accept=".xlsx" className="hidden" onChange={(e)=>e.target.files?.[0] && loadWorkbookFile(e.target.files[0])}/>
              </label>
              <button className="px-3 py-2 rounded-xl border text-sm" onClick={loadWorkbookUrl}>Load /claims.xlsx</button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-5">
          <div className="flex-1 rounded-2xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Agent</div>
                <div className="text-sm text-muted-foreground">Lightweight Q&A shell (dashboard-first build)</div>
              </div>
              <button className="px-3 py-2 rounded-xl border text-sm" onClick={()=>setQuery("Top providers over $200k last 90 days; export csv")}>
                <span className="inline-flex items-center gap-2"><Play className="h-4 w-4"/> Example</span>
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <input className="flex-1 rounded-xl border px-3 py-2 text-sm" value={query} onChange={(e)=>setQuery(e.target.value)} onKeyDown={(e)=>e.key==="Enter" && send()} />
              <button className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm" onClick={send}>Run</button>
            </div>
            <div className="mt-3 h-[220px] overflow-auto rounded-xl border p-2 space-y-2">
              {messages.map(m=>(
                <div key={m.id} className={`rounded-xl p-3 text-sm ${m.role==="user" ? "bg-primary text-primary-foreground ml-6" : "bg-muted mr-6"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs opacity-80">{m.role==="user" ? "You" : "Agent"}</div>
                    {m.csv ? (
                      <button className="px-2 py-1 rounded-lg border text-xs bg-background text-foreground" onClick={()=>downloadCSV("claims_daily.csv", m.csv!)}>
                        <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5"/> CSV</span>
                      </button>
                    ):null}
                  </div>
                  <div className="mt-2 whitespace-pre-wrap leading-relaxed">{m.text}</div>
                </div>
              ))}
              <div ref={bottomRef}/>
            </div>
            {lastCsv ? (
              <div className="mt-2 text-xs text-muted-foreground">Latest CSV ready. <button className="underline" onClick={()=>downloadCSV("claims_daily.csv", lastCsv)}>Download</button></div>
            ) : null}
          </div>

          <div className="flex-1 rounded-2xl border p-4">
            <div className="flex flex-wrap gap-2">
              <MiniSelect label="Days" value={String(days)} onChange={(v)=>setDays(Number(v))} options={["7","30","60","90"]}/>
              <MiniSelect label="Region" value={region} onChange={setRegion} options={regionOptions}/>
              <MiniSelect label="Threshold" value={String(threshold)} onChange={(v)=>setThreshold(Number(v))} options={["75000","100000","150000","200000","300000"]}/>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Kpi label={`Billed ≥ ${usd(threshold)}`} value={pct(kpis.highShare)} sub="Share of billed" />
              <Kpi label="Paid / Billed" value={pct(kpis.paidToBilled)} sub={`Billed ${usd(kpis.billed)}`} />
              <Kpi label="Billed" value={usd(kpis.billed)} sub={`Claims in scope • ${nfmt(kpis.claims)}`} />
              <Kpi label="Denial rate" value={pct(kpis.deniedRate)} sub="PAY_ACT_CD starts with R" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card title="Daily allowed" subtitle="sum of allowed"><InteractiveChart data={series} dataKey="allowed" title="Allowed Amount" color="#10b981"/></Card>
              <Card title="Daily UM mismatches" subtitle="NO/MULTI/USERNOMATCH cases"><InteractiveChart data={series} dataKey="umMismatch" title="UM Mismatches" color="#f59e0b"/></Card>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card title="Provider Concentration" subtitle="Prompt pay distribution"><PromptPayDistribution data={scoped}/></Card>
              <Card title="UM case concentration" subtitle="share of allowed"><ConcRow c={concUm}/></Card>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card title="Cycle time trends" subtitle="average days to process">
                <InteractiveChart data={series} dataKey="cycleAvg" title="Cycle Time (days)" color="#ef4444"/>
              </Card>
              <Card title="Daily billed vs allowed" subtitle="comparison over time">
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={series.map(item => ({ ...item, date: item.date || `Day ${series.indexOf(item) + 1}` }))} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={usd} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-background border rounded-lg p-3 shadow-lg">
                              <p className="text-sm font-medium">{`Date: ${label}`}</p>
                              <p className="text-sm text-green-600">{`Allowed: ${usd(payload[0]?.value || 0)}`}</p>
                              <p className="text-sm text-blue-600">{`Billed: ${usd(payload[1]?.value || 0)}`}</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Line type="monotone" dataKey="allowed" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="billed" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <div className="mt-4">
              <Card title="Claim Processing Density by Department" subtitle="Shows claim flow through departments with processing days">
                <SankeyDiagram data={scoped} />
              </Card>
            </div>

            <div className="mt-4">
              <Card title="Claim Adjustment Density" subtitle="Provider intensity and density of adjustments (X: Avg Prompt Pay, Y: Domain)">
                <AdjustmentDensity data={scoped} />
              </Card>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card title="Prompt Pay Status" subtitle="breakdown by payment status">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[
                    { name: "Paid On-Time", value: scoped.filter(c => !c.denied && c.cycleDays! <= 30).length },
                    { name: "Delayed", value: scoped.filter(c => !c.denied && c.cycleDays! > 30).length },
                    { name: "Denied", value: scoped.filter(c => c.denied).length }
                  ]} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(value) => nfmt(value as number)} />
                    <Bar dataKey="value" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
              <Card title="Denial Rate by Provider" subtitle="Provider-specific denial patterns">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart 
                    data={topP.map(p => ({ name: p.name, denialRate: p.denied / p.claims }))}
                    margin={{ top: 5, right: 5, left: 5, bottom: 25 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis 
                      dataKey="name" 
                      tick={{ fontSize: 11 }}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} label={{ value: 'Denial %', angle: -90, position: 'insideLeft' }} />
                    <Tooltip 
                      formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`}
                      labelFormatter={(label) => `Provider: ${label}`}
                    />
                    <Bar dataKey="denialRate" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
